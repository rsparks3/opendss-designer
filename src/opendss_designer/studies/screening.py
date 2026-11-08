"""Interconnection screening: one DER application at a point of common
coupling, run through the tariff screens in one go.

The screens follow the FERC Small Generator Interconnection Procedures and
IEEE 1547-2018 as most state tariffs (California Rule 21, New York SIR,
and the rest) adopt them:

1. **Aggregate generation on the line section** against 15 % of the
   section's peak load (the fast-track screen), and failing that against
   100 % of its minimum daytime load (the supplemental review).
2. **Fault-current contribution** of the unit against 10 % of the maximum
   fault current at the PCC.
3. **Interrupting duty**: every protective device under 87.5 % of its
   interrupting rating with the unit's contribution added.
4. **Rapid voltage change** when the unit trips, under 3 % at every bus
   (IEEE 1547-2018 §4.7).
5. **Steady-state voltage** with the unit running, inside the project's
   limits at every bus.
6. **Thermal**: no line, transformer or device above its rating with the
   unit running.
7. **Effective grounding** at the PCC: X0/X1 between 0 and 3 and R0/X1
   between 0 and 1 (IEEE 142), from the fault study's Thevenin impedances.
8. **Smart inverter settings** the unit must run (IEEE 1547-2018 Category
   B volt-var and volt-watt by default), reported, not judged.

Each screen reports its value, its limit and pass / fail; the outcome is
*pass* (every screen), *supplemental* (only the aggregate screen failed,
and the minimum-load test passed) or *fail*.
"""
from __future__ import annotations

import math
from typing import Any

import opendssdirect as dss

from ..core import engine
from ..core.compiler import compile_circuit
from ..core.model import Circuit, Issue
from ..core.validate import limit_issues
from .faults import der_contribution_amps
from .hosting_capacity import _protection_sections
from .scenarios import effective_circuit

DEFAULT_SCREEN_OPTIONS: dict[str, Any] = {
    "kw": 500.0,
    "pf": 1.0,
    "kva": None,                  # inverter rating; blank = kW / pf
    "derType": "inverter",        # or "synchronous"
    "export": True,               # exporting systems face the minimum-load test
    "aggregatePct": 15.0,         # of the line section's peak load
    "minLoadPct": 100.0,          # of the section's minimum daytime load (supplemental)
    "minLoadMult": None,          # None: the project's level named like "minimum", else 0.3
    "faultIncreasePct": 10.0,
    "interruptingPct": 87.5,
    "deviationPct": 3.0,
    "thermalPct": 100.0,
    "x0x1Max": 3.0,
    "r0x1Max": 1.0,
    "inverterCategory": "B",
}


def options_from(raw: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(DEFAULT_SCREEN_OPTIONS)
    for k, v in (raw or {}).items():
        if k in out:
            out[k] = v
    return out


def _min_load_mult(circuit: Circuit, opts: dict[str, Any]) -> float:
    if opts["minLoadMult"] is not None:
        return float(opts["minLoadMult"])
    for lvl in circuit.loadLevels or []:
        if "min" in lvl.name.lower():
            return float(lvl.loadmult)
    return 0.3


def screen(circuit: Circuit, bus: str, raw_options: dict[str, Any] | None = None) -> dict[str, Any]:
    opts = options_from(raw_options)
    circuit = effective_circuit(circuit)
    return _screen(circuit, bus.lower(), opts)


@engine.on_engine_thread
def _screen(circuit: Circuit, bus: str, opts: dict[str, Any]) -> dict[str, Any]:
    compiled = compile_circuit(circuit, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(circuit) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"converged": False, "issues": [i.model_dump() for i in issues], "screens": []}
    limits = circuit.criteria
    kw = float(opts["kw"])
    pf = float(opts["pf"]) or 1.0
    kva = float(opts["kva"]) if opts.get("kva") else kw / abs(pf)
    screens: list[dict[str, Any]] = []
    with engine.dss_guard():
        engine._ensure_init()
        engine._write_aux_files(compiled)
        if not engine._run_commands(compiled.commands, compiled.element_map, issues,
                                    compiled.optional_commands):
            return {"converged": False, "issues": [i.model_dump() for i in issues], "screens": []}
        all_buses = {b.lower() for b in dss.Circuit.AllBusNames()}
        if bus not in all_buses:
            issues.append(Issue(severity="error", code="no-such-bus", message=f"No bus named '{bus}'."))
            return {"converged": False, "issues": [i.model_dump() for i in issues], "screens": []}
        dss.Circuit.SetActiveBus(bus)
        kv_ln = float(dss.Bus.kVBase())
        nodes = [int(n) for n in dss.Bus.Nodes() if 1 <= int(n) <= 3]
        phases = len(nodes)
        kv_ll = kv_ln * math.sqrt(3) if phases == 3 else kv_ln

        # --- base fault study: Thevenin impedances, fault currents ----------------
        engine.quiet_for_fault_study(compiled.element_map, compiled.passthrough_names)
        dss.Text.Command("set mode=faultstudy")
        dss.Text.Command("solve")
        fault: dict[str, float] = {}
        z1_pcc = z0_pcc = None
        for b in all_buses:
            dss.Circuit.SetActiveBus(b)
            z1r, z0r = dss.Bus.Zsc1(), dss.Bus.Zsc0()
            z1 = complex(float(z1r[0]), float(z1r[1]))
            z0 = complex(float(z0r[0]), float(z0r[1]))
            v = dss.Bus.kVBase() * 1000.0
            if abs(z1) > 1e-9:
                fault[b] = v / abs(z1)
            if b == bus:
                z1_pcc, z0_pcc = z1, z0
        for full in compiled.element_map:
            if full.startswith(("storage.", "regcontrol.", "fuse.", "recloser.", "relay.")):
                dss.Text.Command(f"{full}.enabled=yes")
        for full in compiled.passthrough_names:
            dss.Text.Command(f"{full}.enabled=yes")
        dss.Text.Command("set mode=snapshot")

        # --- base power flow -------------------------------------------------------------
        dss.Text.Command("solve")
        if not dss.Solution.Converged():
            issues.append(Issue(severity="error", code="not-converged",
                                message="The base case does not converge."))
            return {"converged": False, "issues": [i.model_dump() for i in issues], "screens": []}
        node_names = [n.lower() for n in dss.Circuit.AllNodeNames()]
        slices: dict[str, list[int]] = {}
        for idx, node in enumerate(node_names):
            slices.setdefault(node.split(".", 1)[0], []).append(idx)

        def voltages() -> dict[str, tuple[float, float]]:
            mags = dss.Circuit.AllBusMagPu()
            return {b: (min(mags[i] for i in idxs), max(mags[i] for i in idxs)) for b, idxs in slices.items()}

        base_v = voltages()
        pd_names = [n.lower() for n in dss.PDElements.AllNames()]
        base_loading = dict(zip(pd_names, (float(v) for v in dss.PDElements.AllPctNorm(False))))

        # --- the unit at the PCC ---------------------------------------------------------
        suffix = "." + ".".join(str(n) for n in nodes)
        dss.Text.Command(f"new generator.screen_unit bus1={bus}{suffix} phases={phases} kv={kv_ll:.6g} "
                         f"kw={kw:.6g} pf={pf:g} kva={kva:.6g} model=1 enabled=yes")
        dss.Text.Command("solve")
        with_unit_ok = bool(dss.Solution.Converged())
        with_v = voltages() if with_unit_ok else {}
        with_loading = dict(zip(pd_names, (float(v) for v in dss.PDElements.AllPctNorm(False)))) if with_unit_ok else {}
        dss.Text.Command("generator.screen_unit.enabled=no")
        dss.Text.Command("solve")
        tripped_v = voltages() if dss.Solution.Converged() else {}

    # --- the screens --------------------------------------------------------------------------
    sections = _protection_sections(circuit, compiled)
    sec = sections.get(bus, {"section": "", "sectionLoadKw": 0.0})
    conn = compiled.connectivity
    existing_kw = 0.0
    for n in circuit.nodes:
        if n.type in ("generator", "pvsystem", "storage") and n.params.get("enabled", True) is not False:
            nb = conn.node_buses.get(n.id, [None])[0] if conn else None
            if nb and sections.get(nb.lower(), {}).get("section") == sec["section"]:
                try:
                    existing_kw += float(n.params.get("kw") or n.params.get("pmpp") or n.params.get("kwrated") or 0)
                except (TypeError, ValueError):
                    pass
    aggregate = existing_kw + kw
    peak = sec["sectionLoadKw"]
    min_mult = _min_load_mult(circuit, opts)
    min_load = peak * min_mult
    agg_limit = peak * float(opts["aggregatePct"]) / 100.0
    agg_pass = aggregate <= agg_limit if peak > 0 else None
    screens.append({
        "key": "aggregate", "label": "Aggregate generation on the line section",
        "value": round(aggregate, 1), "limit": round(agg_limit, 1), "unit": "kW",
        "pass": agg_pass,
        "note": f"{round(existing_kw)} kW already on the section plus this unit, against "
                f"{opts['aggregatePct']:g} % of the section's {round(peak)} kW peak load"
                + ("" if peak > 0 else "; the section has no load, so the screen cannot be applied"),
    })
    if agg_pass is False and opts["export"]:
        supp_limit = min_load * float(opts["minLoadPct"]) / 100.0
        screens.append({
            "key": "minimumLoad", "label": "Aggregate generation against minimum daytime load",
            "value": round(aggregate, 1), "limit": round(supp_limit, 1), "unit": "kW",
            "pass": aggregate <= supp_limit,
            "note": f"supplemental review: {opts['minLoadPct']:g} % of the section's minimum load "
                    f"({round(min_load)} kW at x{min_mult:g})",
        })
    contribution = der_contribution_amps(kva, kv_ll, phases, str(opts["derType"]))
    base_at_pcc = fault.get(bus)
    inc_pct = 100.0 * contribution / base_at_pcc if base_at_pcc else None
    screens.append({
        "key": "faultCurrent", "label": "Fault-current contribution at the PCC",
        "value": round(inc_pct, 2) if inc_pct is not None else None, "limit": float(opts["faultIncreasePct"]),
        "unit": "%", "pass": inc_pct <= float(opts["faultIncreasePct"]) if inc_pct is not None else None,
        "note": f"{round(contribution)} A ({'1.2' if opts['derType'] != 'synchronous' else '5'} x rated) "
                f"against {round(base_at_pcc) if base_at_pcc else '?'} A three-phase at the PCC",
    })
    worst_duty = None
    worst_dev = None
    for n in circuit.nodes:
        if n.type in ("breaker", "fuse", "recloser", "relay"):
            try:
                ka = float(n.params.get("interruptingka") or 0)
            except (TypeError, ValueError):
                ka = 0.0
            nb = conn.node_buses.get(n.id, [None])[0] if conn else None
            if ka > 0 and nb and fault.get(nb.lower()):
                duty = 100.0 * (fault[nb.lower()] + contribution) / (ka * 1000.0)
                if worst_duty is None or duty > worst_duty:
                    worst_duty, worst_dev = duty, str(n.params.get("name") or n.id)
    screens.append({
        "key": "interrupting", "label": "Interrupting duty with the unit's contribution",
        "value": round(worst_duty, 1) if worst_duty is not None else None,
        "limit": float(opts["interruptingPct"]), "unit": "%",
        "pass": worst_duty <= float(opts["interruptingPct"]) if worst_duty is not None else None,
        "note": f"worst device {worst_dev}" if worst_dev else "no device carries an interrupting rating",
    })
    dev = None
    dev_bus = None
    if with_v and tripped_v:
        for b, (lo, hi) in with_v.items():
            if b in tripped_v and tripped_v[b][0] > 0.05:
                d = max(abs(hi - tripped_v[b][1]), abs(lo - tripped_v[b][0])) * 100.0
                if dev is None or d > dev:
                    dev, dev_bus = d, b
    screens.append({
        "key": "deviation", "label": "Rapid voltage change when the unit trips",
        "value": round(dev, 2) if dev is not None else None, "limit": float(opts["deviationPct"]), "unit": "%",
        "pass": dev <= float(opts["deviationPct"]) if dev is not None else None,
        "note": f"largest at bus {dev_bus}" if dev_bus else "the case with the unit did not converge",
    })
    vmax = max((hi for lo, hi in with_v.values()), default=None) if with_v else None
    vmin = min((lo for lo, hi in with_v.values() if lo > 0.05), default=None) if with_v else None
    v_pass = (vmax is not None and vmin is not None and vmax <= limits.vmaxPu and vmin >= limits.vminPu)
    base_vmax = max(hi for lo, hi in base_v.values())
    screens.append({
        "key": "voltage", "label": "Steady-state voltage with the unit running",
        "value": round(vmax, 4) if vmax is not None else None, "limit": limits.vmaxPu, "unit": "pu",
        "pass": v_pass if with_v else None,
        "note": f"highest {vmax:.4f} pu (base {base_vmax:.4f}), lowest {vmin:.4f} pu" if with_v else "did not converge",
    })
    worst_load = max(with_loading.items(), key=lambda kv: kv[1], default=(None, None)) if with_loading else (None, None)
    new_overloads = [n for n, pct in with_loading.items()
                     if pct >= float(opts["thermalPct"]) and base_loading.get(n, 0.0) < float(opts["thermalPct"])]
    screens.append({
        "key": "thermal", "label": "Loading with the unit running",
        "value": round(worst_load[1], 1) if worst_load[1] is not None else None,
        "limit": float(opts["thermalPct"]), "unit": "%",
        "pass": not new_overloads if with_loading else None,
        "note": (f"most loaded {worst_load[0]}" if worst_load[0] else "")
                + (f"; newly over the rating: {', '.join(new_overloads[:5])}" if new_overloads else ""),
    })
    x0x1 = r0x1 = None
    if z1_pcc is not None and z0_pcc is not None and abs(z1_pcc.imag) > 1e-9:
        x0x1 = z0_pcc.imag / z1_pcc.imag
        r0x1 = z0_pcc.real / z1_pcc.imag
    grounded = (x0x1 is not None and 0 <= x0x1 <= float(opts["x0x1Max"])
                and r0x1 is not None and 0 <= r0x1 <= float(opts["r0x1Max"]))
    screens.append({
        "key": "grounding", "label": "Effective grounding at the PCC",
        "value": round(x0x1, 2) if x0x1 is not None else None, "limit": float(opts["x0x1Max"]), "unit": "X0/X1",
        "pass": grounded if x0x1 is not None else None,
        "note": f"X0/X1 = {x0x1:.2f}, R0/X1 = {r0x1:.2f} (limits {opts['x0x1Max']:g} and {opts['r0x1Max']:g})"
                if x0x1 is not None else "no Thevenin impedance at the PCC",
    })
    cat = str(opts["inverterCategory"]).upper()
    screens.append({
        "key": "inverter", "label": f"Smart inverter settings required (IEEE 1547-2018 Category {cat})",
        "value": None, "limit": None, "unit": "", "pass": None,
        "note": ("volt-var 0.92/0.98/1.02/1.08 pu at ±44 % var, volt-watt from 1.06 to 1.10 pu"
                 if cat == "B" else "volt-var 0.9/1.0/1.1 pu at ±25 % var"),
    })
    judged = [s for s in screens if s["pass"] is not None]
    failed = [s["key"] for s in judged if s["pass"] is False]
    if not failed:
        outcome = "pass"
    elif failed == ["aggregate"] and any(s["key"] == "minimumLoad" and s["pass"] for s in screens):
        outcome = "supplemental"
    else:
        outcome = "fail"
    return {
        "converged": True,
        "bus": bus,
        "busName": (conn.bus_names.get(bus) if conn else None) or bus,
        "kvBase": round(kv_ll, 4),
        "phases": phases,
        "unit": {"kw": kw, "pf": pf, "kva": round(kva, 1), "derType": opts["derType"], "export": bool(opts["export"])},
        "section": {"head": sec["section"], "peakLoadKw": round(peak, 1), "minLoadKw": round(min_load, 1),
                    "existingDerKw": round(existing_kw, 1), "minLoadMult": min_mult},
        "screens": screens,
        "failed": failed,
        "outcome": outcome,
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": conn.node_buses if conn else {},
        "busNames": conn.bus_names if conn else {},
    }
