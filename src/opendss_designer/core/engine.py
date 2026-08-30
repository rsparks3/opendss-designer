"""OpenDSSDirect session management: build, solve, extract results.

The OpenDSS engine is a process-wide singleton (one circuit at a time), so all
access is serialized behind a lock and the server must run single-worker.
Every solve is a full rebuild from the circuit JSON — no engine state persists
between requests, so the diagram can never drift from the model.
"""
from __future__ import annotations

import heapq
import tempfile
import threading
from pathlib import Path
from typing import Any

import opendssdirect as dss

from .compiler import CompileResult, compile_circuit
from .connectivity import ConnectivityResult
from .model import Circuit, Issue

_lock = threading.Lock()
_initialized = False

# OpenDSS writes side files (error logs, exports) to its data path;
# keep them out of the user's CWD.
WORKDIR = Path(tempfile.gettempdir()) / "opendss_designer"


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


def solve(circuit: Circuit) -> dict[str, Any]:
    compiled: CompileResult = compile_circuit(circuit)
    issues = list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "issues": [i.model_dump() for i in issues],
                "buses": {}, "elements": {}, "commands": compiled.commands}

    with _lock:
        _ensure_init()
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


def fault_study(circuit: Circuit) -> dict[str, Any]:
    """Short-circuit study (`solve mode=faultstudy`): per-bus Thevenin
    impedances and prospective 3-phase / single-phase fault currents."""
    compiled: CompileResult = compile_circuit(circuit)
    issues = list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "buses": {}, "nodeBuses": {},
                "issues": [i.model_dump() for i in issues]}

    buses: dict[str, Any] = {}
    converged = False
    with _lock:
        _ensure_init()
        built = _run_commands(compiled.commands, compiled.element_map, issues)
        if built:
            try:
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
