"""Loss of utility: islands, what carries them, and what goes dark.

The engine approach (OPENDSS_DESIGNER_DEV_PLAN.md 1.3): a generator in
*isochronous* mode is compiled as a `Vsource` at its terminal (the compiler
does that), so an island holding one solves like any circuit; a part of the
circuit with no source at all solves to zero volts. This module reads a
solve back by island: served and unserved load by priority, each source's
loading against its rating, and the voltage range.
"""
from __future__ import annotations

import math
from typing import Any

from ..core import engine, trace
from ..core.compiler import generator_rating_kva
from ..core.model import Circuit, CircuitNode, LoadLevel, in_service
from .scenarios import effective_circuit

DARK_PU = 0.05
PRIORITIES = trace.PRIORITIES


def demand_kw(node: CircuitNode, level: LoadLevel, factor: float = 1.0) -> float:
    """What a load asks for at a load level: its kW times the level's
    multiplier and its class multiplier (as the compiler applies them)."""
    p = node.params
    if not in_service(p):
        return 0.0
    try:
        kw = float(p.get("kw", 0) or 0)
    except (TypeError, ValueError):
        return 0.0
    cls = str(p.get("class") or "").strip().lower()
    mult = 1.0
    if cls:
        mult = next((m for c, m in level.classMult.items() if c.strip().lower() == cls), 1.0)
    return kw * level.loadmult * mult * factor


def _bus_is_dark(result: dict[str, Any], bus: str) -> bool:
    b = (result.get("buses") or {}).get(bus)
    if not b:
        return True
    vmax = b.get("vmaxPu")
    return vmax is None or vmax < DARK_PU


def unserved_by_priority(case: Circuit, result: dict[str, Any],
                         factors: dict[str, float] | None = None) -> dict[str, float]:
    """kW of load on buses the solve left dark, by priority. `case` is the
    effective circuit that was solved (scenario and level applied)."""
    out = {k: 0.0 for k in PRIORITIES}
    if not result.get("converged"):
        return out
    node_buses = result.get("nodeBuses") or {}
    level = case.level
    for n in case.nodes:
        if n.type != "load":
            continue
        buses = node_buses.get(n.id) or []
        if buses and _bus_is_dark(result, buses[0]):
            out[trace.priority_of(n.params)] += demand_kw(n, level, (factors or {}).get(n.id, 1.0))
    return {k: round(v, 3) for k, v in out.items()}


def _source_row(node: CircuitNode, el: dict[str, Any] | None) -> dict[str, Any]:
    p = node.params
    kw = -(el or {}).get("kw", 0.0) if el else 0.0
    kvar = -(el or {}).get("kvar", 0.0) if el else 0.0
    row: dict[str, Any] = {
        "id": node.id,
        "name": str(p.get("name") or node.id),
        "kind": "generator" if node.type == "generator" else str(p.get("kind") or "utility"),
        "kw": round(kw, 1),
        "kvar": round(kvar, 1),
        "kva": round(math.hypot(kw, kvar), 1),
        "ratingKva": None,
        "loadingPct": None,
        "fuelHours": p.get("fuelHours"),
    }
    if node.type == "generator":
        rating = generator_rating_kva(p)
        row["ratingKva"] = round(rating, 1)
        row["loadingPct"] = round(100.0 * row["kva"] / rating, 1) if rating > 0 else None
    return row


def island_summary(case: Circuit, result: dict[str, Any]) -> dict[str, Any]:
    """The solve read back island by island. `case` is the effective circuit
    that was solved (scenario and level applied).

    Each island with a load or a source in it: its sources with what they
    carry (a generator's loading against its rating), the load it serves,
    its voltage range, and -- for one no source reaches -- the load left
    dark, by priority. Then the dark load of the whole circuit."""
    topo = trace.build(case)
    level = case.level
    elements_by_id = {e.get("id"): e for e in (result.get("elements") or {}).values()
                      if e.get("id")}
    buses = result.get("buses") or {}
    loads_at: dict[str, list[CircuitNode]] = {}
    for n in case.nodes:
        if n.type == "load" and (bs := topo.element_buses.get(n.id)):
            loads_at.setdefault(bs[0], []).append(n)
    islands: list[dict[str, Any]] = []
    total_unserved = {k: 0.0 for k in PRIORITIES}
    dark_loads: list[dict[str, Any]] = []
    for part in trace.islands(topo):
        part_buses = part["buses"]
        loads = [ld for b in part_buses for ld in loads_at.get(b, [])]
        if not loads and not part["sources"]:
            continue
        served_kw = served_kvar = 0.0
        unserved = {k: 0.0 for k in PRIORITIES}
        for ld in loads:
            bus = topo.element_buses[ld.id][0]
            if part["energized"] and result.get("converged") and not _bus_is_dark(result, bus):
                el = elements_by_id.get(ld.id) or {}
                served_kw += el.get("kw", 0.0)
                served_kvar += el.get("kvar", 0.0)
            else:
                kw = demand_kw(ld, level)
                pr = trace.priority_of(ld.params)
                unserved[pr] += kw
                total_unserved[pr] += kw
                dark_loads.append({"id": ld.id, "name": str(ld.params.get("name") or ld.id),
                                   "priority": pr, "kw": round(kw, 1),
                                   "building": str(ld.params.get("building") or "")})
        volts = [(b["vminPu"], b["vmaxPu"]) for name in part_buses
                 if (b := buses.get(name)) and b.get("vmaxPu") and b["vmaxPu"] >= DARK_PU]
        sources = [_source_row(topo.nodes[sid], elements_by_id.get(sid)) for sid in part["sources"]]
        overloaded = any((s["loadingPct"] or 0) > 100 for s in sources)
        islands.append({
            "energized": part["energized"],
            "sources": sources,
            "loadCount": len(loads),
            "busCount": len(part_buses),
            "servedKw": round(served_kw, 1),
            "servedKvar": round(served_kvar, 1),
            "vminPu": round(min(v[0] for v in volts), 4) if volts else None,
            "vmaxPu": round(max(v[1] for v in volts), 4) if volts else None,
            "unservedKw": {k: round(v, 1) for k, v in unserved.items()},
            # Red on the card: a source past its rating, or critical load dark.
            "alarm": overloaded or unserved["critical"] > 0,
            "multipleSources": len(sources) > 1,
        })
    # Energized islands first (the utility's before the generators'), dark last.
    islands.sort(key=lambda i: (not i["energized"],
                                not any(s["kind"] == "utility" for s in i["sources"]),
                                -i["servedKw"]))
    for idx, isl in enumerate(islands):
        isl["index"] = idx
    order = {k: i for i, k in enumerate(PRIORITIES)}
    dark_loads.sort(key=lambda r: (order[r["priority"]], -r["kw"]))
    return {
        "islands": islands,
        "unservedKw": {k: round(v, 1) for k, v in total_unserved.items()},
        "unservedLoads": dark_loads,
        "energizedCount": sum(1 for i in islands if i["energized"]),
    }


def solve_with_islands(circuit: Circuit) -> dict[str, Any]:
    """A snapshot solve with its island summary attached (`islands`)."""
    result = engine.solve(circuit)
    if result.get("converged"):
        result["islands"] = island_summary(effective_circuit(circuit), result)
    return result


def topology_islands(circuit: Circuit) -> dict[str, Any]:
    """The islands the drawing forms, without a solve: each one's buses,
    sources, and loads by priority; the dark ones are what no source reaches."""
    case = effective_circuit(circuit)
    topo = trace.build(case)
    loads_at: dict[str, list[str]] = {}
    for n in case.nodes:
        if n.type == "load" and (bs := topo.element_buses.get(n.id)):
            loads_at.setdefault(bs[0], []).append(n.id)
    out = []
    for part in trace.islands(topo):
        loads = [lid for b in part["buses"] for lid in loads_at.get(b, [])]
        if not loads and not part["sources"]:
            continue
        out.append({**part, "loads": trace.summarize_loads(topo, loads)})
    out.sort(key=lambda i: not i["energized"])
    unserved = [i["loads"] for i in out if not i["energized"]]
    return {
        "islands": out,
        "unservedKw": {k: round(sum(u["byPriority"][k]["kw"] for u in unserved), 3)
                       for k in PRIORITIES},
    }
