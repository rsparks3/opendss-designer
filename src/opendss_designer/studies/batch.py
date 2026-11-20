"""Batch runs: every scenario at every load level, summarised as a matrix.

One snapshot solve per cell. Each cell records what a planner reads off a
load-flow summary -- worst voltage and where, worst loading and where,
losses, violation counts -- so ten alternatives at three load conditions
compare in one table instead of thirty overlays.
"""
from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

from ..core import engine
from ..core.model import RATED_LEVEL, Circuit
from .islanding import island_summary, unserved_by_priority
from .scenarios import effective_circuit

Progress = Callable[[int, int, str | None], None]


def cell_summary(result: dict[str, Any], limits) -> dict[str, Any]:
    """The headline numbers of one solved case."""
    buses = result.get("buses") or {}
    elements = result.get("elements") or {}
    vmin = min(((b["vminPu"], name) for name, b in buses.items()
                if b.get("vminPu") is not None and b["vminPu"] > 0.05), default=(None, None))
    vmax = max(((b["vmaxPu"], name) for name, b in buses.items()
                if b.get("vmaxPu") is not None), default=(None, None))
    loading = max(((e["loadingPct"], full) for full, e in elements.items()
                   if e.get("loadingPct") is not None), default=(None, None))
    under = sum(1 for b in buses.values()
                if b.get("vminPu") is not None and 0.05 < b["vminPu"] < limits.vminPu)
    over = sum(1 for b in buses.values()
               if b.get("vmaxPu") is not None and b["vmaxPu"] > limits.vmaxPu)
    overloads = sum(1 for e in elements.values()
                    if e.get("loadingPct") is not None and e["loadingPct"] >= limits.overloadPct)
    warnings = sum(1 for e in elements.values()
                   if e.get("loadingPct") is not None
                   and limits.warnPct <= e["loadingPct"] < limits.overloadPct)
    source_kw = -sum(e["kw"] for full, e in elements.items() if full.startswith("vsource."))
    losses = result.get("losses") or {}
    return {
        "converged": bool(result.get("converged")),
        "iterations": result.get("iterations"),
        "minVpu": vmin[0], "minVBus": vmin[1],
        "maxVpu": vmax[0], "maxVBus": vmax[1],
        "maxLoadingPct": loading[0], "maxLoadingElement": loading[1],
        "maxLoadingId": elements.get(loading[1], {}).get("id") if loading[1] else None,
        "lossKw": losses.get("kw"),
        "sourceKw": round(source_kw, 1) if elements else None,
        "undervoltages": under, "overvoltages": over,
        "overloads": overloads, "loadingWarnings": warnings,
    }


def cell_detail(case: Circuit, result: dict[str, Any]) -> dict[str, Any]:
    """Per-element numbers for the compare table: each bus's lowest voltage
    (pu, dark buses as 0), each series element's loading (keyed by diagram
    id), and the load left unserved by priority."""
    buses = {name: (round(b["vminPu"], 5) if b.get("vminPu") is not None else None)
             for name, b in (result.get("buses") or {}).items()}
    loading = {e["id"]: round(e["loadingPct"], 2) for e in (result.get("elements") or {}).values()
               if e.get("id") and e.get("loadingPct") is not None}
    return {"busVmin": buses, "loading": loading,
            "unservedKw": unserved_by_priority(case, result),
            "islands": island_summary(case, result) if result.get("converged") else None}


def run_batch(circuit: Circuit, scenario_ids: list[str | None] | None = None,
              level_names: list[str | None] | None = None,
              progress: Progress | None = None,
              cancel: threading.Event | None = None,
              detail: bool = True) -> dict[str, Any]:
    """Solve every (scenario, level) pair. `None` in either list is the base
    case or the rated level; both default to "everything the circuit has,
    base/rated included"."""
    if scenario_ids is None:
        scenario_ids = [None, *(s.id for s in circuit.scenarios or [])]
    if level_names is None:
        level_names = ([lvl.name for lvl in circuit.loadLevels]
                       if circuit.loadLevels else [None])
    scenario_names = {s.id: s.name for s in circuit.scenarios or []}
    cells: list[dict[str, Any]] = []
    total = len(scenario_ids) * len(level_names)
    done = 0
    cancelled = False
    for sid in scenario_ids:
        for lname in level_names:
            if cancel is not None and cancel.is_set():
                cancelled = True
                break
            # "" means no scenario at all (None would mean the circuit's own).
            case = effective_circuit(circuit, sid or "", lname)
            result = engine.solve(case)
            level = case.level if case.activeLevel else RATED_LEVEL
            cells.append({
                "scenario": sid, "scenarioName": scenario_names.get(sid, "Base case"),
                "level": lname, "levelName": level.name, "loadmult": level.loadmult,
                "rating": level.rating,
                **cell_summary(result, circuit.criteria),
                "detail": cell_detail(case, result) if detail else None,
                "errors": [i["message"] for i in result.get("issues", [])
                           if i.get("severity") == "error"][:3],
            })
            done += 1
            if progress is not None:
                progress(done, total, f"{scenario_names.get(sid, 'Base case')} at "
                                      f"{level.name}")
        if cancelled:
            break
    return {
        "cells": cells,
        "scenarios": [{"id": sid, "name": scenario_names.get(sid, "Base case")}
                      for sid in scenario_ids],
        "levels": level_names,
        "cancelled": cancelled,
        "solves": done,
    }
