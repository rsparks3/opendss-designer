"""Time-current curves for the protective devices in a circuit.

The curves are read out of the engine's own `TCC_Curve` objects rather than
kept as tables here, so what the plot shows is what the solve would use. Each
one is scaled by its device's pickup, which turns "multiples of pickup vs
seconds" into the amps-and-seconds a coordination plot is drawn in.
"""
from __future__ import annotations

from typing import Any

import opendssdirect as dss

from .compiler import CompileResult, compile_circuit
from .engine import (
    SHAPE_DIR,
    _ensure_init,
    _run_commands,
    _write_aux_files,
    dss_guard,
    on_engine_thread,
)
from .model import Circuit, Issue
from .validate import limit_issues


def _num_array(query: str) -> list[float]:
    dss.Text.Command(f"? {query}")
    raw = dss.Text.Result().strip().strip("[]")
    out: list[float] = []
    for tok in raw.split():
        try:
            out.append(float(tok))
        except ValueError:
            continue
    return out


def _prop(full_name: str, prop: str) -> str:
    """One property off an element by name, for the ones the typed API does
    not expose (recloser curve names, everything on a relay)."""
    dss.Text.Command(f"? {full_name}.{prop}")
    return dss.Text.Result().strip()


def _prop_float(full_name: str, prop: str, default: float = 0.0) -> float:
    try:
        return float(_prop(full_name, prop))
    except (TypeError, ValueError):
        return default


def _curve_trace(label: str, curve: str, pickup: float,
                 delay: float) -> dict[str, Any] | None:
    """One plottable trace in amps and seconds, or None when the device has no
    usable curve (no curve name, no pickup, or a curve with a single point)."""
    if not curve or curve == "none" or pickup <= 0:
        return None
    mult = _num_array(f"tcc_curve.{curve}.c_array")
    secs = _num_array(f"tcc_curve.{curve}.t_array")
    n = min(len(mult), len(secs))
    if n < 2:
        return None
    return {
        "label": label,
        "curve": curve,
        "pickupA": round(pickup, 2),
        "points": [[round(mult[i] * pickup, 2), round(secs[i] + delay, 5)]
                   for i in range(n)],
    }


def _fault_currents(bus: str) -> tuple[float | None, float | None]:
    """Prospective 3-phase and single-phase fault current at a bus, from the
    Thevenin impedances a fault-study solve leaves behind."""
    dss.Circuit.SetActiveBus(bus)
    v_ln = dss.Bus.kVBase() * 1000.0
    z1_raw, z0_raw = dss.Bus.Zsc1(), dss.Bus.Zsc0()
    z1 = complex(float(z1_raw[0]), float(z1_raw[1]))
    z0 = complex(float(z0_raw[0]), float(z0_raw[1]))
    loop = 2 * z1 + z0
    if3 = v_ln / abs(z1) if abs(z1) > 1e-9 else None
    if1 = 3 * v_ln / abs(loop) if abs(loop) > 1e-9 else None
    return (round(if3, 1) if if3 else None, round(if1, 1) if if1 else None)


def _switch_of(raw: str) -> str | None:
    name = str(raw)
    return name.split(".", 1)[1].lower() if name.lower().startswith("line.") else None


def _device(kind: str, name: str, switch: str | None,
            element_map: dict[str, str]) -> dict[str, Any] | None:
    if not switch:
        return None
    dss.Circuit.SetActiveElement(f"line.{switch}")
    buses = dss.CktElement.BusNames()
    return {
        "nodeId": element_map.get(f"line.{switch}"),
        "name": name,
        "kind": kind,
        "switch": switch,
        # Bus 2 is downstream of the device, so a fault there is the one it is
        # there to clear.
        "bus": str(buses[1]).split(".", 1)[0].lower() if len(buses) > 1 else None,
        "traces": [],
    }


def _read_devices(element_map: dict[str, str]) -> list[dict[str, Any]]:
    """Every protective device in the built circuit, with its curves in amps."""
    devices: list[dict[str, Any]] = []

    i = dss.Fuses.First()
    while i:
        name = dss.Fuses.Name()
        dev = _device("fuse", name, _switch_of(dss.Fuses.SwitchedObj()), element_map)
        if dev:
            curve = str(dss.Fuses.TCCCurve()).lower()
            trace = _curve_trace(f"{name} ({curve})", curve,
                                 dss.Fuses.RatedCurrent(), dss.Fuses.Delay())
            if trace:
                dev["traces"].append(trace)
                devices.append(dev)
        i = dss.Fuses.Next()

    i = dss.Reclosers.First()
    while i:
        name = dss.Reclosers.Name()
        full = f"recloser.{name}"
        dev = _device("recloser", name, _switch_of(dss.Reclosers.SwitchedObj()),
                      element_map)
        if dev:
            delay = _prop_float(full, "delay")
            pickup = dss.Reclosers.PhaseTrip()
            for label, prop in (("fast", "phasefast"), ("delayed", "phasedelayed")):
                trace = _curve_trace(f"{name} {label}", _prop(full, prop).lower(),
                                     pickup, delay)
                if trace:
                    dev["traces"].append(trace)
            if dev["traces"]:
                devices.append(dev)
        i = dss.Reclosers.Next()

    i = dss.Relays.First()
    while i:
        name = dss.Relays.Name()
        full = f"relay.{name}"
        dev = _device("relay", name, _switch_of(dss.Relays.SwitchedObj()), element_map)
        if dev and _prop(full, "type").lower().startswith("current"):
            delay = _prop_float(full, "delay")
            for label, curve_prop, trip_prop in (
                ("phase", "phasecurve", "phasetrip"),
                ("ground", "groundcurve", "groundtrip"),
            ):
                trace = _curve_trace(f"{name} {label}",
                                     _prop(full, curve_prop).lower(),
                                     _prop_float(full, trip_prop), delay)
                if trace:
                    dev["traces"].append(trace)
            if dev["traces"]:
                devices.append(dev)
        i = dss.Relays.Next()

    return devices


@on_engine_thread
def tcc_study(circuit: Circuit) -> dict[str, Any]:
    """Curves for every protective device, each with the fault current
    available where it would have to operate.

    The fault currents come from the same `mode=faultstudy` solve the Fault
    overlay uses, so the plot and the overlay always agree.
    """
    compiled: CompileResult = compile_circuit(circuit, shape_dir=SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "devices": [],
                "issues": [i.model_dump() for i in issues]}

    devices: list[dict[str, Any]] = []
    converged = False
    with dss_guard():
        _ensure_init()
        _write_aux_files(compiled)
        built = _run_commands(compiled.commands, compiled.element_map, issues)
        if built:
            devices = _read_devices(compiled.element_map)
            try:
                # Storage elements crash faultstudy mode (see engine.fault_study).
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
                for dev in devices:
                    if dev["bus"]:
                        if3, if1 = _fault_currents(dev["bus"])
                        dev["faultA3ph"] = if3
                        dev["faultA1ph"] = if1

    return {
        "converged": converged,
        "devices": devices,
        "issues": [i.model_dump() for i in issues],
    }
