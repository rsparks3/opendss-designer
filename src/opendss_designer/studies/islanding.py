"""Loss of utility: islands, what carries them, and what goes dark.

The engine approach (OPENDSS_DESIGNER_DEV_PLAN.md 1.3): a generator in
*isochronous* mode is compiled as a `Vsource` at its terminal (the compiler
does that), so an island holding one solves like any circuit; a part of the
circuit with no source at all solves to zero volts. This module reads a
solve back by island: served and unserved load by priority, each source's
loading against its rating, and the voltage range.
"""
from __future__ import annotations

from typing import Any

from ..core import trace
from ..core.model import Circuit, CircuitNode, LoadLevel, in_service

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
