"""Capacity headroom: how much more each rated element can carry, and what
limits it first (facility plan 2.2).

For every rated element -- transformers, regulators, lines and switches
with an ampere rating, a utility service with a *Service capacity*, an
isochronous generator -- at each load level:

* **thermal**: the rating (the level's normal or emergency one, as kVA:
  phases x kV line-to-neutral x amps), the loading the solve gives, and the
  spare kVA left before 100 %. The spare kW is that at the element's own
  power factor (0.95 when it carries nothing).
* **voltage**: one trial load at the element's load-side bus gives how fast
  the lowest voltage falls per kW there; the kW that would take a bus to
  the lower limit follows by linear extrapolation (the sensitivity method of
  the hosting-capacity study). A bus already below the limit does not count.

The smaller of the two is the headroom, and that is the limit reported.
Growth years are load levels (Project -> Load levels -> Add growth levels),
so headroom per year is one column per level.

For one bus, exactly, the right-click *Find maximum load here* runs the
hosting-capacity load search instead.
"""
from __future__ import annotations

import math
import threading
from collections.abc import Callable
from typing import Any

import opendssdirect as dss

from ..core import engine
from ..core.compiler import CompileResult, compile_circuit, generator_rating_kva
from ..core.model import Circuit, Issue, in_service
from ..core.validate import limit_issues
from .scenarios import effective_circuit

Progress = Callable[[int, int, str | None], None]

PERTURB_KW = 100.0
DEFAULT_PF = 0.95
DARK_PU = 0.05
SERIES = ("transformer", "regulator", "breaker", "fuse", "recloser", "relay")


def _levels(circuit: Circuit, wanted: list[str] | None) -> list[str | None]:
    names = [lv.name for lv in circuit.loadLevels or []]
    if wanted:
        picked = [w for w in wanted if w in names]
        if picked:
            return list(picked)
    return list(names) or [None]


def estimate_solves(circuit: Circuit, raw: dict[str, Any] | None = None) -> int:
    opts = raw or {}
    n_levels = len(_levels(circuit, opts.get("levels")))
    rated = sum(1 for n in circuit.nodes if n.type in SERIES + ("vsource", "generator"))
    rated += sum(1 for e in circuit.edges if e.type == "line")
    per_level = 1 + (rated if opts.get("voltage", True) else 0)
    return n_levels * per_level


def headroom(
    circuit: Circuit,
    raw_options: dict[str, Any] | None = None,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    opts = {"levels": None, "voltage": True, **(raw_options or {})}
    levels = _levels(circuit, opts["levels"])
    out_rows: dict[str, dict[str, Any]] = {}
    issues: list[dict[str, Any]] = []
    done_levels: list[dict[str, Any]] = []
    for i, name in enumerate(levels):
        if cancel is not None and cancel.is_set():
            break
        case = effective_circuit(circuit, level=name)
        res = _one_level(case, bool(opts["voltage"]), cancel)
        issues += [x for x in res["issues"] if x not in issues]
        if not res["converged"]:
            continue
        lv = case.level
        done_levels.append({"name": lv.name, "loadmult": lv.loadmult, "rating": lv.rating})
        for rid, row in res["rows"].items():
            base = out_rows.setdefault(rid, {k: row[k] for k in ("id", "name", "kind", "phases")})
            base.setdefault("levels", {})[lv.name] = {
                k: row[k] for k in row if k not in ("id", "name", "kind", "phases")}
        if progress is not None:
            progress(i + 1, len(levels), lv.name)
    rows = list(out_rows.values())
    first = done_levels[0]["name"] if done_levels else None

    def spare(r: dict[str, Any]) -> float:
        cell = r["levels"].get(first) if first else None
        return cell["headroomKva"] if cell and cell["headroomKva"] is not None else math.inf

    rows.sort(key=spare)
    return {
        "converged": bool(done_levels),
        "cancelled": bool(cancel is not None and cancel.is_set()),
        "levels": done_levels,
        "rows": rows,
        "voltage": bool(opts["voltage"]),
        "issues": issues,
        "scenario": circuit.activeScenario,
    }


def _build(case: Circuit) -> tuple[CompileResult, list[Issue], bool]:
    compiled = compile_circuit(case, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(case) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return compiled, issues, False
    engine._ensure_init()
    engine._write_aux_files(compiled)
    ok = engine._run_commands(compiled.commands, compiled.element_map, issues,
                              compiled.optional_commands)
    if ok:
        dss.Text.Command("set mode=snapshot")
    return compiled, issues, ok


def _bus_lows() -> dict[str, float]:
    lows: dict[str, float] = {}
    for node, mag in zip(dss.Circuit.AllNodeNames(), dss.Circuit.AllBusMagPu(), strict=False):
        b = node.split(".", 1)[0].lower()
        lows[b] = min(lows.get(b, math.inf), mag)
    return lows


def _place_probe(bus: str, kw: float) -> None:
    dss.Circuit.SetActiveBus(bus)
    nodes = [int(n) for n in dss.Bus.Nodes() if 1 <= int(n) <= 3]
    kv_ln = dss.Bus.kVBase() or 7.2
    if len(nodes) >= 3:
        spec, phases, kv = f"{bus}.1.2.3", 3, kv_ln * math.sqrt(3)
    else:
        spec, phases, kv = f"{bus}.{nodes[0] if nodes else 1}", 1, kv_ln
    dss.Text.Command(
        f"edit load.hr_probe bus1={spec} phases={phases} kv={kv:.6g} kw={kw:.6g} "
        f"pf={DEFAULT_PF} model=1 vminpu=0.7 enabled=yes")


@engine.on_engine_thread
def _one_level(case: Circuit, voltage: bool, cancel: threading.Event | None) -> dict[str, Any]:
    by_id = {n.id: n for n in case.nodes}
    edge_ids = {e.id for e in case.edges if e.type == "line"}
    vmin = case.criteria.vminPu
    rating = case.level.rating
    with engine.dss_guard():
        compiled, issues, ok = _build(case)
        if not ok:
            return {"converged": False, "rows": {}, "issues": [i.model_dump() for i in issues]}
        dss.Solution.Solve()
        if not dss.Solution.Converged():
            issues.append(Issue(severity="error", code="not-converged",
                                message=f"Level {case.level.name}: the case does not converge."))
            return {"converged": False, "rows": {}, "issues": [i.model_dump() for i in issues]}
        base_low = _bus_lows()
        rows: dict[str, dict[str, Any]] = {}
        for full, ref in compiled.element_map.items():
            node = by_id.get(ref)
            kind = node.type if node is not None else ("line" if ref in edge_ids else None)
            if kind is None or ref in rows:
                continue
            params = node.params if node is not None else next(
                e.params for e in case.edges if e.id == ref)
            if not in_service(params):
                continue
            prefix = full.split(".", 1)[0]
            if kind in ("line",) + SERIES and prefix not in ("line", "transformer"):
                continue
            if kind == "vsource" and not (_pos(params.get("kva"))):
                continue
            if kind == "generator" and prefix != "vsource":
                continue  # a grid-mode unit is a source of power, not of capacity
            if kind not in ("line", "vsource", "generator") + SERIES:
                continue
            row = _thermal_row(full, ref, kind, params, rating)
            if row is not None:
                rows[ref] = row
        # Voltage: one trial load per load-side bus, shared by every element there.
        sens: dict[str, float | None] = {}
        if voltage and rows:
            first_bus = next(iter(base_low))
            dss.Text.Command(f"new load.hr_probe bus1={first_bus} phases=3 kv=12.47 kw=0 "
                             "pf=0.95 model=1 enabled=no")
            for row in rows.values():
                if cancel is not None and cancel.is_set():
                    break
                bus = row.pop("_bus")
                if bus not in sens:
                    sens[bus] = _voltage_kw(bus, base_low, vmin)
                row["voltageKw"] = sens[bus]
            dss.Text.Command("load.hr_probe.enabled=no")
        for row in rows.values():
            row.pop("_bus", None)
            row.setdefault("voltageKw", None)
            _limit(row)
    return {"converged": True, "rows": rows, "issues": [i.model_dump() for i in issues]}


def _pos(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def _thermal_row(full: str, ref: str, kind: str, params: dict[str, Any],
                 rating: str) -> dict[str, Any] | None:
    dss.Circuit.SetActiveElement(full)
    if not dss.CktElement.Enabled():
        return None
    nphases = dss.CktElement.NumPhases()
    ncond = dss.CktElement.NumConductors()
    powers = dss.CktElement.Powers()
    kw1 = sum(powers[0:2 * ncond:2])
    kvar1 = sum(powers[1:2 * ncond:2])
    kva_now = math.hypot(kw1, kvar1)
    buses = [b.split(".", 1)[0].lower() for b in dss.CktElement.BusNames()]
    if kind in ("vsource", "generator"):
        rating_kva = (_pos(params.get("kva")) if kind == "vsource"
                      else generator_rating_kva(params))
        if not rating_kva:
            return None
        load_bus = buses[0]
        loading = 100.0 * kva_now / rating_kva
    else:
        amps = dss.CktElement.NormalAmps()
        if rating == "emergency":
            amps = dss.CktElement.EmergAmps() or amps
        if not amps or amps <= 0:
            return None
        dss.Circuit.SetActiveBus(buses[0])
        kv_ln = dss.Bus.kVBase()
        dss.Circuit.SetActiveElement(full)
        if not kv_ln:
            return None
        rating_kva = nphases * kv_ln * amps
        currents = dss.CktElement.CurrentsMagAng()[0:2 * nphases:2]
        loading = 100.0 * max(currents or [0.0]) / amps
        # Power entering terminal 1 flows out at terminal 2: that is the load side.
        load_bus = buses[1] if kw1 >= 0 and len(buses) > 1 else buses[0]
    pf = abs(kw1) / kva_now if kva_now > 1e-3 else DEFAULT_PF
    spare_kva = rating_kva * (1.0 - loading / 100.0)
    return {
        "id": ref,
        "name": str(params.get("name") or ref),
        "kind": kind,
        "phases": nphases,
        "ratingKva": round(rating_kva, 1),
        "kva": round(kva_now, 1),
        "loadingPct": round(loading, 1),
        "pf": round(pf, 3),
        "spareKva": round(spare_kva, 1),
        "spareKw": round(spare_kva * pf, 1),
        "_bus": load_bus,
    }


def _voltage_kw(bus: str, base_low: dict[str, float], vmin: float) -> float | None:
    """kW of new load at `bus` that takes the first bus to `vmin`, by linear
    extrapolation from one trial; None when nothing falls toward the limit."""
    try:
        _place_probe(bus, PERTURB_KW)
    except Exception:
        return None
    dss.Solution.Solve()
    ok = dss.Solution.Converged()
    low = _bus_lows() if ok else {}
    dss.Text.Command("load.hr_probe.enabled=no")
    if not ok:
        return None
    best: float | None = None
    for b, v0 in base_low.items():
        if v0 < vmin or v0 < DARK_PU:
            continue  # already past the limit, or dark: not this element's to answer
        v1 = low.get(b)
        if v1 is None:
            continue
        drop = (v0 - v1) / PERTURB_KW
        if drop <= 1e-7:
            continue
        kw = (v0 - vmin) / drop
        best = kw if best is None else min(best, kw)
    return round(best, 1) if best is not None else None


def _limit(row: dict[str, Any]) -> None:
    thermal_kw = row["spareKw"]
    volt_kw = row["voltageKw"]
    if volt_kw is not None and volt_kw < thermal_kw:
        row["limit"] = "voltage"
        row["headroomKw"] = volt_kw
        row["headroomKva"] = round(volt_kw / (row["pf"] or DEFAULT_PF), 1)
    else:
        row["limit"] = "thermal"
        row["headroomKw"] = thermal_kw
        row["headroomKva"] = row["spareKva"]
