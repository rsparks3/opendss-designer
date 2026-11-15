"""Power quality: harmonic distortion and rapid voltage change.

* `harmonics` -- the circuit solved at the fundamental and then at each
  harmonic in turn (`mode=harmonics`, one `harmonics=[h]` solve per
  order), every element injecting by its spectrum (the engine's defaults
  for loads, generators and PV unless a project spectrum is named), and
  the voltage total harmonic distortion at every bus with the worst
  single harmonic, against IEEE 519 (5 % THD and 3 % individual below
  69 kV at the point of common coupling).
* `rapid_voltage_change` -- the voltage step at every bus when a motor
  starts (a locked-rotor load at a low power factor switched on) or a DER
  unit trips, against IEEE 1453 / 1547-2018 limits (3 % for infrequent
  events; a flicker-sensitive utility may ask for 2 %).
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
DEFAULT_ORDERS = (3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25)


def _build(circuit: Circuit):
    compiled = compile_circuit(circuit, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return compiled, issues, False
    engine._ensure_init()
    engine._write_aux_files(compiled)
    ok = engine._run_commands(
        compiled.commands, compiled.element_map, issues, compiled.optional_commands
    )
    return compiled, issues, ok


def harmonics(
    circuit: Circuit,
    orders: list[int] | None = None,
    thd_limit: float = 5.0,
    individual_limit: float = 3.0,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    circuit = effective_circuit(circuit)
    hs = [int(h) for h in (orders or DEFAULT_ORDERS) if 2 <= int(h) <= 50]
    return _harmonics(
        circuit,
        hs or list(DEFAULT_ORDERS),
        float(thd_limit),
        float(individual_limit),
        progress,
        cancel,
    )


@engine.on_engine_thread
def _harmonics(
    circuit: Circuit,
    orders: list[int],
    thd_limit: float,
    ind_limit: float,
    progress: Progress | None,
    cancel: threading.Event | None,
) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues], "buses": {}}
        dss.Text.Command("set mode=snapshot")
        dss.Solution.Solve()
        if not dss.Solution.Converged():
            issues.append(
                Issue(
                    severity="error",
                    code="not-converged",
                    message="The fundamental does not converge.",
                )
            )
            return {"converged": False, "issues": [i.model_dump() for i in issues], "buses": {}}
        node_names = [n.lower() for n in dss.Circuit.AllNodeNames()]
        slices: dict[str, list[int]] = {}
        for idx, node in enumerate(node_names):
            slices.setdefault(node.split(".", 1)[0], []).append(idx)
        v1 = [float(v) for v in dss.Circuit.AllBusVMag()]
        by_order: dict[int, list[float]] = {}
        cancelled = False
        for i, h in enumerate(orders):
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            dss.Text.Command("set mode=harmonics")
            dss.Text.Command(f"set harmonics=[{h}]")
            dss.Solution.Solve()
            by_order[h] = [float(v) for v in dss.Circuit.AllBusVMag()]
            if progress is not None:
                progress(i + 1, len(orders), f"harmonic {h}")
        dss.Text.Command("set mode=snapshot")
        dss.Solution.Solve()
    buses: dict[str, Any] = {}
    worst_thd = (0.0, None)
    over_thd = 0
    for b, idxs in slices.items():
        fund = [v1[i] for i in idxs]
        if not fund or max(fund) < 1.0:
            continue
        per_node_thd = []
        worst_h = (0.0, None)
        spectrum: dict[str, float] = {}
        for k, i in enumerate(idxs):
            if fund[k] <= 0:
                continue
            total = 0.0
            for h, vals in by_order.items():
                pct = 100.0 * vals[i] / fund[k]
                total += pct * pct
                if pct > worst_h[0]:
                    worst_h = (pct, h)
                spectrum[str(h)] = max(spectrum.get(str(h), 0.0), round(pct, 3))
            per_node_thd.append(math.sqrt(total))
        thd = max(per_node_thd) if per_node_thd else 0.0
        over = thd > thd_limit or worst_h[0] > ind_limit
        over_thd += 1 if over else 0
        if thd > worst_thd[0]:
            worst_thd = (thd, b)
        buses[b] = {
            "thdPct": round(thd, 3),
            "worstHarmonic": worst_h[1],
            "worstPct": round(worst_h[0], 3),
            "spectrum": spectrum,
            "over": over,
        }
    return {
        "converged": not cancelled,
        "cancelled": cancelled,
        "orders": list(by_order),
        "limits": {"thdPct": thd_limit, "individualPct": ind_limit},
        "buses": buses,
        "summary": {
            "buses": len(buses),
            "overLimit": over_thd,
            "worstThdPct": round(worst_thd[0], 3),
            "worstBus": worst_thd[1],
        },
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": compiled.connectivity.node_buses if compiled.connectivity else {},
        "busNames": compiled.connectivity.bus_names if compiled.connectivity else {},
    }


def rapid_voltage_change(
    circuit: Circuit,
    bus: str,
    kind: str = "motorStart",
    kva: float = 500.0,
    pf: float = 0.3,
    lrc_multiple: float = 6.0,
    limit_pct: float = 3.0,
    der_id: str | None = None,
) -> dict[str, Any]:
    """The voltage step at every bus for a motor start at `bus` (a load of
    `kva` x `lrc_multiple` at `pf`, switched on) or a DER trip (`der_id`
    disabled, or `kva` of generation at `bus` removed)."""
    circuit = effective_circuit(circuit)
    return _rvc(
        circuit,
        bus.lower(),
        kind,
        float(kva),
        float(pf),
        float(lrc_multiple),
        float(limit_pct),
        der_id,
    )


@engine.on_engine_thread
def _rvc(
    circuit: Circuit,
    bus: str,
    kind: str,
    kva: float,
    pf: float,
    lrc: float,
    limit: float,
    der_id: str | None,
) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        dss.Text.Command("set mode=snapshot")
        dss.Text.Command("set controlmode=off")  # the step before any regulator moves
        all_buses = {b.lower() for b in dss.Circuit.AllBusNames()}
        if bus not in all_buses and not der_id:
            issues.append(
                Issue(severity="error", code="no-such-bus", message=f"No bus named '{bus}'.")
            )
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        node_names = [n.lower() for n in dss.Circuit.AllNodeNames()]
        slices: dict[str, list[int]] = {}
        for idx, node in enumerate(node_names):
            slices.setdefault(node.split(".", 1)[0], []).append(idx)

        def voltages() -> dict[str, float]:
            mags = dss.Circuit.AllBusMagPu()
            return {b: min(mags[i] for i in idxs) for b, idxs in slices.items()}

        der_full = None
        if kind == "derTrip" and der_id:
            der_full = next(
                (
                    f
                    for f, ref in compiled.element_map.items()
                    if ref == der_id and f.startswith(("generator.", "pvsystem.", "storage."))
                ),
                None,
            )
            if der_full is None:
                issues.append(
                    Issue(
                        severity="error",
                        code="no-such-der",
                        message="That element is not a generator, PV system or storage unit.",
                    )
                )
                return {"converged": False, "issues": [i.model_dump() for i in issues]}
            dss.Circuit.SetActiveElement(der_full)
            bus = str(dss.CktElement.BusNames()[0]).split(".", 1)[0].lower()
        dss.Solution.Solve()
        before = voltages()
        dss.Circuit.SetActiveBus(bus)
        nodes = [int(n) for n in dss.Bus.Nodes() if 1 <= int(n) <= 3]
        kv_ln = float(dss.Bus.kVBase())
        phases = len(nodes) or 3
        kv = kv_ln * math.sqrt(3) if phases == 3 else kv_ln
        sfx = "." + ".".join(str(n) for n in nodes) if nodes else ""
        if kind == "motorStart":
            # Locked-rotor inrush as a constant-impedance load at a low pf.
            s_start = kva * lrc
            kw = s_start * pf
            dss.Text.Command(
                f"new load.rvc_motor bus1={bus}{sfx} phases={phases} kv={kv:.6g} kw={kw:.6g} pf={pf:g} model=2 vminpu=0.5"  # noqa: E501
            )
            label = f"motor start, {kva:g} kVA at {lrc:g} x locked rotor, pf {pf:g}"
        else:
            if der_full:
                dss.Text.Command(f"{der_full}.enabled=no")
                label = f"trip of {der_full}"
            else:
                dss.Text.Command(
                    f"new generator.rvc_trip bus1={bus}{sfx} phases={phases} kv={kv:.6g} kw={-kva:.6g} pf=1 model=1"  # noqa: E501
                )
                label = f"loss of {kva:g} kW of generation at {bus}"
        dss.Solution.Solve()
        conv = bool(dss.Solution.Converged())
        after = voltages() if conv else {}
        if kind == "motorStart":
            dss.Text.Command("load.rvc_motor.enabled=no")
        elif der_full:
            dss.Text.Command(f"{der_full}.enabled=yes")
        else:
            dss.Text.Command("generator.rvc_trip.enabled=no")
    if not conv:
        issues.append(
            Issue(
                severity="error",
                code="not-converged",
                message="The disturbed case does not converge.",
            )
        )
        return {"converged": False, "issues": [i.model_dump() for i in issues]}
    steps = {
        b: round(100.0 * (after[b] - before[b]), 3)
        for b in before
        if b in after and before[b] > 0.05
    }
    worst_bus = max(steps, key=lambda b: abs(steps[b])) if steps else None
    at_bus = steps.get(bus)
    return {
        "converged": True,
        "kind": kind,
        "bus": bus,
        "label": label,
        "stepAtBusPct": at_bus,
        "worstStepPct": steps[worst_bus] if worst_bus else None,
        "worstBus": worst_bus,
        "limitPct": limit,
        "pass": abs(steps[worst_bus]) <= limit if worst_bus else None,
        "steps": steps,
        "busesOver": sum(1 for v in steps.values() if abs(v) > limit),
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": compiled.connectivity.node_buses if compiled.connectivity else {},
        "busNames": compiled.connectivity.bus_names if compiled.connectivity else {},
    }
