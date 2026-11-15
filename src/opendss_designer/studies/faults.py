"""Faults with a `Fault` element in a snapshot solve.

`mode=faultstudy` gives the Thevenin impedance at every bus in one solve,
and from it the bolted three-phase and single-line-to-ground currents.
What it cannot give: a line-to-line or double-line-to-ground fault, a
fault through resistance, the current every device carries while the
fault is on, or the voltages the rest of the feeder sees. For those the
engine's `Fault` object is placed at the bus and the circuit solved as a
snapshot; this module does that for one point, and for every bus as a
sweep that adds minimum fault currents (the coordination case) to the
maximum ones the fault study reports.

The DER contribution is reported analytically (the unit's rated current
times 1.2 for an inverter, 5 for a synchronous machine), as the hosting
capacity study and the interconnection screens do, rather than from the
power-flow model of a generator at a collapsed voltage, which OpenDSS does
not intend as a fault model.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Callable
from typing import Any

import opendssdirect as dss

from ..core import engine
from ..core.compiler import compile_circuit
from ..core.model import Circuit, Issue
from ..core.validate import limit_issues
from .scenarios import effective_circuit

Progress = Callable[[int, int, str | None], None]

# Fault kinds: the phase nodes of the Fault element and how many phases it
# spans. "lg" is A to ground, "ll" B to C, "llg" B and C to ground.
FAULT_KINDS: dict[str, dict[str, Any]] = {
    "3ph": {"label": "three-phase", "phases": 3, "bus1": ".1.2.3", "bus2": ".0.0.0"},
    "lg": {"label": "line-to-ground", "phases": 1, "bus1": ".1", "bus2": ".0"},
    "ll": {"label": "line-to-line", "phases": 1, "bus1": ".2", "bus2": ".3"},
    "llg": {"label": "double-line-to-ground", "phases": 2, "bus1": ".2.3", "bus2": ".0.0"},
}

FAULT_NAME = "study_fault"


def _nodes_at(bus: str) -> list[int]:
    dss.Circuit.SetActiveBus(bus)
    return [int(n) for n in dss.Bus.Nodes() if 1 <= int(n) <= 3]


def _place_fault(bus: str, kind: str, r_ohm: float, phase: int | None = None) -> str | None:
    """Define the Fault element at `bus`; None when the bus lacks the phases
    the kind needs (a single-phase lateral has no line-to-line fault)."""
    spec = FAULT_KINDS[kind]
    nodes = _nodes_at(bus)
    if not nodes:
        return None
    if kind == "lg":
        ph = phase if phase in nodes else nodes[0]
        bus1, bus2, phases = f".{ph}", ".0", 1
    elif kind == "ll":
        if len(nodes) < 2:
            return None
        a, b = (phase, next(n for n in nodes if n != phase)) if phase in nodes else nodes[:2]
        bus1, bus2, phases = f".{a}", f".{b}", 1
    elif kind == "llg":
        if len(nodes) < 2:
            return None
        a, b = nodes[:2]
        bus1, bus2, phases = f".{a}.{b}", ".0.0", 2
    else:
        if len(nodes) < 3:
            return None
        bus1, bus2, phases = ".1.2.3", ".0.0.0", 3
    r = max(float(r_ohm), 1e-4)
    # The element persists once defined (disabling keeps it), and the engine
    # objects to a second `new` of the same name, so later faults are edits.
    verb = "edit" if dss.Circuit.SetActiveElement(f"fault.{FAULT_NAME}") >= 0 else "new"
    dss.Text.Command(
        f"{verb} fault.{FAULT_NAME} bus1={bus}{bus1} bus2={bus}{bus2} phases={phases} "
        f"r={r:.6g} ontime=0 temporary=no enabled=yes"
    )
    return spec["label"]


def _remove_fault() -> None:
    try:
        dss.Text.Command(f"fault.{FAULT_NAME}.enabled=no")
    except Exception:
        pass


def _fault_amps() -> list[float]:
    dss.Circuit.SetActiveElement(f"fault.{FAULT_NAME}")
    mags = dss.CktElement.CurrentsMagAng()
    nph = dss.CktElement.NumPhases()
    return [float(v) for v in mags[0 : 2 * nph : 2]]


def der_contribution_amps(kva: float, kv_ll: float, phases: int, der_type: str) -> float:
    """What a unit of `kva` at `kv_ll` feeds into a fault at its terminals:
    1.2 x rated current for an inverter, 5 x for a synchronous machine."""
    if kva <= 0 or kv_ll <= 0:
        return 0.0
    i_rated = kva / (math.sqrt(3) * kv_ll) if phases == 3 else kva / kv_ll
    return (5.0 if der_type == "synchronous" else 1.2) * i_rated


def _device_currents(element_map: dict[str, str]) -> dict[str, dict[str, Any]]:
    """Terminal-1 current of every series element while the fault is on."""
    out: dict[str, dict[str, Any]] = {}
    for full, diagram_id in element_map.items():
        if not full.startswith(("line.", "transformer.")):
            continue
        if dss.Circuit.SetActiveElement(full) < 0 or not dss.CktElement.Enabled():
            continue
        nph = dss.CktElement.NumPhases()
        mags = dss.CktElement.CurrentsMagAng()
        amps = [float(v) for v in mags[0 : 2 * nph : 2]]
        out[full] = {
            "id": diagram_id,
            "amps": round(max(amps), 1) if amps else 0.0,
            "phaseAmps": [round(a, 1) for a in amps],
        }
    return out


def fault_point(
    circuit: Circuit, bus: str, kind: str = "3ph", r_ohm: float = 0.0, phase: int | None = None
) -> dict[str, Any]:
    """One fault at one bus: current in the fault, the current every series
    element carries, and the bus voltages while it is on."""
    if kind not in FAULT_KINDS:
        raise ValueError(f"Unknown fault kind {kind!r}; one of {', '.join(FAULT_KINDS)}.")
    circuit = effective_circuit(circuit)
    return _fault_point(circuit, bus.lower(), kind, float(r_ohm), phase)


@engine.on_engine_thread
def _fault_point(
    circuit: Circuit, bus: str, kind: str, r_ohm: float, phase: int | None
) -> dict[str, Any]:
    compiled = compile_circuit(circuit, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "issues": [i.model_dump() for i in issues]}
    with engine.dss_guard():
        engine._ensure_init()
        engine._write_aux_files(compiled)
        if not engine._run_commands(
            compiled.commands, compiled.element_map, issues, compiled.optional_commands
        ):
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        if bus not in {b.lower() for b in dss.Circuit.AllBusNames()}:
            issues.append(
                Issue(severity="error", code="no-such-bus", message=f"No bus named '{bus}'.")
            )
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        engine.quiet_for_fault_study(compiled.element_map, compiled.passthrough_names)
        label = _place_fault(bus, kind, r_ohm, phase)
        if label is None:
            issues.append(
                Issue(
                    severity="error",
                    code="fault-phases",
                    message=f"Bus '{bus}' has too few phases "
                    f"for a {FAULT_KINDS[kind]['label']} fault.",
                )
            )
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        dss.Text.Command("set mode=snapshot")
        dss.Text.Command("set controlmode=off")
        dss.Solution.Solve()
        converged = bool(dss.Solution.Converged())
        amps = _fault_amps() if converged else []
        devices = _device_currents(compiled.element_map) if converged else {}
        voltages: dict[str, float] = {}
        if converged:
            mags = dss.Circuit.AllBusMagPu()
            names = [n.lower() for n in dss.Circuit.AllNodeNames()]
            for idx, node in enumerate(names):
                b = node.split(".", 1)[0]
                voltages[b] = min(voltages.get(b, 9.0), float(mags[idx]))
        _remove_fault()
    conn = compiled.connectivity
    return {
        "converged": converged,
        "bus": bus,
        "kind": kind,
        "label": label,
        "rOhm": r_ohm,
        "faultA": round(max(amps), 1) if amps else None,
        "faultPhaseA": [round(a, 1) for a in amps],
        "devices": devices,
        "busVoltages": {b: round(v, 4) for b, v in voltages.items()},
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": conn.node_buses if conn else {},
        "busNames": conn.bus_names if conn else {},
    }


def fault_sweep(
    circuit: Circuit,
    r_ohm: float = 0.0,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    """Maximum and minimum fault currents at every bus: bolted three-phase
    and single-line-to-ground from a fault study (the maximum cases), and
    line-to-line bolted and line-to-ground through `r_ohm` from Fault
    element solves (the minimum cases coordination is checked against)."""
    circuit = effective_circuit(circuit)
    return _fault_sweep(circuit, float(r_ohm), progress, cancel)


@engine.on_engine_thread
def _fault_sweep(
    circuit: Circuit, r_ohm: float, progress: Progress | None, cancel: threading.Event | None
) -> dict[str, Any]:
    compiled = compile_circuit(circuit, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "issues": [i.model_dump() for i in issues], "buses": {}}
    buses_out: dict[str, Any] = {}
    cancelled = False
    with engine.dss_guard():
        engine._ensure_init()
        engine._write_aux_files(compiled)
        if not engine._run_commands(
            compiled.commands, compiled.element_map, issues, compiled.optional_commands
        ):
            return {"converged": False, "issues": [i.model_dump() for i in issues], "buses": {}}
        engine.quiet_for_fault_study(compiled.element_map, compiled.passthrough_names)
        dss.Text.Command("set mode=faultstudy")
        dss.Text.Command("solve")
        names = [b.lower() for b in dss.Circuit.AllBusNames()]
        for b in names:
            dss.Circuit.SetActiveBus(b)
            v_ln = dss.Bus.kVBase() * 1000.0
            z1_raw, z0_raw = dss.Bus.Zsc1(), dss.Bus.Zsc0()
            z1 = complex(float(z1_raw[0]), float(z1_raw[1]))
            z0 = complex(float(z0_raw[0]), float(z0_raw[1]))
            loop = 2 * z1 + z0
            buses_out[b] = {
                "kvBase": round(dss.Bus.kVBase(), 5),
                "if3phA": round(v_ln / abs(z1), 1) if abs(z1) > 1e-9 else None,
                "if1phA": round(3 * v_ln / abs(loop), 1) if abs(loop) > 1e-9 else None,
                "ifLLA": None,
                "ifLGrA": None,
            }
        dss.Text.Command("set mode=snapshot")
        dss.Text.Command("set controlmode=off")
        total = len(names)
        for i, b in enumerate(names):
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            for key, kind, r in (("ifLLA", "ll", 0.0), ("ifLGrA", "lg", r_ohm)):
                if _place_fault(b, kind, r) is None:
                    continue
                dss.Solution.Solve()
                if dss.Solution.Converged():
                    amps = _fault_amps()
                    buses_out[b][key] = round(max(amps), 1) if amps else None
                _remove_fault()
            if progress is not None and (i % max(1, total // 100) == 0 or i == total - 1):
                progress(i + 1, total, b)
        for _b, rec in buses_out.items():
            mins = [v for v in (rec["ifLLA"], rec["ifLGrA"]) if v]
            rec["ifMinA"] = round(min(mins), 1) if mins else None
    conn = compiled.connectivity
    return {
        "converged": bool(buses_out),
        "cancelled": cancelled,
        "rOhm": r_ohm,
        "buses": buses_out,
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": conn.node_buses if conn else {},
        "busNames": conn.bus_names if conn else {},
    }
