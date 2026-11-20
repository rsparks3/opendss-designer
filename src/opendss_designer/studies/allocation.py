"""Load allocation: a model that matches the meter and the billing system.

Three kinds of data, matched to loads by name, bus or class:

* **kWh** for a period -- turned into kW by a load factor (per class or
  one for all): kW = kWh / (hours × LF);
* **kW** -- a measured or estimated demand, taken as is;
* **intervals** -- AMI readings, one row of kW per load: the peak becomes
  the load's kW and the readings, normalised to it, its loadshape.

Then, when the feeder head is metered, every load is scaled so the solved
head power equals the measurement (two or three solves, since losses
move with the loads). The result is a set of parameter overrides -- a
scenario, or the base case, as the user chooses -- and a report of what
matched, what did not, and the head before and after.
"""

from __future__ import annotations

import math
from typing import Any

from ..core import allocations, engine
from ..core.model import Allocation, Circuit, LoadShapeSpec
from .scenarios import effective_circuit

DEFAULT_LOAD_FACTOR = 0.5


def _key_of(node, key_by: str, conn_buses: dict[str, list[str]]) -> list[str]:
    p = node.params
    if key_by == "bus":
        return [b.lower() for b in conn_buses.get(node.id, [])]
    if key_by == "class":
        return [str(p.get("class") or "").strip().lower()]
    return [str(p.get("name") or node.id).strip().lower(), node.id.lower()]


def allocate(
    circuit: Circuit, rows: list[dict[str, Any]], options: dict[str, Any] | None = None
) -> dict[str, Any]:
    """`rows`: [{"key": "...", "kwh": 123}] or [{"key": "...", "kw": 45}] or
    [{"key": "...", "values": [kw, kw, ...]}]. `options`: keyBy
    ('name'|'bus'|'class'), hours (period length for kWh), loadFactor
    (number, or {class: LF}), targetHeadKw, intervalMin, shapePrefix."""
    opts = {
        "keyBy": "name",
        "hours": 730.0,
        "loadFactor": DEFAULT_LOAD_FACTOR,
        "targetHeadKw": None,
        "intervalMin": 60,
        "shapePrefix": "ami",
    }
    opts.update({k: v for k, v in (options or {}).items() if k in opts})
    circuit = effective_circuit(circuit)
    from ..core.connectivity import synthesize

    conn = synthesize(circuit)
    loads = [
        n for n in circuit.nodes if n.type == "load" and n.params.get("enabled", True) is not False
    ]
    by_key: dict[str, list] = {}
    for n in loads:
        for k in set(_key_of(n, str(opts["keyBy"]), conn.node_buses)):
            if k and all(x.id != n.id for x in by_key.get(k, [])):
                by_key.setdefault(k, []).append(n)
    overrides: dict[str, dict[str, Any]] = {}
    shapes: dict[str, LoadShapeSpec] = {}
    matched: list[dict[str, Any]] = []
    unmatched: list[str] = []
    hours = float(opts["hours"]) or 730.0
    lf_opt = opts["loadFactor"]

    def load_factor(node) -> float:
        if isinstance(lf_opt, dict):
            cls = str(node.params.get("class") or "").strip().lower()
            for k, v in lf_opt.items():
                if str(k).strip().lower() == cls:
                    try:
                        return float(v) or DEFAULT_LOAD_FACTOR
                    except (TypeError, ValueError):
                        return DEFAULT_LOAD_FACTOR
            return DEFAULT_LOAD_FACTOR
        try:
            return float(lf_opt) or DEFAULT_LOAD_FACTOR
        except (TypeError, ValueError):
            return DEFAULT_LOAD_FACTOR

    for row in rows:
        key = str(row.get("key", "")).strip().lower()
        targets = by_key.get(key) if key else None
        if not targets:
            unmatched.append(str(row.get("key", "")))
            continue
        share = 1.0 / len(targets)  # a key matching several loads (a bus, a class) splits evenly
        for n in targets:
            entry: dict[str, Any] = {
                "id": n.id,
                "name": str(n.params.get("name") or n.id),
                "key": row.get("key"),
            }
            values = row.get("values")
            if isinstance(values, list) and len(values) >= 2:
                vals = [float(v) for v in values if isinstance(v, (int, float))]
                peak = max(vals) if vals else 0.0
                if peak <= 0:
                    unmatched.append(str(row.get("key", "")))
                    continue
                shape_name = f"{opts['shapePrefix']}_{entry['name']}".replace(" ", "_")[:60]
                shapes[shape_name] = LoadShapeSpec(
                    intervalMin=float(opts["intervalMin"]),
                    points=[round(v / peak, 5) for v in vals],
                    source="ami",
                )
                kw = peak * share
                overrides[n.id] = {"kw": round(kw, 3), "loadshape": shape_name}
                entry.update({"kw": round(kw, 3), "from": "intervals", "points": len(vals)})
            elif row.get("kw") is not None:
                kw = float(row["kw"]) * share
                overrides[n.id] = {"kw": round(kw, 3)}
                entry.update({"kw": round(kw, 3), "from": "kW"})
            elif row.get("kwh") is not None:
                lf = load_factor(n)
                kw = float(row["kwh"]) / (hours * lf) * share
                overrides[n.id] = {"kw": round(kw, 3)}
                entry.update({"kw": round(kw, 3), "from": f"kWh / ({hours:g} h × LF {lf:g})"})
            else:
                unmatched.append(str(row.get("key", "")))
                continue
            try:
                entry["before"] = float(n.params.get("kw", 0) or 0)
            except (TypeError, ValueError):
                entry["before"] = None
            matched.append(entry)
    no_data = [str(n.params.get("name") or n.id) for n in loads if n.id not in overrides]

    def apply(c: Circuit, ovr: dict[str, dict[str, Any]]) -> Circuit:
        nodes = [
            nn.model_copy(update={"params": {**nn.params, **ovr[nn.id]}}) if nn.id in ovr else nn
            for nn in c.nodes
        ]
        return c.model_copy(update={"nodes": nodes, "loadShapes": {**c.loadShapes, **shapes}})

    head_before = head_after = None
    scale = None
    base = engine.solve(circuit)
    if base.get("converged"):
        head_before = round(
            -sum(e["kw"] for f, e in base["elements"].items() if f.startswith("vsource.")), 1
        )
    allocated = apply(circuit, overrides)
    solved = engine.solve(allocated)
    if solved.get("converged"):
        head_after = round(
            -sum(e["kw"] for f, e in solved["elements"].items() if f.startswith("vsource.")), 1
        )
    target = opts["targetHeadKw"]
    if target is not None and head_after and float(target) > 0:
        # Losses move with the loads, so one ratio is not exact: iterate to
        # 0.5 % (at most five solves). Loads marked fixed keep their kW.
        scale = 1.0
        current = head_after
        scaled = overrides
        for _ in range(MAX_ITERATIONS):
            if abs(current - float(target)) <= TOLERANCE * float(target):
                break
            scale *= float(target) / current
            scaled = {
                n.id: {
                    **overrides.get(n.id, {}),
                    "kw": round(
                        float(overrides.get(n.id, {}).get("kw", n.params.get("kw", 0)) or 0)
                        * (1.0 if n.params.get("fixed") is True else scale),
                        3,
                    ),
                }
                for n in loads
            }
            trial = engine.solve(apply(circuit, scaled))
            if not trial.get("converged"):
                break
            current = -sum(
                e["kw"] for f, e in trial["elements"].items() if f.startswith("vsource.")
            )
        overrides = scaled
        head_after = round(current, 1)
        for m in matched:
            m["kw"] = round(float(overrides[m["id"]]["kw"]), 3)
    return {
        "converged": bool(solved.get("converged")),
        "overrides": overrides,
        "loadShapes": {k: v.model_dump() for k, v in shapes.items()},
        "matched": matched,
        "unmatched": unmatched,
        "noData": no_data,
        "headKwBefore": head_before,
        "headKwAfter": head_after,
        "targetHeadKw": target,
        "scale": round(scale, 4) if scale else None,
        "totalKw": round(sum(float(o.get("kw", 0) or 0) for o in overrides.values()), 1),
        "issues": solved.get("issues", []),
    }


# --- metered zones (facility plan 1.4) ------------------------------------------

TOLERANCE = 0.005
MAX_ITERATIONS = 5


def _meter_reading(result: dict[str, Any], meter_id: str) -> tuple[float, float] | None:
    """kW and kvar through the meter point toward its zone: a source's
    output, or a series element's flow (whichever way it was drawn)."""
    el = next((e for e in (result.get("elements") or {}).values() if e.get("id") == meter_id), None)
    if el is None:
        return None
    kw, kvar = float(el.get("kw") or 0.0), float(el.get("kvar") or 0.0)
    sign = -1.0 if kw < 0 else 1.0  # a source reports what it delivers as negative
    return kw * sign, kvar * sign


def allocate_zone(circuit: Circuit, spec: Allocation) -> dict[str, Any]:
    """Find the factor that makes the solved kW at the meter point agree with
    `spec.targetKW` within 0.5 % (at most five solves; losses move with the
    loads, so one ratio is not exact), and a kvar factor when a kvar or PF
    target is given. Loads marked `fixed` keep their values; the demand
    factors apply first. Other stored allocations stay applied; one whose
    zone overlaps this one's is refused."""
    clash = allocations.overlapping(circuit, spec)
    if clash:
        return {"ok": False,
                "error": f"This zone shares loads with allocation {', '.join(clash)}: zones must "
                         "not overlap. Clear that one or pick another meter point."}
    base = circuit.model_copy(update={"allocations": [a for a in circuit.allocations or []
                                                      if a.id != spec.id]})
    scales, _ = allocations.multipliers(base, only=spec.model_copy(update={"lastFactor": 1.0,
                                                                           "lastKvarFactor": None}))
    if not scales:
        return {"ok": False, "error": "Nothing below this meter point can be scaled "
                                      "(no loads, or every one is fixed or out of service)."}
    target_kvar = spec.targetKvar
    if target_kvar is None and spec.targetPF is not None:
        target_kvar = spec.targetKW * math.tan(math.acos(spec.targetPF))
    factor, kvar_factor = 1.0, (1.0 if target_kvar is not None else None)
    measured_before = None
    reading: tuple[float, float] | None = None
    converged = False
    iterations = 0
    for step in range(1, MAX_ITERATIONS + 1):
        iterations = step
        trial = spec.model_copy(update={"lastFactor": factor, "lastKvarFactor": kvar_factor})
        result = engine.solve(base.model_copy(update={
            "allocations": [*(base.allocations or []), trial]}))
        if not result.get("converged"):
            return {"ok": False, "error": "The power flow did not converge while allocating."}
        reading = _meter_reading(result, spec.meterElementId)
        if reading is None or reading[0] <= 0:
            return {"ok": False, "error": "No power flows through the meter point toward its zone."}
        if measured_before is None:
            measured_before = reading
        kw_ok = abs(reading[0] - spec.targetKW) <= TOLERANCE * spec.targetKW
        kvar_ok = target_kvar is None or abs(reading[1] - target_kvar) <= max(
            TOLERANCE * abs(target_kvar), TOLERANCE * spec.targetKW)
        if kw_ok and kvar_ok:
            converged = True
            break
        factor *= spec.targetKW / reading[0]
        if target_kvar is not None and abs(reading[1]) > 1e-6 and reading[1] * target_kvar > 0:
            # The kvar factor is applied on top of the kW one, so it carries
            # the remainder of the reactive ratio.
            kvar_factor *= (target_kvar / reading[1]) / (spec.targetKW / reading[0])
    assert reading is not None
    updated = spec.model_copy(update={
        "lastFactor": round(factor, 6),
        "lastKvarFactor": round(kvar_factor, 6) if kvar_factor is not None else None,
        "lastAchievedKW": round(reading[0], 2),
        "lastIterations": iterations,
        "lastConverged": converged,
    })
    return {
        "ok": True,
        "allocation": updated.model_dump(),
        "factor": updated.lastFactor,
        "kvarFactor": updated.lastKvarFactor,
        "achievedKw": round(reading[0], 2),
        "achievedKvar": round(reading[1], 2),
        "targetKvar": round(target_kvar, 2) if target_kvar is not None else None,
        "measuredBeforeKw": round(measured_before[0], 2) if measured_before else None,
        "iterations": iterations,
        "converged": converged,
        "loads": len(scales),
    }


def bake(circuit: Circuit, allocation_id: str) -> dict[str, Any]:
    """The parameter overrides that write a stored allocation's scaling into
    its loads (kW, and kvar when it has a kvar factor); applying them and
    removing the allocation leaves the solve unchanged."""
    spec = next((a for a in circuit.allocations or [] if a.id == allocation_id), None)
    if spec is None or spec.lastFactor is None:
        return {"ok": False, "error": "That allocation has not been run."}
    scales, _ = allocations.multipliers(circuit, only=spec)
    nodes = {n.id: n for n in circuit.nodes}
    overrides: dict[str, dict[str, Any]] = {}
    for lid, sc in scales.items():
        p = nodes[lid].params
        kw = float(p.get("kw", 0) or 0)
        patch: dict[str, Any] = {"kw": round(kw * sc.kw, 4)}
        if abs(sc.kvar - sc.kw) > 1e-12:
            pf = float(p.get("pf", 0.95) or 0.95)
            kvar = kw * math.tan(math.acos(min(abs(pf), 1.0))) * sc.kvar
            patch["pf"] = round(math.cos(math.atan2(kvar, kw * sc.kw)), 5) if kw else pf
        overrides[lid] = patch
    return {"ok": True, "overrides": overrides}
