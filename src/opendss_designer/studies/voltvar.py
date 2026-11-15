"""Volt/VAR: setting sweeps, CVR evaluation and capacitor placement.

* `setting_sweep` -- a grid of control settings (regulator setpoint and
  bandwidth, capacitor on/off settings, anything with a numeric engine
  property) run over a day each, tabulating energy, losses, the voltage
  range, control operations and violations, so the planner picks a row.
* `cvr` -- paired daily runs at the present and a reduced regulator
  setpoint (or source voltage, when there is no regulator), reporting the
  energy saved, the CVR factor and the lowest customer voltage.
* `capacitor_placement` -- candidate buses ranked by the loss reduction
  and voltage lift of a bank of a given size, greedily for several banks.

Each is one build of the circuit; a daily run is 24 (or 96) solves.
"""

from __future__ import annotations

import itertools
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


def _has_shapes(circuit: Circuit) -> bool:
    return any(n.params.get("loadshape") for n in circuit.nodes)


def _daily_run(step_min: int, limits, load_buses: set[str] | None = None) -> dict[str, Any]:
    """Run a day from hour 0 and read what a Volt/VAR table wants."""
    dss.Text.Command("set mode=daily")
    dss.Text.Command(f"set stepsize={step_min}m")
    dss.Text.Command("set number=1")
    dss.Text.Command("set hour=0 sec=0")
    steps = 24 * 60 // step_min
    dt = step_min / 60.0
    node_names = [n.lower() for n in dss.Circuit.AllNodeNames()]
    slices: dict[str, list[int]] = {}
    for idx, node in enumerate(node_names):
        slices.setdefault(node.split(".", 1)[0], []).append(idx)
    reg_names: list[str] = []
    i = dss.RegControls.First()
    while i:
        reg_names.append(dss.RegControls.Name().lower())
        i = dss.RegControls.Next()
    cap_names: list[str] = []
    i = dss.Capacitors.First()
    while i:
        cap_names.append(dss.Capacitors.Name().lower())
        i = dss.Capacitors.Next()
    last_tap: dict[str, int] = {}
    last_state: dict[str, tuple] = {}
    ops = 0
    energy = losses = 0.0
    vmin, vmax = math.inf, -math.inf
    vmin_load = math.inf
    v_sum = 0.0
    v_n = 0
    under = over = overloads = 0
    non_conv = 0
    for _ in range(steps):
        dss.Solution.Solve()
        if not dss.Solution.Converged():
            non_conv += 1
            continue
        p = dss.Circuit.TotalPower()
        energy += -p[0] * dt
        losses += dss.Circuit.Losses()[0] / 1000.0 * dt
        mags = dss.Circuit.AllBusMagPu()
        for b, idxs in slices.items():
            vals = [mags[k] for k in idxs]
            lo, hi = min(vals), max(vals)
            if lo < 0.05:
                continue
            vmin = min(vmin, lo)
            vmax = max(vmax, hi)
            v_sum += sum(vals)
            v_n += len(vals)
            if lo < limits.vminPu:
                under += 1
            if hi > limits.vmaxPu:
                over += 1
            if load_buses is None or b in load_buses:
                vmin_load = min(vmin_load, lo)
        pct = dss.PDElements.AllPctNorm(False)
        overloads += sum(1 for v in pct if v >= limits.overloadPct)
        if reg_names:
            i = dss.RegControls.First()
            while i:
                name = dss.RegControls.Name().lower()
                tap = int(dss.RegControls.TapNumber())
                if name in last_tap:
                    ops += abs(tap - last_tap[name])
                last_tap[name] = tap
                i = dss.RegControls.Next()
        if cap_names:
            i = dss.Capacitors.First()
            while i:
                name = dss.Capacitors.Name().lower()
                st = tuple(int(v) for v in (dss.Capacitors.States() or ()))
                if name in last_state and st != last_state[name]:
                    ops += 1
                last_state[name] = st
                i = dss.Capacitors.Next()
    dss.Text.Command("set mode=snapshot")
    return {
        "energyKwh": round(energy, 1),
        "lossesKwh": round(losses, 2),
        "lossPct": round(100.0 * losses / energy, 3) if energy > 0 else None,
        "minVpu": round(vmin, 4) if vmin < math.inf else None,
        "maxVpu": round(vmax, 4) if vmax > -math.inf else None,
        "minLoadVpu": round(vmin_load, 4) if vmin_load < math.inf else None,
        "meanVpu": round(v_sum / v_n, 4) if v_n else None,
        "controlOps": ops,
        "undervoltageBusSteps": under,
        "overvoltageBusSteps": over,
        "overloadSteps": overloads,
        "nonConverged": non_conv,
        "steps": steps,
    }


# --- setting sweep -------------------------------------------------------------------


def estimate_sweep_solves(sweeps: list[dict[str, Any]], step_min: int = 60) -> int:
    combos = 1
    for s in sweeps or []:
        combos *= max(1, len(s.get("values") or []))
    return combos * (24 * 60 // max(step_min, 1))


def setting_sweep(
    circuit: Circuit,
    sweeps: list[dict[str, Any]],
    step_min: int = 60,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    """`sweeps`: [{"id": <diagram id>, "property": "vreg", "values": [120, 122, 124]}, ...];
    the cartesian product is run. Properties go on the element's control:
    a regulator's RegControl (vreg, band, r, x), a capacitor's CapControl
    (onsetting, offsetting), a source's pu."""
    circuit = effective_circuit(circuit)
    return _setting_sweep(circuit, sweeps, int(step_min), progress, cancel)


_CONTROL_PROPS = {
    "regulator": (
        "regcontrol",
        {"vreg", "band", "r", "x", "ptratio", "ctprim", "delay", "revvreg", "revband"},
    ),
    "capacitor": ("capcontrol", {"onsetting", "offsetting", "delay", "delayoff", "deadtime"}),
    "vsource": ("vsource", {"pu"}),
}


def _targets(circuit: Circuit, compiled, sweeps: list[dict[str, Any]], issues: list[Issue]):
    out = []
    by_id = {n.id: n for n in circuit.nodes}
    for s in sweeps:
        node = by_id.get(str(s.get("id")))
        prop = str(s.get("property") or "").lower()
        values = [float(v) for v in (s.get("values") or []) if isinstance(v, (int, float))]
        if node is None or node.type not in _CONTROL_PROPS or not values:
            issues.append(
                Issue(
                    severity="warning",
                    code="sweep-target",
                    message=f"Sweep over {s.get('id')}.{prop} skipped: "
                    "not a regulator, capacitor or source, or no values.",
                )
            )
            continue
        cls, allowed = _CONTROL_PROPS[node.type]
        if prop not in allowed:
            issues.append(
                Issue(
                    severity="warning",
                    code="sweep-target",
                    message=f"Sweep over {node.params.get('name', node.id)}.{prop} skipped: "
                    f"not a swept property ({', '.join(sorted(allowed))}).",
                )
            )
            continue
        full = next(
            (
                f
                for f, ref in compiled.element_map.items()
                if ref == node.id and f.startswith(("transformer.", "capacitor.", "vsource."))
            ),
            None,
        )
        if full is None:
            continue
        name = full.split(".", 1)[1]
        target = f"{cls}.{name}" if cls != "vsource" else full
        if cls == "capcontrol" and dss.Circuit.SetActiveElement(target) < 0:
            issues.append(
                Issue(
                    severity="warning",
                    code="sweep-target",
                    message=f"Capacitor {name} has no control to sweep; "
                    "give it one in its properties.",
                )
            )
            continue
        out.append(
            {
                "id": node.id,
                "name": str(node.params.get("name") or node.id),
                "target": target,
                "property": prop,
                "values": values,
            }
        )
    return out


@engine.on_engine_thread
def _setting_sweep(
    circuit: Circuit,
    sweeps: list[dict[str, Any]],
    step_min: int,
    progress: Progress | None,
    cancel: threading.Event | None,
) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues], "rows": []}
        if not _has_shapes(circuit):
            issues.append(
                Issue(
                    severity="warning",
                    code="no-shapes",
                    message="No loadshapes: every hour of the day is the same, so the sweep "
                    "measures the settings at one load only.",
                )
            )
        targets = _targets(circuit, compiled, sweeps, issues)
        if not targets:
            issues.append(Issue(severity="error", code="sweep-target", message="Nothing to sweep."))
            return {"converged": False, "issues": [i.model_dump() for i in issues], "rows": []}
        load_buses = {
            compiled.connectivity.node_buses[n.id][0].lower()
            for n in circuit.nodes
            if n.type == "load"
            and compiled.connectivity
            and n.id in compiled.connectivity.node_buses
        }
        originals: dict[str, str] = {}
        for t in targets:
            dss.Circuit.SetActiveElement(t["target"])
            originals[f"{t['target']}.{t['property']}"] = dss.Properties.Value(t["property"])
        combos = list(itertools.product(*(t["values"] for t in targets)))
        rows: list[dict[str, Any]] = []
        cancelled = False
        for i, combo in enumerate(combos):
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            for t, value in zip(targets, combo, strict=False):
                dss.Text.Command(f"{t['target']}.{t['property']}={value:g}")
            run = _daily_run(step_min, circuit.criteria, load_buses)
            rows.append(
                {
                    "settings": {f"{t['name']}.{t['property']}": v for t, v in zip(targets, combo, strict=False)},  # noqa: E501
                    **run,
                }
            )
            if progress is not None:
                progress(
                    i + 1,
                    len(combos),
                    ", ".join(f"{t['name']} {t['property']}={v:g}" for t, v in zip(targets, combo, strict=False)),  # noqa: E501
                )
        for key, raw in originals.items():
            if raw:
                dss.Text.Command(f"{key}={raw}")
    # Rank: no violations first, then least losses.
    rows.sort(
        key=lambda r: (
            r["undervoltageBusSteps"] + r["overvoltageBusSteps"] + r["overloadSteps"],
            r["lossesKwh"],
        )
    )
    return {
        "converged": True,
        "cancelled": cancelled,
        "stepMin": step_min,
        "targets": [
            {"id": t["id"], "name": t["name"], "property": t["property"], "values": t["values"]}
            for t in targets
        ],
        "rows": rows,
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
    }


# --- CVR ---------------------------------------------------------------------------


def cvr(circuit: Circuit, reduction_v: float = 2.0, step_min: int = 60) -> dict[str, Any]:
    """Paired daily runs at the present regulator setpoints and at
    `reduction_v` volts (120 V base) lower -- or the source `pu` lower by
    the same share when the circuit has no regulator."""
    circuit = effective_circuit(circuit)
    return _cvr(circuit, float(reduction_v), int(step_min))


@engine.on_engine_thread
def _cvr(circuit: Circuit, reduction_v: float, step_min: int) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues]}
        load_buses = {
            compiled.connectivity.node_buses[n.id][0].lower()
            for n in circuit.nodes
            if n.type == "load"
            and compiled.connectivity
            and n.id in compiled.connectivity.node_buses
        }
        cvr_loads = sum(
            1
            for n in circuit.nodes
            if n.type == "load" and int(float(n.params.get("model", 1) or 1)) in (2, 4, 8)
        )
        if cvr_loads == 0:
            issues.append(
                Issue(
                    severity="warning",
                    code="load-model",
                    message="Every load is constant power (model 1), so lowering the voltage saves "
                    "nothing; give loads a CVR model (4) or a ZIP model (8) with their factors.",
                )
            )
        base = _daily_run(step_min, circuit.criteria, load_buses)
        regs: list[tuple[str, float]] = []
        i = dss.RegControls.First()
        while i:
            regs.append((dss.RegControls.Name(), float(dss.RegControls.ForwardVreg())))
            i = dss.RegControls.Next()
        how = ""
        if regs:
            for name, vreg in regs:
                dss.Text.Command(f"regcontrol.{name}.vreg={vreg - reduction_v:g}")
            how = f"every regulator setpoint lowered by {reduction_v:g} V"
        else:
            dss.Circuit.SetActiveElement("vsource.source")
            pu = float(dss.Properties.Value("pu") or 1.0)
            dss.Text.Command(f"vsource.source.pu={pu * (1 - reduction_v / 120.0):.6g}")
            how = f"source voltage lowered by {reduction_v:g} V on the 120 V base (no regulator)"
        reduced = _daily_run(step_min, circuit.criteria, load_buses)
        if regs:
            for name, vreg in regs:
                dss.Text.Command(f"regcontrol.{name}.vreg={vreg:g}")
        else:
            dss.Text.Command(f"vsource.source.pu={pu:.6g}")
    d_e = (base["energyKwh"] - reduced["energyKwh"]) if base["energyKwh"] else 0.0
    d_e_pct = 100.0 * d_e / base["energyKwh"] if base["energyKwh"] else None
    d_v_pct = (
        100.0 * (base["meanVpu"] - reduced["meanVpu"]) / base["meanVpu"]
        if base["meanVpu"] and reduced["meanVpu"]
        else None
    )
    factor = (
        (d_e_pct / d_v_pct) if d_e_pct is not None and d_v_pct and abs(d_v_pct) > 1e-6 else None
    )
    return {
        "converged": True,
        "how": how,
        "reductionV": reduction_v,
        "stepMin": step_min,
        "base": base,
        "reduced": reduced,
        "energySavedKwh": round(d_e, 1),
        "energySavedPct": round(d_e_pct, 3) if d_e_pct is not None else None,
        "voltageReducedPct": round(d_v_pct, 3) if d_v_pct is not None else None,
        "cvrFactor": round(factor, 3) if factor is not None else None,
        "lossesSavedKwh": round(base["lossesKwh"] - reduced["lossesKwh"], 2),
        "lowestLoadVpu": reduced["minLoadVpu"],
        "lowestLoadV120": round(reduced["minLoadVpu"] * 120.0, 1)
        if reduced["minLoadVpu"]
        else None,
        "cvrLoads": cvr_loads,
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
    }


# --- capacitor placement ------------------------------------------------------------


def capacitor_placement(
    circuit: Circuit,
    kvar: float = 600.0,
    banks: int = 1,
    buses: list[str] | None = None,
    min_kv: float = 1.0,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    circuit = effective_circuit(circuit)
    return _capacitor_placement(
        circuit, float(kvar), max(1, int(banks)), buses, float(min_kv), progress, cancel
    )


@engine.on_engine_thread
def _capacitor_placement(
    circuit: Circuit,
    kvar: float,
    banks: int,
    buses: list[str] | None,
    min_kv: float,
    progress: Progress | None,
    cancel: threading.Event | None,
) -> dict[str, Any]:
    with engine.dss_guard():
        compiled, issues, ok = _build(circuit)
        if not ok:
            return {"converged": False, "issues": [i.model_dump() for i in issues], "rounds": []}
        dss.Text.Command("set mode=snapshot")
        dss.Solution.Solve()
        if not dss.Solution.Converged():
            issues.append(
                Issue(
                    severity="error",
                    code="not-converged",
                    message="The base case does not converge.",
                )
            )
            return {"converged": False, "issues": [i.model_dump() for i in issues], "rounds": []}
        node_names = [n.lower() for n in dss.Circuit.AllNodeNames()]
        slices: dict[str, list[int]] = {}
        for idx, node in enumerate(node_names):
            slices.setdefault(node.split(".", 1)[0], []).append(idx)
        cands: list[str] = []
        kv_of: dict[str, float] = {}
        for b in slices:
            dss.Circuit.SetActiveBus(b)
            nodes = [int(n) for n in dss.Bus.Nodes() if 1 <= int(n) <= 3]
            kv_ln = float(dss.Bus.kVBase())
            kv_ll = kv_ln * math.sqrt(3) if len(nodes) == 3 else kv_ln
            kv_of[b] = kv_ll
            if buses:
                if b in {x.lower() for x in buses}:
                    cands.append(b)
            elif len(nodes) == 3 and kv_ll >= min_kv:
                cands.append(b)

        def read() -> tuple[float, float, float]:
            mags = dss.Circuit.AllBusMagPu()
            live = [min(mags[k] for k in idxs) for idxs in slices.values()]
            live = [v for v in live if v > 0.05]
            vmax = max(max(mags[k] for k in idxs) for idxs in slices.values())
            return dss.Circuit.Losses()[0] / 1000.0, min(live) if live else 0.0, vmax

        base_loss, base_vmin, base_vmax = read()
        placed: list[dict[str, Any]] = []
        rounds: list[dict[str, Any]] = []
        cancelled = False
        solves = 1
        total = banks * len(cands)
        done = 0
        current_loss, current_vmin = base_loss, base_vmin
        for r in range(banks):
            best = None
            scores = []
            for b in cands:
                if cancel is not None and cancel.is_set():
                    cancelled = True
                    break
                if any(p["bus"] == b for p in placed):
                    continue
                verb = (
                    "edit" if dss.Circuit.SetActiveElement("capacitor.place_trial") >= 0 else "new"
                )
                dss.Text.Command(
                    f"{verb} capacitor.place_trial bus1={b} phases=3 kv={kv_of[b]:.6g} kvar={kvar:g} enabled=yes"  # noqa: E501
                )
                dss.Solution.Solve()
                solves += 1
                if dss.Solution.Converged():
                    loss, vmin, vmax = read()
                    row = {
                        "bus": b,
                        "kvBase": round(kv_of[b], 3),
                        "lossKw": round(loss, 3),
                        "lossReductionKw": round(current_loss - loss, 3),
                        "minVpu": round(vmin, 4),
                        "voltageLiftPu": round(vmin - current_vmin, 4),
                        "maxVpu": round(vmax, 4),
                        "overvoltage": vmax > circuit.criteria.vmaxPu,
                    }
                    scores.append(row)
                    if not row["overvoltage"] and (
                        best is None or row["lossReductionKw"] > best["lossReductionKw"]
                    ):
                        best = row
                dss.Text.Command("capacitor.place_trial.enabled=no")
                done += 1
                if progress is not None:
                    progress(done, total, f"bank {r + 1} at {b}")
            if cancelled or best is None:
                break
            scores.sort(key=lambda x: -x["lossReductionKw"])
            rounds.append({"bank": r + 1, "best": best, "candidates": scores[:25]})
            placed.append(best)
            dss.Text.Command(
                f"new capacitor.placed_{r} bus1={best['bus']} phases=3 kv={kv_of[best['bus']]:.6g} kvar={kvar:g}"  # noqa: E501
            )
            dss.Solution.Solve()
            solves += 1
            current_loss, current_vmin, _ = read()
        for r in range(len(placed)):
            dss.Text.Command(f"capacitor.placed_{r}.enabled=no")
    return {
        "converged": True,
        "cancelled": cancelled,
        "kvar": kvar,
        "banks": banks,
        "base": {"lossKw": round(base_loss, 3), "minVpu": round(base_vmin, 4)},
        "placed": placed,
        "rounds": rounds,
        "totalLossReductionKw": round(base_loss - current_loss, 3),
        "candidates": len(cands),
        "solves": solves,
        "loadLevel": circuit.level.model_dump(),
        "scenario": circuit.activeScenario,
        "issues": [i.model_dump() for i in issues],
        "nodeBuses": compiled.connectivity.node_buses if compiled.connectivity else {},
        "busNames": compiled.connectivity.bus_names if compiled.connectivity else {},
    }
