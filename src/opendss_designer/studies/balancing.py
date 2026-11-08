"""Phase balancing: how unbalanced the feeder is, and which single-phase
laterals to move to another phase.

Unbalance is measured two ways, because the industry uses both: the
**current** unbalance at the feeder head (the largest deviation of a phase
current from the mean, as a share of the mean -- the NEMA definition
applied to current) and the **voltage** unbalance at every three-phase
bus (largest deviation of a phase-to-neutral magnitude from the mean, as
a share of the mean; the NEMA line-to-line figure is within a fraction of
a per cent of it on a distribution feeder).

A lateral is a connected run of single-phase elements hanging off a
three-phase bus; moving it means re-pinning every element in it to the
new phase, which changes the bus nodes the compiler writes, so each
candidate is a rebuild and a solve (the move cannot be an `edit`).
"""
from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

from ..core import engine
from ..core.connectivity import synthesize
from ..core.model import Circuit, conducts, in_service
from ..core.phasing import parse_phasing
from .scenarios import effective_circuit

Progress = Callable[[int, int, str | None], None]
PHASES = ("A", "B", "C")


def unbalance_pct(values: list[float]) -> float | None:
    vals = [v for v in values if v is not None]
    if len(vals) < 2:
        return None
    mean = sum(vals) / len(vals)
    if mean <= 1e-9:
        return None
    return 100.0 * max(abs(v - mean) for v in vals) / mean


def _letters(params: dict) -> str:
    """The phase an element is pinned to, or "A" (the first phase) when not."""
    parsed = parse_phasing(params.get("phasing"))
    return parsed or "A"


def laterals(circuit: Circuit) -> list[dict[str, Any]]:
    """Connected groups of single-phase elements, each hanging off a
    three-phase bus, with the elements (node and edge ids) in them."""
    conn = synthesize(circuit)
    single_nodes = {n.id: n for n in circuit.nodes
                    if n.type not in ("busbar", "vsource", "note", "zone")
                    and int(float(n.params.get("phases", 3) or 3)) == 1 and in_service(n.params)}
    single_edges = {e.id: e for e in circuit.edges
                    if e.type == "line" and int(float(e.params.get("phases", 3) or 3)) == 1 and in_service(e.params)}
    # Which buses the single-phase elements touch; a bus touched by any
    # three-phase element is a "root" (where the lateral taps off).
    three_phase_buses: set[str] = set()
    for n in circuit.nodes:
        if n.id in conn.node_buses and n.id not in single_nodes and n.type not in ("busbar", "note", "zone"):
            if int(float(n.params.get("phases", 3) or 3)) >= 2:
                three_phase_buses.update(b.lower() for b in conn.node_buses[n.id])
    for e in circuit.edges:
        if e.type == "line" and e.id not in single_edges and e.id in conn.line_buses:
            three_phase_buses.update(b.lower() for b in conn.line_buses[e.id])
    # Union single-phase elements through the buses they share, not
    # through three-phase buses.
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        parent[find(a)] = find(b)

    bus_members: dict[str, list[str]] = {}
    member_buses: dict[str, list[str]] = {}
    for nid in single_nodes:
        buses = [b.lower() for b in conn.node_buses.get(nid, [])]
        member_buses[nid] = buses
        for b in buses:
            bus_members.setdefault(b, []).append(nid)
    for eid in single_edges:
        buses = [b.lower() for b in conn.line_buses.get(eid, ())]
        member_buses[eid] = buses
        for b in buses:
            bus_members.setdefault(b, []).append(eid)
    for b, members in bus_members.items():
        if b in three_phase_buses:
            continue
        for m in members[1:]:
            union(members[0], m)
    groups: dict[str, list[str]] = {}
    for m in member_buses:
        groups.setdefault(find(m), []).append(m)
    out = []
    for members in groups.values():
        roots = sorted({b for m in members for b in member_buses[m] if b in three_phase_buses})
        load_kw = 0.0
        for m in members:
            n = single_nodes.get(m)
            if n is not None and n.type == "load":
                try:
                    load_kw += float(n.params.get("kw", 100.0))
                except (TypeError, ValueError):
                    load_kw += 100.0
        phase = _letters((single_nodes.get(members[0]) or single_edges.get(members[0])).params)
        name = next((str((single_nodes.get(m) or single_edges.get(m)).params.get("name") or m) for m in members
                     if m in single_edges), None) or str((single_nodes.get(members[0])).params.get("name") or members[0])
        out.append({"id": members[0], "name": name, "members": sorted(members), "rootBuses": roots,
                    "phase": phase, "loadKw": round(load_kw, 1), "elements": len(members)})
    out.sort(key=lambda g: -g["loadKw"])
    return out


def _head_currents(result: dict[str, Any]) -> list[float] | None:
    src = result["elements"].get("vsource.source")
    if not src or len(src.get("currents", [])) < 2:
        return None
    return [float(a) for a in src["currents"][:3]]


def _measure(result: dict[str, Any]) -> dict[str, Any]:
    head = _head_currents(result)
    worst_v = None
    worst_bus = None
    for bus, b in result.get("buses", {}).items():
        mags = [m for m in b.get("vmagPu", []) if m > 0.05]
        if len(mags) >= 3:
            u = unbalance_pct(mags[:3])
            if u is not None and (worst_v is None or u > worst_v):
                worst_v, worst_bus = u, bus
    return {
        "headCurrentsA": [round(a, 1) for a in head] if head else None,
        "currentUnbalancePct": round(unbalance_pct(head), 2) if head else None,
        "voltageUnbalancePct": round(worst_v, 3) if worst_v is not None else None,
        "voltageUnbalanceBus": worst_bus,
        "lossKw": (result.get("losses") or {}).get("kw"),
    }


def phase_balance(circuit: Circuit, max_candidates: int = 40,
                  progress: Progress | None = None, cancel: threading.Event | None = None) -> dict[str, Any]:
    """The feeder's unbalance, and every single-phase lateral tried on each
    other phase: resulting head unbalance, losses and worst voltage
    unbalance, ranked by the improvement."""
    circuit = effective_circuit(circuit)
    base = engine.solve(circuit)
    if not base.get("converged"):
        return {"converged": False, "issues": base.get("issues", []), "candidates": []}
    measured = _measure(base)
    groups = laterals(circuit)[: max(1, int(max_candidates))]
    rows: list[dict[str, Any]] = []
    total = len(groups) * 2
    done = 0
    cancelled = False
    solves = 1
    for g in groups:
        for target in PHASES:
            if target == g["phase"]:
                continue
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            trial = _repinned(circuit, g["members"], target)
            r = engine.solve(trial)
            solves += 1
            done += 1
            if r.get("converged"):
                m = _measure(r)
                rows.append({
                    "lateral": g["id"], "name": g["name"], "loadKw": g["loadKw"], "elements": g["elements"],
                    "fromPhase": g["phase"], "toPhase": target,
                    **m,
                    "currentImprovementPct": (round(measured["currentUnbalancePct"] - m["currentUnbalancePct"], 2)
                                              if measured["currentUnbalancePct"] is not None and m["currentUnbalancePct"] is not None else None),
                    "lossChangeKw": (round(m["lossKw"] - measured["lossKw"], 3)
                                     if m["lossKw"] is not None and measured["lossKw"] is not None else None),
                    "overrides": {mid: {"phasing": target} for mid in g["members"]},
                })
            if progress is not None:
                progress(done, total, f"{g['name']} to {target}")
        if cancelled:
            break
    rows.sort(key=lambda r: -(r["currentImprovementPct"] or -1e9))
    return {
        "converged": True, "cancelled": cancelled,
        "base": measured,
        "laterals": [{k: v for k, v in g.items() if k != "members"} | {"members": len(g["members"])} for g in groups],
        "candidates": rows,
        "solves": solves,
        "loadLevel": circuit.level.model_dump(), "scenario": circuit.activeScenario,
        "issues": base.get("issues", []),
        "nodeBuses": base.get("nodeBuses", {}),
    }


def _repinned(circuit: Circuit, members: list[str], phase: str) -> Circuit:
    ids = set(members)
    nodes = [n.model_copy(update={"params": {**n.params, "phasing": phase}}) if n.id in ids else n
             for n in circuit.nodes]
    edges = [e.model_copy(update={"params": {**e.params, "phasing": phase}}) if e.id in ids else e
             for e in circuit.edges]
    return circuit.model_copy(update={"nodes": nodes, "edges": edges})
