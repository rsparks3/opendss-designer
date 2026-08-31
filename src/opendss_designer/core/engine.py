"""OpenDSSDirect session management: build, solve, extract results.

The OpenDSS engine is a process-wide singleton (one circuit at a time), so all
access is serialized behind a lock and the server must run single-worker.
Every solve is a full rebuild from the circuit JSON — no engine state persists
between requests, so the diagram can never drift from the model.
"""
from __future__ import annotations

import functools
import gc
import heapq
import math
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, TypeVar

import opendssdirect as dss

from .compiler import CompileResult, compile_circuit
from .connectivity import ConnectivityResult
from .model import Circuit, Issue

_lock = threading.Lock()
_initialized = False

# The DSS C library (Free Pascal) segfaults on Linux when entered from
# freshly created threads once the engine has real state (CI died with exit
# 139 on the first Text.Command issued from the SSE route's worker thread).
# Every entry point therefore runs on this one long-lived engine thread.
_dss_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dss-engine")

_T = TypeVar("_T")


def on_engine_thread(fn: Callable[..., _T]) -> Callable[..., _T]:
    """Run the wrapped function on the dedicated DSS engine thread and wait
    for its result. Decorated functions must not call each other (single
    worker — a nested submit would deadlock)."""
    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> _T:
        return _dss_executor.submit(fn, *args, **kwargs).result()
    return wrapper


@contextmanager
def dss_guard() -> Iterator[None]:
    """Hold the engine lock with garbage collection suspended.

    Defense in depth around the non-thread-safe DSS C library (the primary
    protection is `on_engine_thread`, which pins every native call to one
    long-lived thread). Suspending GC ensures no cffi finalizer can re-enter
    the library from another thread mid-call (cffi releases the GIL during
    native calls). Collection resumes as soon as the engine is released.
    """
    with _lock:
        was_enabled = gc.isenabled()
        gc.disable()
        try:
            yield
        finally:
            if was_enabled:
                gc.enable()

# OpenDSS writes side files (error logs, exports) to its data path;
# keep them out of the user's CWD.
WORKDIR = Path(tempfile.gettempdir()) / "opendss_designer"
# Large loadshapes are fed to OpenDSS as CSV files from here (giant inline
# mult=(...) commands corrupt the DSS Text parser's heap on Linux).
SHAPE_DIR = WORKDIR / "shapes"


def _write_aux_files(compiled: CompileResult) -> None:
    """Materialize compiler side files (large loadshape CSVs) before the
    commands that reference them run. Called under dss_guard."""
    if compiled.aux_files:
        SHAPE_DIR.mkdir(parents=True, exist_ok=True)
        for name, content in compiled.aux_files.items():
            (SHAPE_DIR / name).write_text(content, encoding="utf-8")


def _ensure_init() -> None:
    global _initialized
    if not _initialized:
        WORKDIR.mkdir(exist_ok=True)
        dss.Basic.DataPath(str(WORKDIR))
        dss.Basic.AllowForms(False)
        _initialized = True


def _element_for_command(cmd: str, element_map: dict[str, str]) -> str | None:
    parts = cmd.split()
    if len(parts) >= 2 and parts[0].lower() in ("new", "edit", "open", "close"):
        return element_map.get(parts[1].lower())
    return None


def _run_commands(commands: list[str], element_map: dict[str, str],
                  issues: list[Issue]) -> bool:
    ok = True
    for cmd in commands:
        try:
            dss.Text.Command(cmd)
            result = dss.Text.Result()
            if result and "error" in result.lower():
                raise RuntimeError(result)
        except Exception as exc:  # engine raises DSSException on bad commands
            ok = False
            ref = _element_for_command(cmd, element_map)
            issues.append(Issue(
                severity="error", code="dss-error",
                message=f"OpenDSS rejected: {cmd!r} — {exc}",
                nodeId=ref, edgeId=ref))
    return ok


def _extract_buses() -> dict[str, Any]:
    buses: dict[str, Any] = {}
    for name in dss.Circuit.AllBusNames():
        dss.Circuit.SetActiveBus(name)
        mag_ang = dss.Bus.puVmagAngle()
        vmags = mag_ang[0::2]
        buses[name] = {
            "vmagPu": [round(v, 5) for v in vmags],
            "vangDeg": [round(a, 2) for a in mag_ang[1::2]],
            "vminPu": round(min(vmags), 5) if vmags else None,
            "vmaxPu": round(max(vmags), 5) if vmags else None,
            "kvBase": round(dss.Bus.kVBase(), 5),  # line-to-neutral kV
            "nodes": dss.Bus.Nodes(),
        }
    return buses


def _extract_elements(element_map: dict[str, str]) -> dict[str, Any]:
    elements: dict[str, Any] = {}
    for full_name, diagram_id in element_map.items():
        idx = dss.Circuit.SetActiveElement(full_name)
        if idx < 0 or dss.CktElement.Name().lower() != full_name:
            continue
        nphases = dss.CktElement.NumPhases()
        currents = dss.CktElement.CurrentsMagAng()
        powers = dss.CktElement.Powers()
        ncond = dss.CktElement.NumConductors()
        # Terminal 1 quantities.
        t1_amps = currents[0 : 2 * nphases : 2]
        kw = sum(powers[0 : 2 * ncond : 2])
        kvar = sum(powers[1 : 2 * ncond : 2])
        norm_amps = dss.CktElement.NormalAmps()
        loading = None
        violations: list[str] = []
        if norm_amps and norm_amps > 0 and t1_amps:
            loading = round(100.0 * max(t1_amps) / norm_amps, 1)
            if loading >= 100.0:
                violations.append("overload")
        # Losses are meaningful only for series elements — for shunt elements
        # (loads, generators, capacitors, sources) CktElement.Losses() reports
        # their power injection, not network loss.
        loss_w = (dss.CktElement.Losses()
                  if full_name.startswith(("line.", "transformer.")) else None)
        elements[full_name] = {
            "id": diagram_id,
            "currents": [round(a, 2) for a in t1_amps],
            "kw": round(kw, 2),
            "kvar": round(kvar, 2),
            "normAmps": norm_amps or None,
            "loadingPct": loading,
            "violations": violations,
            "lossKw": round(loss_w[0] / 1000.0, 4) if loss_w is not None else None,
            "lossKvar": round(loss_w[1] / 1000.0, 4) if loss_w is not None else None,
        }
    return elements


_KM_PER_UNIT = {"km": 1.0, "m": 0.001, "mi": 1.609344, "kft": 0.3048,
                "ft": 0.0003048, "in": 0.0000254, "cm": 0.00001, "none": 0.0}


def _bus_distances(circuit: Circuit, conn: ConnectivityResult) -> dict[str, float]:
    """Shortest electrical distance (km) from any source to each bus, over
    line edges (their length) and closed 2-terminal devices (zero length).
    Feeds the voltage-profile plot."""
    adjacency: dict[str, list[tuple[str, float]]] = {}

    def link(a: str, b: str, w: float) -> None:
        adjacency.setdefault(a, []).append((b, w))
        adjacency.setdefault(b, []).append((a, w))

    edge_by_id = {e.id: e for e in circuit.edges}
    for eid, (b1, b2) in conn.line_buses.items():
        p = edge_by_id[eid].params if eid in edge_by_id else {}
        try:
            length = float(p.get("length") or 0.0)
        except (TypeError, ValueError):
            length = 0.0
        km = max(length, 0.0) * _KM_PER_UNIT.get(str(p.get("units", "km")), 1.0)
        link(b1, b2, km)
    for n in circuit.nodes:
        if n.type in ("transformer", "breaker"):
            if n.type == "breaker" and not n.params.get("closed", True):
                continue
            buses = conn.node_buses.get(n.id, [])
            for b in buses[1:]:
                link(buses[0], b, 0.0)

    dist: dict[str, float] = {}
    pq = [(0.0, conn.node_buses[n.id][0]) for n in circuit.nodes
          if n.type == "vsource" and n.id in conn.node_buses]
    heapq.heapify(pq)
    while pq:
        d, b = heapq.heappop(pq)
        if b in dist:
            continue
        dist[b] = d
        for nb, w in adjacency.get(b, ()):
            if nb not in dist:
                heapq.heappush(pq, (d + w, nb))
    return {b: round(d, 4) for b, d in dist.items()}


@on_engine_thread
def solve(circuit: Circuit) -> dict[str, Any]:
    compiled: CompileResult = compile_circuit(circuit, shape_dir=SHAPE_DIR)
    issues = list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "issues": [i.model_dump() for i in issues],
                "buses": {}, "elements": {}, "commands": compiled.commands}

    with dss_guard():
        _ensure_init()
        _write_aux_files(compiled)
        built = _run_commands(compiled.commands, compiled.element_map, issues)
        converged = False
        iterations = 0
        buses: dict[str, Any] = {}
        elements: dict[str, Any] = {}
        losses = None
        if built:
            try:
                dss.Text.Command("set mode=snapshot")
                dss.Text.Command("solve")
                converged = bool(dss.Solution.Converged())
                iterations = dss.Solution.Iterations()
            except Exception as exc:
                issues.append(Issue(severity="error", code="solve-failed",
                                    message=f"Solve failed: {exc}"))
            if converged:
                buses = _extract_buses()
                elements = _extract_elements(compiled.element_map)
                lw = dss.Circuit.Losses()
                losses = {"kw": round(lw[0] / 1000.0, 3), "kvar": round(lw[1] / 1000.0, 3)}
                for b in buses.values():
                    if b["vminPu"] is not None and b["vminPu"] < 0.95:
                        b["violation"] = "undervoltage"
                    elif b["vmaxPu"] is not None and b["vmaxPu"] > 1.05:
                        b["violation"] = "overvoltage"
            else:
                issues.append(Issue(
                    severity="error", code="not-converged",
                    message=f"Power flow did not converge after {iterations} iterations. "
                            "Check element parameters (impedances, kV ratings, load sizes)."))

    conn = compiled.connectivity
    return {
        "converged": converged,
        "iterations": iterations,
        "buses": buses,
        "elements": elements,
        "losses": losses,
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": conn.node_buses if conn else {},
        "lineBuses": {k: list(v) for k, v in conn.line_buses.items()} if conn else {},
        "busNames": conn.bus_names if conn else {},
        "busDistances": _bus_distances(circuit, conn) if conn else {},
    }


# Above this many steps the response is bucketed to a min/max envelope so a
# yearly run doesn't ship (or plot) tens of thousands of raw samples.
_DOWNSAMPLE_ABOVE = 2000
_TARGET_BUCKETS = 720


def _downsample_minmax(series: list[float | None], k: int) -> list[float | None]:
    """[min, max] per bucket of k samples (envelope-preserving, plottable as a
    plain polyline). None samples (e.g. loading with no rating) stay None."""
    out: list[float | None] = []
    for i in range(0, len(series), k):
        bucket = [v for v in series[i:i + k] if v is not None]
        if bucket:
            out.append(min(bucket))
            out.append(max(bucket))
        else:
            out.extend((None, None))
    return out


@on_engine_thread
def solve_timeseries(circuit: Circuit, mode: str = "daily", step_min: int = 60,
                     progress_cb: Callable[[int, int], None] | None = None,
                     cancel: threading.Event | None = None) -> dict[str, Any]:
    """Step-driven daily/yearly simulation with automatic recording: per-step
    bus voltage envelopes, per-element P/Q/current/loading, system totals and
    integrated energy. Driving the solution one step at a time (instead of one
    blocking `solve`) is what makes progress reporting and cancel possible."""
    compiled: CompileResult = compile_circuit(circuit, shape_dir=SHAPE_DIR)
    issues = list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "issues": [i.model_dump() for i in issues],
                "buses": {}, "elements": {}, "totals": {}, "summary": None}

    hours_per_pass = 24 if mode == "daily" else 8760
    total = hours_per_pass * (60 // step_min)
    dt_h = step_min / 60.0

    with dss_guard():
        _ensure_init()
        _write_aux_files(compiled)
        built = _run_commands(compiled.commands, compiled.element_map, issues)
        if not built:
            return {"converged": False, "issues": [i.model_dump() for i in issues],
                    "buses": {}, "elements": {}, "totals": {}, "summary": None}

        dss.Text.Command(f"set mode={mode}")
        dss.Text.Command(f"set stepsize={step_min}m")
        dss.Text.Command("set number=1")
        dss.Text.Command("set hour=0 sec=0")

        # One AllBusMagPu() call per step covers every bus; precompute each
        # bus's slice into the flat all-nodes array.
        node_names = [n.lower() for n in dss.Circuit.AllNodeNames()]
        bus_slices: dict[str, list[int]] = {}
        for idx, node in enumerate(node_names):
            bus_slices.setdefault(node.split(".", 1)[0], []).append(idx)
        bus_kv_base: dict[str, float] = {}
        for b in bus_slices:
            dss.Circuit.SetActiveBus(b)
            bus_kv_base[b] = round(dss.Bus.kVBase(), 5)  # line-to-neutral

        # Static per-element facts, captured once.
        elem_static: list[tuple[str, str, int, int, float | None]] = []
        for full_name, diagram_id in compiled.element_map.items():
            idx = dss.Circuit.SetActiveElement(full_name)
            if idx < 0 or dss.CktElement.Name().lower() != full_name:
                continue
            elem_static.append((full_name, diagram_id, dss.CktElement.NumPhases(),
                                dss.CktElement.NumConductors(),
                                dss.CktElement.NormalAmps() or None))

        times: list[float] = []
        total_kw: list[float] = []
        loss_kw: list[float] = []
        bus_vmin: dict[str, list[float]] = {b: [] for b in bus_slices}
        bus_vmax: dict[str, list[float]] = {b: [] for b in bus_slices}
        elem_series: dict[str, dict[str, list]] = {
            fn: {"kw": [], "kvar": [], "ampsMax": [], "loadingPct": []}
            for fn, *_ in elem_static}
        non_converged: list[int] = []
        energy_kwh = 0.0
        losses_kwh = 0.0
        peak_kw = 0.0
        peak_hour = 0.0
        vmin_rec = {"bus": None, "hour": 0.0, "value": math.inf}
        vmax_rec = {"bus": None, "hour": 0.0, "value": -math.inf}

        report_every = max(1, total // 200)
        steps_done = 0
        cancelled = False
        try:
            for step in range(total):
                if cancel is not None and cancel.is_set():
                    cancelled = True
                    break
                dss.Solution.Solve()
                hour = dss.Solution.DblHour()
                times.append(round(hour, 4))
                if not dss.Solution.Converged():
                    if len(non_converged) < 50:
                        non_converged.append(step)
                    # Record placeholders so every series stays aligned.
                    total_kw.append(0.0)
                    loss_kw.append(0.0)
                    for b in bus_slices:
                        bus_vmin[b].append(0.0)
                        bus_vmax[b].append(0.0)
                    for fn, *_ in elem_static:
                        s = elem_series[fn]
                        s["kw"].append(0.0)
                        s["kvar"].append(0.0)
                        s["ampsMax"].append(0.0)
                        s["loadingPct"].append(None)
                    steps_done += 1
                    continue

                p_total = dss.Circuit.TotalPower()  # source injection, negative
                kw_now = -p_total[0]
                total_kw.append(round(kw_now, 2))
                lw = dss.Circuit.Losses()
                loss_kw.append(round(lw[0] / 1000.0, 3))
                energy_kwh += kw_now * dt_h
                losses_kwh += lw[0] / 1000.0 * dt_h
                if kw_now > peak_kw:
                    peak_kw = kw_now
                    peak_hour = hour

                mags = dss.Circuit.AllBusMagPu()
                for b, idxs in bus_slices.items():
                    vals = [mags[i] for i in idxs]
                    lo, hi = min(vals), max(vals)
                    bus_vmin[b].append(round(lo, 5))
                    bus_vmax[b].append(round(hi, 5))
                    if 0.05 < lo < vmin_rec["value"]:  # ignore de-energized buses
                        vmin_rec = {"bus": b, "hour": hour, "value": round(lo, 5)}
                    if hi > vmax_rec["value"]:
                        vmax_rec = {"bus": b, "hour": hour, "value": round(hi, 5)}

                for fn, _id, nphases, ncond, norm_amps in elem_static:
                    dss.Circuit.SetActiveElement(fn)
                    powers = dss.CktElement.Powers()
                    currents = dss.CktElement.CurrentsMagAng()
                    t1_amps = currents[0:2 * nphases:2]
                    amps = max(t1_amps) if t1_amps else 0.0
                    s = elem_series[fn]
                    s["kw"].append(round(sum(powers[0:2 * ncond:2]), 2))
                    s["kvar"].append(round(sum(powers[1:2 * ncond:2]), 2))
                    s["ampsMax"].append(round(amps, 2))
                    s["loadingPct"].append(
                        round(100.0 * amps / norm_amps, 1) if norm_amps else None)

                steps_done += 1
                if progress_cb and (step + 1) % report_every == 0:
                    progress_cb(step + 1, total)
        except Exception as exc:
            issues.append(Issue(severity="error", code="solve-failed",
                                message=f"Time series failed at step {steps_done}: {exc}"))
            return {"converged": False, "issues": [i.model_dump() for i in issues],
                    "buses": {}, "elements": {}, "totals": {}, "summary": None}

    downsampled = steps_done > _DOWNSAMPLE_ABOVE
    if downsampled:
        k = math.ceil(steps_done / _TARGET_BUCKETS)
        ds = lambda s: _downsample_minmax(s, k)  # noqa: E731
        time_pairs: list[float] = []
        for i in range(0, steps_done, k):
            time_pairs.extend((times[i], times[min(i + k, steps_done) - 1]))
        times = time_pairs
        total_kw = ds(total_kw)
        loss_kw = ds(loss_kw)
        bus_vmin = {b: ds(v) for b, v in bus_vmin.items()}
        bus_vmax = {b: ds(v) for b, v in bus_vmax.items()}
        for s in elem_series.values():
            for key in s:
                s[key] = ds(s[key])

    conn = compiled.connectivity
    return {
        "converged": not non_converged and not cancelled and steps_done > 0,
        "cancelled": cancelled,
        "mode": mode,
        "stepMin": step_min,
        "steps": steps_done,
        "downsampled": downsampled,
        "time": times,
        "totals": {"kw": total_kw, "lossKw": loss_kw},
        "buses": {b: {"vmin": bus_vmin[b], "vmax": bus_vmax[b],
                      "kvBase": bus_kv_base.get(b, 0.0)} for b in bus_slices},
        "elements": {fn: {"id": _id, **elem_series[fn]}
                     for fn, _id, *_ in elem_static},
        "summary": {
            "energyKwh": round(energy_kwh, 1),
            "lossesKwh": round(losses_kwh, 1),
            "peakKw": round(peak_kw, 1),
            "peakHour": round(peak_hour, 2),
            "minVpu": vmin_rec if vmin_rec["bus"] else None,
            "maxVpu": vmax_rec if vmax_rec["bus"] else None,
        },
        "nonConvergedSteps": non_converged,
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": conn.node_buses if conn else {},
        "lineBuses": {k: list(v) for k, v in conn.line_buses.items()} if conn else {},
        "busNames": conn.bus_names if conn else {},
    }


@on_engine_thread
def fault_study(circuit: Circuit) -> dict[str, Any]:
    """Short-circuit study (`solve mode=faultstudy`): per-bus Thevenin
    impedances and prospective 3-phase / single-phase fault currents."""
    compiled: CompileResult = compile_circuit(circuit, shape_dir=SHAPE_DIR)
    issues = list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "buses": {}, "nodeBuses": {},
                "issues": [i.model_dump() for i in issues]}

    buses: dict[str, Any] = {}
    converged = False
    with dss_guard():
        _ensure_init()
        _write_aux_files(compiled)
        built = _run_commands(compiled.commands, compiled.element_map, issues)
        if built:
            try:
                # Storage elements crash faultstudy mode with an access
                # violation (DSS-Extensions 0.9.4 bug). Inverter-based storage
                # contributes negligible fault current, so drop them here.
                for full_name in compiled.element_map:
                    if full_name.startswith("storage."):
                        dss.Text.Command(f"disable {full_name}")
                dss.Text.Command("set mode=faultstudy")
                dss.Text.Command("solve")
                converged = True
            except Exception as exc:
                issues.append(Issue(severity="error", code="solve-failed",
                                    message=f"Fault study failed: {exc}"))
        if converged:
            for name in dss.Circuit.AllBusNames():
                dss.Circuit.SetActiveBus(name)
                kv_ln = dss.Bus.kVBase()  # line-to-neutral
                z1_raw = dss.Bus.Zsc1()
                z0_raw = dss.Bus.Zsc0()
                z1 = complex(float(z1_raw[0]), float(z1_raw[1]))
                z0 = complex(float(z0_raw[0]), float(z0_raw[1]))
                v_ln = kv_ln * 1000.0
                if3 = v_ln / abs(z1) if abs(z1) > 1e-9 else None
                loop = 2 * z1 + z0
                if1 = 3 * v_ln / abs(loop) if abs(loop) > 1e-9 else None
                buses[name] = {
                    "kvBase": round(kv_ln, 5),
                    "if3phA": round(if3, 1) if if3 else None,
                    "if1phA": round(if1, 1) if if1 else None,
                    "scMva3": round(3 * v_ln * if3 / 1e6, 2) if if3 else None,
                    "zsc1": {"r": round(z1.real, 5), "x": round(z1.imag, 5)},
                    "zsc0": {"r": round(z0.real, 5), "x": round(z0.imag, 5)},
                }

    conn = compiled.connectivity
    return {
        "converged": converged and bool(buses),
        "buses": buses,
        "nodeBuses": conn.node_buses if conn else {},
        "issues": [i.model_dump() for i in issues],
    }
