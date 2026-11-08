"""Scenarios: a base circuit plus element-level deltas.

A scenario stores what differs from the base -- parameter overrides on
existing elements, elements added, elements removed -- and `apply_scenario`
builds the circuit the engine should see. The frontend keeps the same
representation (`lib/scenarios.ts`) and computes deltas by diffing the
drawing against the base; this is the server-side half, so a batch run or
a hosted study can build every alternative from one uploaded document.

`compile_circuit` applies the circuit's own active scenario, so every
route -- solve, fault, time series, export -- sees the effective circuit
without knowing scenarios exist.
"""
from __future__ import annotations

from .model import RATED_LEVEL, Circuit, LoadLevel, Scenario


def level_named(circuit: Circuit, name: str | None) -> LoadLevel:
    """The load level called `name`, or the implicit rated level when the
    name is None or unknown."""
    if name and circuit.loadLevels:
        for lvl in circuit.loadLevels:
            if lvl.name == name:
                return lvl
    return RATED_LEVEL


def _patched(params: dict, patch: dict) -> dict:
    out = dict(params)
    for key, value in patch.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = value
    return out


def apply_scenario(circuit: Circuit, scenario: Scenario | None) -> Circuit:
    """The effective circuit: the base with the scenario's deltas applied.
    Returns the circuit itself when there is no scenario, and a new Circuit
    otherwise; the base is never mutated. The result carries no active
    scenario, so applying twice is harmless."""
    if scenario is None:
        return circuit
    removed = set(scenario.removed)
    nodes = []
    for n in circuit.nodes:
        if n.id in removed:
            continue
        patch = scenario.overrides.get(n.id)
        if patch:
            n = n.model_copy(update={"params": _patched(n.params, patch)})
        nodes.append(n)
    kept_ids = {n.id for n in nodes}
    edges = []
    for e in circuit.edges:
        if e.id in removed or e.source in removed or e.target in removed:
            continue
        patch = scenario.overrides.get(e.id)
        if patch:
            e = e.model_copy(update={"params": _patched(e.params, patch)})
        edges.append(e)
    # Additions: nodes first so their edges have ends to land on. Ids are
    # expected to be fresh; a clash is resolved in the base's favour.
    for n in scenario.addedNodes:
        if n.id not in kept_ids:
            nodes.append(n)
            kept_ids.add(n.id)
    edge_ids = {e.id for e in edges}
    for e in scenario.addedEdges:
        if e.id in edge_ids or e.source not in kept_ids or e.target not in kept_ids:
            continue
        edges.append(e)
        edge_ids.add(e.id)
    return circuit.model_copy(update={
        "nodes": nodes, "edges": edges, "activeScenario": None})


def effective_circuit(circuit: Circuit, scenario_id: str | None = None,
                      level: str | None = None) -> Circuit:
    """The circuit a solve should see: the named scenario applied (the
    circuit's own active scenario when `scenario_id` is None), at the
    named load level (the circuit's own when `level` is None)."""
    chosen = None
    wanted = scenario_id if scenario_id is not None else circuit.activeScenario
    if wanted and circuit.scenarios:
        chosen = next((s for s in circuit.scenarios if s.id == wanted), None)
    out = apply_scenario(circuit, chosen)
    active = level if level is not None else circuit.activeLevel
    if active != out.activeLevel or out is circuit:
        out = out.model_copy(update={"activeLevel": active, "activeScenario": None})
    return out
