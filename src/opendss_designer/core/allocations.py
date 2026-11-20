"""Metered-zone load allocation, as the compiler applies it.

An allocation (`Circuit.allocations`, facility plan 1.4) names a meter
point -- a series element or a source -- and the factor a run found to make
the solved power there agree with a measurement. Its *zone* is everything
downstream of the meter (core/trace), judged on the base drawing so the
load basis does not move when a scenario opens a breaker or loses the
utility. Every load in the zone that is not `fixed` has its kW multiplied
by the allocation's demand factor (by priority or tag, the product of
those that match) times its stored factor; a kvar factor, when a kvar or
PF target was given, scales its reactive power the same way.

The loads keep the values entered; *Bake* writes the product into them
and removes the allocation. Two zones that share a load are not allowed:
the second is skipped, with an issue.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import trace
from .model import Allocation, Circuit, Issue, in_service


@dataclass(frozen=True)
class LoadScale:
    kw: float
    kvar: float  # 1.0 leaves the power factor as entered
    allocation: str


def zone_loads(topo: trace.Topology, meter_id: str) -> list[str]:
    """The loads below a meter point, `fixed` ones included."""
    if meter_id not in topo.element_buses:
        return []
    d = trace.downstream(topo, meter_id)
    return [r["id"] for r in d["loads"]["rows"]]


def demand_factor(params: dict, factors: dict[str, float] | None) -> float:
    if not factors:
        return 1.0
    keys = {trace.priority_of(params)} | {
        str(t) for t in params.get("tags") or [] if isinstance(t, str)}
    out = 1.0
    for k, f in factors.items():
        if k in keys:
            out *= f
    return out


def multipliers(circuit: Circuit, only: Allocation | None = None
                ) -> tuple[dict[str, LoadScale], list[Issue]]:
    """Load id -> how its power is scaled, for every stored allocation (or
    just `only`, with whatever factor it carries). `circuit` is the base:
    no scenario applied."""
    allocations = [only] if only is not None else list(circuit.allocations or [])
    if not allocations:
        return {}, []
    topo = trace.build(circuit.model_copy(update={"activeScenario": None}))
    out: dict[str, LoadScale] = {}
    issues: list[Issue] = []
    for a in allocations:
        if a.lastFactor is None and only is None:
            continue
        loads = zone_loads(topo, a.meterElementId)
        if not loads:
            issues.append(Issue(
                severity="warning", code="allocation-empty",
                message=f"Allocation {a.id}: nothing below its meter point "
                        f"'{a.meterElementId}' to scale.",
                nodeId=a.meterElementId if a.meterElementId in topo.nodes else None))
            continue
        if any(lid in out for lid in loads):
            issues.append(Issue(
                severity="warning", code="allocation-overlap",
                message=f"Allocation {a.id} shares loads with another allocation's zone and "
                        "was not applied: zones must not overlap.",
                nodeId=a.meterElementId if a.meterElementId in topo.nodes else None))
            continue
        factor = a.lastFactor if a.lastFactor is not None else 1.0
        kvar = a.lastKvarFactor if a.lastKvarFactor is not None else 1.0
        for lid in loads:
            p = topo.nodes[lid].params
            if p.get("fixed") is True or not in_service(p):
                continue
            df = demand_factor(p, a.demandFactors)
            out[lid] = LoadScale(kw=df * factor, kvar=df * factor * kvar, allocation=a.id)
    return out, issues


def overlapping(circuit: Circuit, candidate: Allocation) -> list[str]:
    """Ids of stored allocations (other than the candidate) whose zones share
    a load with the candidate's."""
    topo = trace.build(circuit.model_copy(update={"activeScenario": None}))
    mine = set(zone_loads(topo, candidate.meterElementId))
    return [a.id for a in circuit.allocations or []
            if a.id != candidate.id and mine & set(zone_loads(topo, a.meterElementId))]
