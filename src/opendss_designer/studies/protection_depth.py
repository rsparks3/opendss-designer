"""Protection depth: faults anywhere on a line, the reach of every device,
fuse-saving and fuse-blowing coordination, and where a recloser would do
the most good.

* `fault_on_line` -- the line is split in the compiled model at a chosen
  fraction of its length and a `Fault` element placed at the split, so the
  current every upstream device sees for a fault part way along a line is
  read off a snapshot solve.
* `reach_study` -- for every fuse, recloser and relay: the buses of its
  protection section, the minimum fault current among them (line-to-line
  bolted and line-to-ground through a resistance, from Fault-element
  solves), and that against the device's pickups: the reach margin. With
  DER on the feeder the device sees less of a downstream fault, by the
  DER's own contribution; both figures are reported.
* `fuse_saving` -- every recloser-fuse pair: at the maximum fault at the
  fuse the recloser's fast curve must clear before the fuse melts (fuse
  saving); at the minimum fault at the end of the fuse's section the fuse
  must clear before the recloser's delayed curve (fuse blowing). Total
  clearing time is taken as the melting time times a factor when the fuse
  has no total-clear curve of its own (`clearcurve`).
* `recloser_placement` -- a recloser tried on each candidate line in turn,
  the reliability study rerun, candidates ranked by the fall in SAIDI.
"""
from __future__ import annotations

import math
import threading
from collections.abc import Callable
from typing import Any

import opendssdirect as dss

from ..core import engine, protection, reliability
from ..core.compiler import compile_circuit
from ..core.model import Circuit, CircuitEdge, CircuitNode, Issue, in_service
from ..core.validate import limit_issues
from .faults import FAULT_KINDS, _fault_amps, _place_fault, _remove_fault, der_contribution_amps
from .hosting_capacity import _protection_sections
from .scenarios import effective_circuit

Progress = Callable[[int, int, str | None], None]

# A fuse's total clearing time over its minimum melting time, when it has
# no total-clear curve of its own (a typical K-link ratio at the currents
# that matter).
CLEAR_OVER_MELT = 1.15
# Minimum fault current a device should see at the end of its zone, as a
# multiple of its pickup, to be sure of operating.
REACH_MARGIN = 1.5


def _build(circuit: Circuit):
    compiled = compile_circuit(circuit, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return compiled, issues, False
    engine._ensure_init()
    engine._write_aux_files(compiled)
    ok = engine._run_commands(compiled.commands, compiled.element_map, issues, compiled.optional_commands)
    return compiled, issues, ok


# --- a fault part way along a line --------------------------------------------------

def fault_on_line(circuit: Circuit, edge_id: str, fraction: float = 0.5, kind: str = "3ph",
                  r_ohm: float = 0.0) -> dict[str, Any]:
    if kind not in FAULT_KINDS:
        raise ValueError(f"Unknown fault kind {kind!r}.")
    circuit = effective_circuit(circuit)
    return _fault_on_line(circuit, edge_id, min(max(float(fraction), 0.01), 0.99), kind, float(r_ohm))


def _split_line(full: str, fraction: float) -> str | None:
    """Split `line.X` at `fraction` of its length: the line keeps the first
    part to a new bus, a second line carries the rest. Returns the new
    bus, or None when the element is not a line."""
    if dss.Circuit.SetActiveElement(full) < 0:
        return None
    buses = dss.CktElement.BusNames()
    if len(buses) < 2:
        return None
    name = full.split(".", 1)[1]
    props = {}
    for prop in ("length", "units", "phases", "linecode", "geometry", "r1", "x1", "r0", "x0", "c1", "c0", "normamps", "emergamps"):
        props[prop] = dss.Properties.Value(prop).strip()
    try:
        length = float(props["length"] or 1.0)
    except ValueError:
        length = 1.0
    mid = f"{name}_fault_pt"
    b1, b2 = str(buses[0]), str(buses[1])
    sfx = "." + b2.split(".", 1)[1] if "." in b2 else ""
    dss.Text.Command(f"edit line.{name} bus2={mid}{sfx} length={length * fraction:.6g}")
    impedance = (f"linecode={props['linecode']}" if props["linecode"] else
                 f"geometry={props['geometry']}" if props["geometry"] else
                 f"r1={props['r1']} x1={props['x1']} r0={props['r0']} x0={props['x0']}")
    rating = f" normamps={props['normamps']}" if props["normamps"] else ""
    dss.Text.Command(f"new line.{name}_b bus1={mid}{sfx} bus2={b2} phases={props['phases']} {impedance} "
                     f"length={length * (1 - fraction):.6g} units={props['units'] or 'km'}{rating}")
    return mid


@engine.on_engine_thread
def _fault_on_line(circuit: Circuit, edge_id: str, fraction: float, kind: str, r_ohm: float) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        full = next((f for f, ref in compiled.element_map.items() if ref == edge_id and f.startswith("line.")), None)
        if full is None:
            issues.append(Issue(severity="error", code="no-such-line", message="That element is not a line on the drawing."))
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        engine.quiet_for_fault_study(compiled.element_map, compiled.passthrough_names)
        dss.Text.Command("set mode=snapshot")
        dss.Text.Command("set controlmode=off")
        mid = _split_line(full, fraction)
        if mid is None or _place_fault(mid, kind, r_ohm) is None:
            issues.append(Issue(severity="error", code="fault-phases", message="The line has too few phases for that fault."))
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        dss.Solution.Solve()
        converged = bool(dss.Solution.Converged())
        amps = _fault_amps() if converged else []
        devices: dict[str, dict[str, Any]] = {}
        if converged:
            for f, ref in compiled.element_map.items():
                if not f.startswith(("line.", "transformer.")) or dss.Circuit.SetActiveElement(f) < 0 or not dss.CktElement.Enabled():
                    continue
                nph = dss.CktElement.NumPhases()
                mags = dss.CktElement.CurrentsMagAng()
                cur = [float(v) for v in mags[0:2 * nph:2]]
                devices[f] = {"id": ref, "amps": round(max(cur), 1) if cur else 0.0}
        _remove_fault()
    return {
        "converged": converged, "line": edge_id, "fraction": fraction, "kind": kind, "rOhm": r_ohm,
        "faultA": round(max(amps), 1) if amps else None, "faultPhaseA": [round(a, 1) for a in amps],
        "devices": devices, "issues": [i.model_dump() for i in issues],
    }


# --- reach -----------------------------------------------------------------------------

def _device_params(circuit: Circuit) -> list[dict[str, Any]]:
    out = []
    for n in circuit.nodes:
        if n.type in ("fuse", "recloser", "relay") and in_service(n.params) and n.params.get("closed", True):
            p = n.params
            def num(k: str, d: float | None = None) -> float | None:
                try:
                    return float(p.get(k)) if p.get(k) is not None else d
                except (TypeError, ValueError):
                    return d
            phase = num("ratedcurrent") if n.type == "fuse" else num("phasetrip", 100.0 if n.type == "recloser" else 200.0)
            ground = None if n.type == "fuse" else num("groundtrip")
            if n.type == "relay" and str(p.get("groundcurve") or "none") == "none":
                ground = None
            if n.type == "recloser" and str(p.get("groundfast") or "none") == "none" and str(p.get("grounddelayed") or "none") == "none":
                ground = None
            out.append({"id": n.id, "name": str(p.get("name") or n.id), "kind": n.type,
                        "phasePickupA": phase, "groundPickupA": ground})
    return out


def reach_study(circuit: Circuit, r_ohm: float = 20.0, der_type: str = "inverter",
                progress: Progress | None = None, cancel: threading.Event | None = None) -> dict[str, Any]:
    circuit = effective_circuit(circuit)
    return _reach_study(circuit, float(r_ohm), der_type, progress, cancel)


@engine.on_engine_thread
def _reach_study(circuit: Circuit, r_ohm: float, der_type: str, progress: Progress | None,
                 cancel: threading.Event | None) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues], "devices": []}
        sections = _protection_sections(circuit, compiled)
        devices = _device_params(circuit)
        conn = compiled.connectivity
        # Buses by section head; the head's own downstream bus starts it.
        by_head: dict[str, list[str]] = {}
        for bus, info in sections.items():
            by_head.setdefault(info["section"], []).append(bus)
        # DER in each section, as fault contribution at its bus.
        der_amps: dict[str, float] = {}
        if conn is not None:
            for n in circuit.nodes:
                if n.type in ("generator", "pvsystem", "storage") and in_service(n.params) and n.id in conn.node_buses:
                    p = n.params
                    try:
                        kva = float(p.get("kva") or p.get("kwrated") or p.get("kw") or p.get("pmpp") or 0)
                        kv = float(p.get("kv") or 12.47)
                        ph = int(float(p.get("phases") or 3))
                    except (TypeError, ValueError):
                        continue
                    sec = sections.get(conn.node_buses[n.id][0].lower(), {}).get("section", "")
                    der_amps[sec] = der_amps.get(sec, 0.0) + der_contribution_amps(kva, kv, ph, "synchronous" if n.type == "generator" else der_type)
        engine.quiet_for_fault_study(compiled.element_map, compiled.passthrough_names)
        dss.Text.Command("set mode=snapshot")
        dss.Text.Command("set controlmode=off")
        out = []
        total = sum(len(by_head.get(d["id"], [])) for d in devices)
        done = 0
        cancelled = False
        for d in devices:
            buses = by_head.get(d["id"], [])
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            worst: dict[str, Any] = {"bus": None, "minA": None, "kind": None, "lgA": None, "llA": None}
            for b in buses:
                for kind, r, key in (("ll", 0.0, "llA"), ("lg", r_ohm, "lgA")):
                    if _place_fault(b, kind, r) is None:
                        continue
                    dss.Solution.Solve()
                    if dss.Solution.Converged():
                        amps = _fault_amps()
                        a = max(amps) if amps else None
                        if a is not None and (worst["minA"] is None or a < worst["minA"]):
                            worst.update({"bus": b, "minA": round(a, 1), "kind": kind})
                        if a is not None and (worst[key] is None or a < worst[key]):
                            worst[key] = round(a, 1)
                    _remove_fault()
                done += 1
                if progress is not None and (done % max(1, total // 50) == 0 or done == total):
                    progress(done, total, d["name"])
            infeed = sum(v for s, v in der_amps.items() if s == d["id"]) or 0.0
            min_a = worst["minA"]
            seen = max(0.0, (min_a or 0.0) - infeed) if min_a is not None else None
            pickup = d["phasePickupA"] or 0.0
            ratio = (seen / pickup) if seen is not None and pickup > 0 else None
            ground_ratio = (worst["lgA"] / d["groundPickupA"]) if worst["lgA"] and d["groundPickupA"] else None
            out.append({
                **d, "sectionBuses": len(buses), "endBus": worst["bus"], "minFaultKind": worst["kind"],
                "minFaultA": min_a, "minLLA": worst["llA"], "minLGrA": worst["lgA"],
                "derInfeedA": round(infeed, 1), "seenByDeviceA": round(seen, 1) if seen is not None else None,
                "reachRatio": round(ratio, 2) if ratio is not None else None,
                "groundReachRatio": round(ground_ratio, 2) if ground_ratio is not None else None,
                "ok": (ratio is None or ratio >= REACH_MARGIN) and (ground_ratio is None or ground_ratio >= REACH_MARGIN),
            })
    out.sort(key=lambda d: (d["reachRatio"] if d["reachRatio"] is not None else math.inf))
    return {"converged": True, "cancelled": cancelled, "rOhm": r_ohm, "margin": REACH_MARGIN,
            "devices": out, "loadLevel": circuit.level.model_dump(), "scenario": circuit.activeScenario,
            "issues": [i.model_dump() for i in issues]}


# --- fuse saving ---------------------------------------------------------------------

def fuse_saving(circuit: Circuit, r_ohm: float = 20.0) -> dict[str, Any]:
    circuit = effective_circuit(circuit)
    return _fuse_saving(circuit, float(r_ohm))


@engine.on_engine_thread
def _fuse_saving(circuit: Circuit, r_ohm: float) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues], "pairs": []}
        devices = protection._read_devices(compiled.element_map)
        by_id = {d["nodeId"]: d for d in devices if d.get("nodeId")}
        sections = _protection_sections(circuit, compiled)
        chains = protection._upstream_chain(circuit, devices)
        # Fault currents: maximum from the fault study, minimum from Fault solves.
        engine.quiet_for_fault_study(compiled.element_map, compiled.passthrough_names)
        dss.Text.Command("set mode=faultstudy")
        dss.Text.Command("solve")
        max_at: dict[str, float] = {}
        for b in [x.lower() for x in dss.Circuit.AllBusNames()]:
            if3, _ = protection._fault_currents(b)
            if if3:
                max_at[b] = if3
        dss.Text.Command("set mode=snapshot")
        dss.Text.Command("set controlmode=off")
        pairs = []
        fuses = [d for d in devices if d["kind"] == "fuse"]
        for fuse in fuses:
            up = [by_id[u] for u in chains.get(fuse["nodeId"], []) if u in by_id]
            recloser = next((u for u in up if u["kind"] == "recloser"), None)
            if recloser is None or not fuse["bus"]:
                continue
            fuse_bus = fuse["bus"]
            imax = max_at.get(fuse_bus)
            # Minimum fault at the end of the fuse's section.
            zone = [b for b, info in sections.items() if info["section"] == fuse["nodeId"]]
            imin = None
            for b in zone or [fuse_bus]:
                for kind, r in (("ll", 0.0), ("lg", r_ohm)):
                    if _place_fault(b, kind, r) is None:
                        continue
                    dss.Solution.Solve()
                    if dss.Solution.Converged():
                        amps = _fault_amps()
                        if amps:
                            a = max(amps)
                            imin = a if imin is None else min(imin, a)
                    _remove_fault()
            fast = [t for t in recloser["traces"] if "fast" in t["label"] and t.get("fault", "phase") == "phase"]
            delayed = [t for t in recloser["traces"] if "delayed" in t["label"] and t.get("fault", "phase") == "phase"]
            melt = fuse["traces"][0] if fuse["traces"] else None
            clear_curve = None
            node = next((n for n in circuit.nodes if n.id == fuse["nodeId"]), None)
            if node is not None and node.params.get("clearcurve"):
                clear_curve = protection._curve_trace(f"{fuse['name']} clear", str(node.params["clearcurve"]).lower(),
                                                      float(node.params.get("ratedcurrent") or 65), float(node.params.get("delay") or 0))

            def t_of(traces: list[dict[str, Any]], amps: float | None) -> float | None:
                if amps is None:
                    return None
                times = [protection._operate_seconds(t, amps) for t in traces]
                times = [t for t in times if t is not None]
                return min(times) if times else None

            melt_max = t_of([melt], imax) if melt else None
            fast_max = t_of(fast, imax)
            clear_min = (t_of([clear_curve], imin) if clear_curve else
                         (t_of([melt], imin) * CLEAR_OVER_MELT if melt and t_of([melt], imin) is not None else None))
            delayed_min = t_of(delayed, imin)
            saving_ok = fast_max is not None and melt_max is not None and fast_max < melt_max
            blowing_ok = clear_min is not None and delayed_min is not None and clear_min < delayed_min
            pairs.append({
                "fuse": fuse["name"], "fuseId": fuse["nodeId"], "recloser": recloser["name"], "recloserId": recloser["nodeId"],
                "maxFaultA": round(imax, 1) if imax else None, "minFaultA": round(imin, 1) if imin else None,
                "recloserFastS": round(fast_max, 4) if fast_max is not None else None,
                "fuseMeltS": round(melt_max, 4) if melt_max is not None else None,
                "fuseClearS": round(clear_min, 4) if clear_min is not None else None,
                "recloserDelayedS": round(delayed_min, 4) if delayed_min is not None else None,
                "fuseSaving": saving_ok, "fuseBlowing": blowing_ok,
                "clearFrom": "clearcurve" if clear_curve else f"melt x {CLEAR_OVER_MELT}",
                "note": ("fast curve clears before the fuse melts at the maximum fault, and the fuse clears before the "
                         "delayed curve at the minimum: the scheme works both ways"
                         if saving_ok and blowing_ok else
                         "the recloser's fast curve is slower than the fuse at the maximum fault: the fuse blows first"
                         if not saving_ok else
                         "at the minimum fault the recloser's delayed curve beats the fuse: the recloser locks out for a fuse-zone fault"),
            })
    return {"converged": True, "rOhm": r_ohm, "clearOverMelt": CLEAR_OVER_MELT, "pairs": pairs,
            "loadLevel": circuit.level.model_dump(), "scenario": circuit.activeScenario,
            "issues": [i.model_dump() for i in issues]}


# --- recloser placement -----------------------------------------------------------------

def recloser_placement(circuit: Circuit, max_candidates: int = 40,
                       progress: Progress | None = None, cancel: threading.Event | None = None) -> dict[str, Any]:
    """A recloser tried mid-way on each candidate line (lines not already
    switched, longest first), the reliability study rerun each time."""
    circuit = effective_circuit(circuit)
    base = reliability.reliability_study(circuit)
    if not base.get("converged") or base.get("saidi") is None:
        return {"converged": False, "issues": base.get("issues", []), "candidates": []}
    lines = [e for e in circuit.edges if e.type == "line" and in_service(e.params) and not e.params.get("reactor")]

    def km(e: CircuitEdge) -> float:
        try:
            return float(e.params.get("length") or 0) * {"km": 1, "m": 0.001, "mi": 1.609, "kft": 0.3048, "ft": 0.0003048}.get(str(e.params.get("units", "km")), 1)
        except (TypeError, ValueError):
            return 0.0
    lines.sort(key=lambda e: -km(e))
    lines = lines[: max(1, int(max_candidates))]
    rows = []
    cancelled = False
    for i, e in enumerate(lines):
        if cancel is not None and cancel.is_set():
            cancelled = True
            break
        trial = _with_recloser(circuit, e)
        r = reliability.reliability_study(trial)
        if r.get("converged") and r.get("saidi") is not None:
            rows.append({
                "line": e.id, "name": str(e.params.get("name") or e.id), "lengthKm": round(km(e), 3),
                "saifi": r["saifi"], "saidi": r["saidi"],
                "saifiChange": round(r["saifi"] - base["saifi"], 4) if r["saifi"] is not None and base["saifi"] is not None else None,
                "saidiChange": round(r["saidi"] - base["saidi"], 4),
                "custHoursSaved": round(base["custHours"] - r["custHours"], 2),
            })
        if progress is not None:
            progress(i + 1, len(lines), str(e.params.get("name") or e.id))
    rows.sort(key=lambda r: r["saidiChange"])
    return {"converged": True, "cancelled": cancelled,
            "base": {"saifi": base["saifi"], "saidi": base["saidi"], "caidi": base["caidi"], "custHours": base["custHours"]},
            "candidates": rows, "issues": base.get("issues", [])}


def _with_recloser(circuit: Circuit, e: CircuitEdge) -> Circuit:
    """The circuit with `e` split in two around a new recloser."""
    rid = f"{e.id}_rec"
    half = {**e.params}
    try:
        half["length"] = float(e.params.get("length") or 1.0) / 2
    except (TypeError, ValueError):
        half["length"] = 0.5
    first = e.model_copy(update={"target": rid, "targetHandle": "t1", "params": {**half, "name": f"{e.params.get('name') or e.id}_a"}})
    second = e.model_copy(update={"id": f"{e.id}_b", "source": rid, "sourceHandle": "t2",
                                  "params": {**half, "name": f"{e.params.get('name') or e.id}_b"}, "waypoints": None, "geometry": None})
    phases = e.params.get("phases", 3)
    rec = CircuitNode(id=rid, type="recloser", position=None,
                      params={"name": f"REC_{e.params.get('name') or e.id}", "closed": True, "phases": phases,
                              "phasetrip": 100, "groundtrip": 50, "phasefast": "a", "phasedelayed": "d",
                              **({"phasing": e.params["phasing"]} if e.params.get("phasing") else {})})
    edges = [x for x in circuit.edges if x.id != e.id] + [first, second]
    return circuit.model_copy(update={"nodes": [*circuit.nodes, rec], "edges": edges})
