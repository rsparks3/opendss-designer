"""Generator and battery sizing against an island (facility plan 2.3).

The island is whatever loses every source when an element opens (its
downstream set, `core/trace.py`), on the open scenario at the active level.
Its hourly profile over a day or a year comes from each load's own loadshape
(or one shape chosen for all of them) and, if asked, the PV in it (Pmpp x
irradiance x its irradiance shape, capped at the inverter rating; inverter
and temperature losses are left out, which errs toward a larger generator).

* **Generator:** the largest net load (load - PV) times (1 + reserve margin).
  The hours above 80 % of the size, the peak hour, and the fuel on hand of
  any generator already in the island against the run length.
* **Battery,** for a chosen generator size (or none). The generator runs up
  to its rating; the battery covers what is left and charges from any
  surplus. Energy = the largest drawdown of the running sum of
  (generator + PV - load), divided by the round-trip efficiency; power = the
  largest deficit, or the largest surplus if that is larger. When the day
  (or year) as a whole is short of energy the island cannot be carried
  indefinitely, and the result says when the battery would be empty rather
  than reporting a size that works once.
* **Reverse power:** an hour where PV exceeds the load and the battery
  cannot take the surplus would push power into the generator, which a real
  machine cannot absorb (the engine's isochronous source would, silently).
  Those hours are flagged: PV curtailment or more storage.
* **Verification** (daily): the island cut off at the element, every
  generator in it stopped, a new isochronous generator of the chosen size
  and a battery of the computed size following the computed dispatch, solved
  hour by hour: the battery's charge stays above its reserve, the generator
  stays within its rating and never takes reverse power.

No optimisation: a sizing calculator with a verification run.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Any

import opendssdirect as dss

from ..core import allocations, engine, trace
from ..core.compiler import CompileResult, _isochronous_source, compile_circuit
from ..core.model import Circuit, CircuitNode, Issue, LoadShapeSpec, in_service
from ..core.validate import limit_issues
from .islanding import demand_kw
from .scenarios import effective_circuit

GEN_PF = 0.8  # a standby set's kVA is its kW at 0.8 power factor
DEFAULTS: dict[str, Any] = {
    "elementId": None,
    "shape": None,  # one loadshape for every load in the island, or None for their own
    "mode": "daily",  # or "yearly"
    "marginPct": 20.0,
    "countPv": True,
    "generatorKw": None,  # for the battery; None = the generator size found
    "efficiencyPct": 90.0,  # battery round trip
    "reservePct": 20.0,  # battery charge never used
    "verify": True,
}


def _num(v: Any, default: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def hourly(spec: LoadShapeSpec | None, hours: int) -> list[float]:
    """A shape as one value per hour for `hours` hours: the mean of the points
    in each hour, a shorter shape repeating (as the engine wraps it). No
    shape is a flat 1."""
    if spec is None or not spec.points:
        return [1.0] * hours
    per_hour = max(1, round(60.0 / (spec.intervalMin or 60.0)))
    pts = spec.points
    n = len(pts)
    out = []
    for h in range(hours):
        vals = [pts[(h * per_hour + k) % n] for k in range(per_hour)]
        out.append(sum(vals) / len(vals))
    return out


def max_drawdown(series: list[float], cyclic: bool) -> tuple[float, int, int]:
    """The largest fall of the running sum of `series` from a high point to a
    later low one, over at most one pass of it -- the energy a store must hold
    to ride through it. A cyclic shape is run twice so a night that spans
    midnight counts whole, but no window is longer than one cycle (a short
    day would otherwise count two nights as one)."""
    n = len(series)
    seq = series + series if cyclic else series
    prefix = [0.0]
    for v in seq:
        prefix.append(prefix[-1] + v)
    window: deque[int] = deque()  # indexes into prefix, their values decreasing
    worst = (0.0, 0, 0)
    for j in range(len(prefix)):
        while window and window[0] < j - n:
            window.popleft()
        while window and prefix[window[-1]] <= prefix[j]:
            window.pop()
        window.append(j)
        top = window[0]
        fall = prefix[top] - prefix[j]
        if fall > worst[0]:
            worst = (fall, top, j)
    return worst


def size_backup(circuit: Circuit, raw: dict[str, Any] | None = None) -> dict[str, Any]:
    opts = {**DEFAULTS, **{k: v for k, v in (raw or {}).items() if k in DEFAULTS}}
    case = effective_circuit(circuit)
    issues: list[Issue] = []
    element_id = str(opts["elementId"] or "")
    topo = trace.build(case)
    if element_id not in topo.element_buses:
        return {"ok": False, "issues": [Issue(
            severity="error", code="unknown-element",
            message="Choose the device (or bus) whose downstream island to size for.",
        ).model_dump()]}
    down = trace.downstream(topo, element_id)
    buses = set(down["buses"])
    island_nodes = [topo.nodes[i] for i in down["nodeIds"]]
    loads = [n for n in island_nodes if n.type == "load" and in_service(n.params)]
    pvs = [n for n in island_nodes if n.type == "pvsystem" and in_service(n.params)]
    gens = [n for n in island_nodes if n.type == "generator"]
    if not loads:
        return {"ok": False, "issues": [Issue(
            severity="error", code="empty-island",
            message="Nothing with load is downstream of that element.").model_dump()]}

    hours = 24 if opts["mode"] == "daily" else 8760
    shapes = case.loadShapes or {}
    common = shapes.get(str(opts["shape"])) if opts["shape"] else None
    if opts["shape"] and common is None:
        issues.append(Issue(severity="warning", code="missing-loadshape",
                            message=f"Loadshape '{opts['shape']}' is not in the circuit; "
                                    "each load's own shape was used."))
    scales, _ = allocations.multipliers(case)
    load_kw = [0.0] * hours
    for ld in loads:
        scale = scales.get(ld.id)
        base = demand_kw(ld, case.level, scale.kw if scale else 1.0)
        spec = common or shapes.get(str(ld.params.get("loadshape") or ""))
        for h, m in enumerate(hourly(spec, hours)):
            load_kw[h] += base * m
    pv_kw = [0.0] * hours
    if opts["countPv"]:
        for pv in pvs:
            p = pv.params
            pmpp = _num(p.get("pmpp"), 500.0) * _num(p.get("irradiance"), 1.0)
            cap = _num(p.get("kva"), 500.0)
            spec = shapes.get(str(p.get("loadshape") or ""))
            for h, m in enumerate(hourly(spec, hours)):
                pv_kw[h] += min(cap, pmpp * m)
    net = [load_kw[h] - pv_kw[h] for h in range(hours)]

    margin = _num(opts["marginPct"], 20.0) / 100.0
    peak = max(net)
    peak_hour = net.index(peak)
    required = max(0.0, peak) * (1 + margin)
    gen_kw = _num(opts["generatorKw"], required) if opts["generatorKw"] not in (None, "") \
        else required
    gen_kw = max(0.0, gen_kw)
    above80 = sum(1 for v in net if gen_kw > 0 and v > 0.8 * gen_kw)

    eff = min(max(_num(opts["efficiencyPct"], 90.0), 10.0), 100.0) / 100.0
    reserve = min(max(_num(opts["reservePct"], 20.0), 0.0), 90.0) / 100.0
    # Battery: + surplus charges it, - deficit draws it.
    balance = [gen_kw - net[h] for h in range(hours)]
    deficit = max(0.0, -min(balance))
    surplus = max(0.0, max(balance))
    drawdown, dd_from, dd_to = max_drawdown(balance, cyclic=True)
    usable_kwh = drawdown / eff if drawdown > 1e-6 else 0.0
    batt_kwh = usable_kwh / (1 - reserve) if usable_kwh else 0.0
    batt_kw = max(deficit, surplus) if usable_kwh else 0.0
    # Energy over the whole run, charging at the round-trip efficiency.
    energy = sum(b * eff if b > 0 else b for b in balance)
    closes = energy >= -1e-6
    empties_after_h: float | None = None
    if not closes and usable_kwh > 0:
        per_hour_loss = -energy / hours
        empties_after_h = round(usable_kwh / per_hour_loss, 1)
    reverse_hours = [h for h in range(hours)
                     if net[h] < 0 and (batt_kw <= 0 or -net[h] > batt_kw)]
    if gen_kw > 0 and not usable_kwh:
        reverse_hours = [h for h in range(hours) if net[h] < 0]

    fuel = [{"id": g.id, "name": str(g.params.get("name") or g.id),
             "fuelHours": g.params.get("fuelHours")} for g in gens]
    result: dict[str, Any] = {
        "ok": True,
        "elementId": element_id,
        "elementName": str(topo.nodes[element_id].params.get("name") or element_id)
        if element_id in topo.nodes else element_id,
        "mode": opts["mode"],
        "hours": hours,
        "islandBus": _load_side_bus(topo, element_id, buses),
        # Line-to-line kV at the island bus (for a new unit's rating).
        "islandKv": _island_kv(topo, _load_side_bus(topo, element_id, buses), loads),
        "loads": len(loads),
        "pvCount": len(pvs),
        "profile": {
            "loadKw": [round(v, 2) for v in load_kw],
            "pvKw": [round(v, 2) for v in pv_kw],
            "netKw": [round(v, 2) for v in net],
        },
        "generator": {
            "requiredKw": round(required, 1),
            "peakNetKw": round(peak, 1),
            "peakHour": peak_hour,
            "marginPct": round(margin * 100, 1),
            "chosenKw": round(gen_kw, 1),
            "hoursAbove80": above80,
            "existing": fuel,
        },
        "battery": {
            "kw": round(batt_kw, 1),
            "kwh": round(batt_kwh, 1),
            "usableKwh": round(usable_kwh, 1),
            "drawdownKwh": round(drawdown, 1),
            "drawdownFrom": dd_from % hours,
            "drawdownTo": dd_to % hours,
            "efficiencyPct": round(eff * 100, 1),
            "reservePct": round(reserve * 100, 1),
            "energyBalanceKwh": round(energy, 1),
            "cycleCloses": closes,
            "emptiesAfterHours": empties_after_h,
            "dispatchKw": [round(-b, 2) if usable_kwh else 0.0 for b in balance],
        },
        "reversePowerHours": reverse_hours[:200],
        "reversePowerCount": len(reverse_hours),
        "verification": None,
        "issues": [i.model_dump() for i in issues],
    }
    if opts["verify"]:
        if opts["mode"] == "daily":
            v = _verify(case, element_id, result)
            # A day carried from a full battery is not an island carried: when
            # the day is short of energy the battery is lower every morning.
            if v.get("ran") and v.get("passed") and not closes:
                v["passed"] = False
                v["oneDayOnly"] = True
            result["verification"] = v
        else:
            result["verification"] = {
                "ran": False,
                "why": "The verification run is daily; size on a daily shape to verify.",
            }
    return result


def _island_kv(topo: trace.Topology, bus: str | None, loads: list[CircuitNode]) -> float:
    """The nearest busbar's base kV from the island bus, walking the
    conducting graph; a load's own kV when no busbar is found."""
    at: dict[str, float] = {}
    for n in topo.nodes.values():
        if n.type == "busbar" and (bs := topo.element_buses.get(n.id)):
            kv = _num(n.params.get("basekv"), 0.0)
            if kv > 0:
                at[bs[0]] = kv
    if bus:
        seen, queue = {bus}, [bus]
        for b in queue:
            if b in at:
                return at[b]
            for nxt, _el in topo.links.get(b, ()):
                el_node = topo.nodes.get(_el)
                # Do not cross a transformer: the voltage changes there.
                if el_node is not None and el_node.type == "transformer":
                    continue
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
    return _num(loads[0].params.get("kv"), 12.47) if loads else 12.47


def _load_side_bus(topo: trace.Topology, element_id: str, lost: set[str]) -> str | None:
    for b in topo.element_buses.get(element_id, []):
        if b in lost:
            return b
    return next(iter(sorted(lost)), None)


@engine.on_engine_thread
def _verify(case: Circuit, element_id: str, r: dict[str, Any]) -> dict[str, Any]:
    gen_kw = r["generator"]["chosenKw"]
    batt = r["battery"]
    bus = r["islandBus"]
    if gen_kw <= 0:
        return {"ran": False, "why": "With no generator nothing holds the island's voltage; a "
                                     "battery alone needs a grid-forming inverter model."}
    if not bus:
        return {"ran": False, "why": "No island bus found."}
    # The island alone: every generator in it stopped, then (once the bus
    # voltages are set) the element opened in the engine. An island cut off
    # before the build would have no voltage base to read.
    island = set(trace.downstream(trace.build(case), element_id)["nodeIds"])
    nodes = [n.model_copy(update={"params": {**n.params, "enabled": False}})
             if n.id in island and n.type == "generator" else n for n in case.nodes]
    cut = case.model_copy(update={"nodes": nodes})
    compiled: CompileResult = compile_circuit(cut, shape_dir=engine.SHAPE_DIR)
    issues = limit_issues(cut) + list(compiled.issues)
    if any(i.severity == "error" for i in issues):
        return {"ran": False, "why": "; ".join(i.message for i in issues if i.severity == "error")}
    full = next((f for f, ref in compiled.element_map.items()
                 if ref == element_id and f.split(".", 1)[0] in ("line", "transformer")), None)
    rows: list[dict[str, Any]] = []
    with engine.dss_guard():
        engine._ensure_init()
        engine._write_aux_files(compiled)
        if not engine._run_commands(compiled.commands, compiled.element_map, issues,
                                    compiled.optional_commands):
            return {"ran": False, "why": "The island did not build."}
        dss.Circuit.SetActiveBus(bus)
        kv_ln = dss.Bus.kVBase() or r["islandKv"] / math.sqrt(3)
        nphases = 3 if len([x for x in dss.Bus.Nodes() if 1 <= int(x) <= 3]) >= 3 else 1
        kv = kv_ln * math.sqrt(3) if nphases == 3 else kv_ln
        node = next((n for n in case.nodes if n.id == element_id), None)
        if full is None:
            return {"ran": False,
                    "why": "That element cannot be opened to island what is below it."}
        if node is not None and node.type in ("breaker", "fuse", "recloser", "relay"):
            dss.Text.Command(f"open {full} term=1")
        else:
            dss.Text.Command(f"{full}.enabled=no")
        rating_kva = gen_kw / GEN_PF
        fake = CircuitNode(id="sizing_gen", type="generator",
                           params={"kv": kv, "kw": gen_kw, "kva": rating_kva, "phases": nphases})
        cmd = _isochronous_source(fake, "sizing_gen", bus, set(), False)
        dss.Text.Command(cmd.split("  !", 1)[0])
        with_batt = batt["kwh"] > 0 and batt["kw"] > 0
        if with_batt:
            # Start the day at the charge the schedule needs: enough above the
            # reserve to cover the lowest point of the day's running balance
            # (charging and discharging each at the square root of the round
            # trip, as the engine models them).
            leg = math.sqrt(batt["efficiencyPct"] / 100)
            run, low = 0.0, 0.0
            for d in batt["dispatchKw"]:
                run += -d / leg if d > 0 else -d * leg
                low = min(low, run)
            reserve_kwh = batt["kwh"] * batt["reservePct"] / 100
            start_pct = min(100.0, 100.0 * (reserve_kwh - low) / batt["kwh"])
            mult = " ".join(f"{(d / batt['kw']):.5g}" for d in batt["dispatchKw"])
            dss.Text.Command(f"new loadshape.sizing_dispatch npts=24 interval=1 mult=({mult})")
            dss.Text.Command(
                f"new storage.sizing_bess bus1={bus} phases={nphases} kv={kv:.6g} "
                f"kwrated={batt['kw']:.6g} kva={batt['kw']:.6g} kwhrated={batt['kwh']:.6g} "
                f"%stored={start_pct:.4g} %reserve={batt['reservePct']:g} "
                f"%effcharge={math.sqrt(batt['efficiencyPct'] / 100) * 100:.4g} "
                f"%effdischarge={math.sqrt(batt['efficiencyPct'] / 100) * 100:.4g} "
                f"%idlingkw=0 dispmode=follow daily=sizing_dispatch")
        dss.Text.Command("set mode=daily stepsize=1h number=1")
        dss.Text.Command("set hour=0 sec=0")
        soc_min = 100.0
        gen_max = 0.0
        reverse = 0
        converged = True
        for h in range(24):
            dss.Solution.Solve()
            if not dss.Solution.Converged():
                converged = False
                break
            dss.Circuit.SetActiveElement("vsource.sizing_gen")
            ncond = dss.CktElement.NumConductors()
            pw = dss.CktElement.Powers()[: 2 * ncond]
            kw, kvar = -sum(pw[0::2]), -sum(pw[1::2])
            soc = None
            if with_batt:
                dss.Text.Command("? storage.sizing_bess.%stored")
                try:
                    soc = float(dss.Text.Result())
                except ValueError:
                    soc = None
            loading = 100.0 * math.hypot(kw, kvar) / rating_kva
            gen_max = max(gen_max, loading)
            if kw < -1.0:
                reverse += 1
            if soc is not None:
                soc_min = min(soc_min, soc)
            rows.append({"hour": h, "genKw": round(kw, 1), "genLoadingPct": round(loading, 1),
                         "socPct": round(soc, 1) if soc is not None else None})
    reserve = batt["reservePct"]
    soc_ok = not with_batt or soc_min >= reserve - 1.0
    passed = converged and soc_ok and gen_max <= 100.5 and reverse == 0
    return {
        "ran": True,
        "converged": converged,
        "passed": passed,
        "generatorKva": round(rating_kva, 1),
        "maxGenLoadingPct": round(gen_max, 1),
        "minSocPct": round(soc_min, 1) if with_batt else None,
        "reverseHours": reverse,
        "hours": rows,
    }
