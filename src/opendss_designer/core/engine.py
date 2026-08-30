"""OpenDSSDirect session management: build, solve, extract results.

The OpenDSS engine is a process-wide singleton (one circuit at a time), so all
access is serialized behind a lock and the server must run single-worker.
Every solve is a full rebuild from the circuit JSON — no engine state persists
between requests, so the diagram can never drift from the model.
"""
from __future__ import annotations

import tempfile
import threading
from pathlib import Path
from typing import Any

import opendssdirect as dss

from .compiler import CompileResult, compile_circuit
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
        elements[full_name] = {
            "id": diagram_id,
            "currents": [round(a, 2) for a in t1_amps],
            "kw": round(kw, 2),
            "kvar": round(kvar, 2),
            "normAmps": norm_amps or None,
            "loadingPct": loading,
            "violations": violations,
        }
    return elements


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
    }
