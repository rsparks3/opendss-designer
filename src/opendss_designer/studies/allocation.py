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

from typing import Any

from ..core import engine
from ..core.model import Circuit, LoadShapeSpec
from .scenarios import effective_circuit

DEFAULT_LOAD_FACTOR = 0.5


def _key_of(node, key_by: str, conn_buses: dict[str, list[str]]) -> list[str]:
    p = node.params
    if key_by == "bus":
        return [b.lower() for b in conn_buses.get(node.id, [])]
    if key_by == "class":
        return [str(p.get("class") or "").strip().lower()]
    return [str(p.get("name") or node.id).strip().lower(), node.id.lower()]


def allocate(circuit: Circuit, rows: list[dict[str, Any]], options: dict[str, Any] | None = None) -> dict[str, Any]:
    """`rows`: [{"key": "...", "kwh": 123}] or [{"key": "...", "kw": 45}] or
    [{"key": "...", "values": [kw, kw, ...]}]. `options`: keyBy
    ('name'|'bus'|'class'), hours (period length for kWh), loadFactor
    (number, or {class: LF}), targetHeadKw, intervalMin, shapePrefix."""
    opts = {"keyBy": "name", "hours": 730.0, "loadFactor": DEFAULT_LOAD_FACTOR, "targetHeadKw": None,
            "intervalMin": 60, "shapePrefix": "ami"}
    opts.update({k: v for k, v in (options or {}).items() if k in opts})
    circuit = effective_circuit(circuit)
    from ..core.connectivity import synthesize
    conn = synthesize(circuit)
    loads = [n for n in circuit.nodes if n.type == "load" and n.params.get("enabled", True) is not False]
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
            entry: dict[str, Any] = {"id": n.id, "name": str(n.params.get("name") or n.id), "key": row.get("key")}
            values = row.get("values")
            if isinstance(values, list) and len(values) >= 2:
                vals = [float(v) for v in values if isinstance(v, (int, float))]
                peak = max(vals) if vals else 0.0
                if peak <= 0:
                    unmatched.append(str(row.get("key", "")))
                    continue
                shape_name = f"{opts['shapePrefix']}_{entry['name']}".replace(" ", "_")[:60]
                shapes[shape_name] = LoadShapeSpec(intervalMin=float(opts["intervalMin"]),
                                                   points=[round(v / peak, 5) for v in vals], source="ami")
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
        nodes = [nn.model_copy(update={"params": {**nn.params, **ovr[nn.id]}}) if nn.id in ovr else nn for nn in c.nodes]
        return c.model_copy(update={"nodes": nodes, "loadShapes": {**c.loadShapes, **shapes}})

    head_before = head_after = None
    scale = None
    base = engine.solve(circuit)
    if base.get("converged"):
        head_before = round(-sum(e["kw"] for f, e in base["elements"].items() if f.startswith("vsource.")), 1)
    allocated = apply(circuit, overrides)
    solved = engine.solve(allocated)
    if solved.get("converged"):
        head_after = round(-sum(e["kw"] for f, e in solved["elements"].items() if f.startswith("vsource.")), 1)
    target = opts["targetHeadKw"]
    if target is not None and head_after and float(target) > 0:
        # Two secant passes: losses move with the loads, so one ratio is not exact.
        scale = 1.0
        current = head_after
        for _ in range(2):
            scale *= float(target) / current
            scaled = {n.id: {**overrides.get(n.id, {}), "kw": round(float(overrides.get(n.id, {}).get("kw", n.params.get("kw", 0)) or 0) * scale, 3)}
                      for n in loads}
            trial = engine.solve(apply(circuit, scaled))
            if not trial.get("converged"):
                break
            current = -sum(e["kw"] for f, e in trial["elements"].items() if f.startswith("vsource."))
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
