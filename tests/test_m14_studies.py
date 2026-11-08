"""M14: contingency (switching, N-1, transfer capability), Volt/VAR (sweeps,
CVR, capacitor placement), phase balancing, loss evaluation and capacity."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import engine
from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode, LoadShapeSpec
from opendss_designer.studies import balancing, capacity, contingency, voltvar

LINE = {"r1": 0.2, "x1": 0.4, "r0": 0.5, "x0": 1.2, "normamps": 300, "phases": 3, "units": "km"}


def two_feeders(tie_marked: bool = True) -> Circuit:
    """Two feeders from one source bus, each: breaker -> 3 km -> bus -> 2 km
    -> end bus with loads; a normally-open tie joins the two end buses."""
    nodes = [
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3, "mvasc3": 500, "mvasc1": 500}),
        CircuitNode(id="sub", type="busbar", width=240, params={"name": "SUB", "basekv": 12.47}),
    ]
    edges = [CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="sub", targetHandle="b5")]
    for f, (hb, kw) in enumerate((("b1", 1200), ("b7", 600)), start=1):
        nodes += [
            CircuitNode(id=f"brk{f}", type="breaker", params={"name": f"BRK{f}", "closed": True, "normamps": 600, "phases": 3}),
            CircuitNode(id=f"mid{f}", type="busbar", width=240, params={"name": f"MID{f}", "basekv": 12.47}),
            CircuitNode(id=f"end{f}", type="busbar", width=240, params={"name": f"END{f}", "basekv": 12.47}),
            CircuitNode(id=f"ld{f}a", type="load", params={"name": f"L{f}A", "kv": 12.47, "kw": kw, "pf": 0.95, "phases": 3, "model": 1}),
            CircuitNode(id=f"ld{f}b", type="load", params={"name": f"L{f}B", "kv": 12.47, "kw": kw / 2, "pf": 0.95, "phases": 3, "model": 1}),
        ]
        edges += [
            CircuitEdge(id=f"w{f}a", type="wire", source="sub", sourceHandle=hb, target=f"brk{f}", targetHandle="t1"),
            CircuitEdge(id=f"ln{f}a", type="line", source=f"brk{f}", sourceHandle="t2", target=f"mid{f}", targetHandle="b1",
                        params={"name": f"LN{f}A", "length": 3, **LINE}),
            CircuitEdge(id=f"ln{f}b", type="line", source=f"mid{f}", sourceHandle="b7", target=f"end{f}", targetHandle="b1",
                        params={"name": f"LN{f}B", "length": 2, **LINE}),
            CircuitEdge(id=f"w{f}b", type="wire", source=f"mid{f}", sourceHandle="b3", target=f"ld{f}a", targetHandle="t1"),
            CircuitEdge(id=f"w{f}c", type="wire", source=f"end{f}", sourceHandle="b3", target=f"ld{f}b", targetHandle="t1"),
        ]
    nodes.append(CircuitNode(id="tie", type="breaker",
                             params={"name": "TIE", "closed": False, "normamps": 400, "phases": 3,
                                     **({"tie": True} if tie_marked else {})}))
    edges += [
        CircuitEdge(id="wt1", type="wire", source="end1", sourceHandle="b7", target="tie", targetHandle="t1"),
        CircuitEdge(id="wt2", type="wire", source="end2", sourceHandle="b7", target="tie", targetHandle="t2"),
    ]
    return Circuit(name="two", nodes=nodes, edges=edges)


# --- contingency ---------------------------------------------------------------------

def test_switching_sequence_reads_each_step():
    c = two_feeders()
    r = contingency.switching_sequence(c, [{"id": "brk1", "closed": False}, {"id": "tie", "closed": True}])
    assert r["converged"], r["issues"]
    s0, s1, s2 = r["steps"]
    assert s0["unservedKw"] == 0
    # Opening feeder 1's breaker darkens its 1800 kW; closing the tie brings it back.
    assert s1["unservedKw"] == pytest.approx(1800, abs=1)
    assert s2["unservedKw"] == 0
    assert s2["minVpu"] < s0["minVpu"]  # the long way round sags more


def test_n_minus_1_finds_the_tie_and_ranks_the_unrestorable():
    c = two_feeders()
    seen = []
    r = contingency.n_minus_1(c, progress=lambda d, t, m: seen.append(d))
    assert r["converged"], r["issues"]
    assert [t["id"] for t in r["ties"]] == ["tie"]
    cases = {x["id"]: x for x in r["cases"]}
    # The two feeder breakers are candidates; the tie itself is not.
    assert set(cases) == {"brk1", "brk2"}
    assert cases["brk1"]["unservedKw"] == pytest.approx(1800, abs=1)
    assert cases["brk1"]["bestTie"]["tie"] == "tie"
    assert cases["brk1"]["bestTie"]["restoredKw"] == pytest.approx(1800, abs=1)
    assert cases["brk1"]["remainingUnservedKw"] == pytest.approx(0, abs=1)
    assert r["summary"]["restorable"] == 2
    assert seen[-1] == r["summary"]["candidates"]
    # Without a tie nothing can be restored, and the loss of the big feeder ranks first.
    no_tie = two_feeders()
    no_tie.nodes = [n for n in no_tie.nodes if n.id != "tie"]
    no_tie.edges = [e for e in no_tie.edges if e.id not in ("wt1", "wt2")]
    r2 = contingency.n_minus_1(no_tie)
    assert r2["ties"] == []
    assert r2["cases"][0]["id"] == "brk1" and r2["cases"][0]["bestTie"] is None
    assert r2["cases"][0]["remainingUnservedKw"] == pytest.approx(1800, abs=1)
    # "all" also takes out lines and transformers.
    r3 = contingency.n_minus_1(c, {"candidates": "all"})
    assert {x["kind"] for x in r3["cases"]} >= {"breaker", "line"}


def test_unmarked_open_breakers_count_as_ties():
    assert contingency.ties_of(two_feeders(tie_marked=False)) == ["tie"]
    c = two_feeders()
    c.nodes[-1].params["tie"] = False
    assert contingency.ties_of(c) == ["tie"]  # still normally open


def test_transfer_capability_each_way():
    c = two_feeders()
    r = contingency.transfer_capability(c, "tie")
    assert r["converged"], r["issues"]
    assert len(r["directions"]) == 2
    by_side = {d["isolatingName"]: d for d in r["directions"]}
    # Isolating feeder 1 at its breaker transfers its 1800 kW to feeder 2.
    f1 = by_side["BRK1"]
    assert f1["transferredLoadKw"] == pytest.approx(1800, abs=1)
    assert f1["kw"] > 0 and f1["carriesPresentLoad"] in (True, False)
    f2 = by_side["BRK2"]
    assert f2["transferredLoadKw"] == pytest.approx(900, abs=1)
    # The lighter feeder's load is easier to carry.
    assert f2["multiplier"] >= f1["multiplier"]
    bad = contingency.transfer_capability(c, "nope")
    assert bad["converged"] is False


# --- volt/var ---------------------------------------------------------------------------

def regulated(load_kw: float = 3000.0) -> Circuit:
    c = Circuit(name="vv", nodes=[
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3, "mvasc3": 200, "mvasc1": 200}),
        CircuitNode(id="bus", type="busbar", width=240, params={"name": "BUS", "basekv": 12.47}),
        CircuitNode(id="reg", type="regulator", params={"name": "REG", "phases": 3, "kv": 12.47, "kva": 5000, "vreg": 122, "band": 2, "r": 6, "x": 12}),
        CircuitNode(id="bus2", type="busbar", width=240, params={"name": "BUS2", "basekv": 12.47}),
        CircuitNode(id="bus3", type="busbar", width=240, params={"name": "BUS3", "basekv": 12.47}),
        CircuitNode(id="cap", type="capacitor", params={"name": "CAP", "kv": 12.47, "kvar": 900, "phases": 3,
                                                        "control": "voltage", "ctrlElement": "self", "onsetting": 119, "offsetting": 125, "ptratio": 60}),
        CircuitNode(id="ld", type="load", params={"name": "L1", "kv": 12.47, "kw": load_kw, "pf": 0.9, "phases": 3, "model": 4,
                                                   "cvrwatts": 0.8, "cvrvars": 3.0, "loadshape": "day"}),
        CircuitNode(id="ld2", type="load", params={"name": "L2", "kv": 12.47, "kw": load_kw / 2, "pf": 0.9, "phases": 3, "model": 4,
                                                    "cvrwatts": 0.8, "cvrvars": 3.0, "loadshape": "day"}),
    ], edges=[
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="bus", targetHandle="b1"),
        CircuitEdge(id="w1", type="wire", source="bus", sourceHandle="b3", target="reg", targetHandle="t1"),
        CircuitEdge(id="ln", type="line", source="reg", sourceHandle="t2", target="bus2", targetHandle="b1",
                    params={"name": "LN", "length": 5, **LINE}),
        CircuitEdge(id="ln2", type="line", source="bus2", sourceHandle="b7", target="bus3", targetHandle="b1",
                    params={"name": "LN2", "length": 4, **LINE}),
        CircuitEdge(id="w2", type="wire", source="bus2", sourceHandle="b3", target="ld", targetHandle="t1"),
        CircuitEdge(id="w3", type="wire", source="bus3", sourceHandle="b3", target="ld2", targetHandle="t1"),
        CircuitEdge(id="w4", type="wire", source="bus3", sourceHandle="b5", target="cap", targetHandle="t1"),
    ], loadShapes={"day": LoadShapeSpec(intervalMin=60, points=[0.4] * 7 + [0.8] * 4 + [1.0] * 7 + [0.6] * 6)})
    return c


def test_setting_sweep_tabulates_and_ranks():
    c = regulated()
    r = voltvar.setting_sweep(c, [{"id": "reg", "property": "vreg", "values": [118, 122, 126]},
                                  {"id": "cap", "property": "onsetting", "values": [117, 120]}])
    assert r["converged"], r["issues"]
    assert len(r["rows"]) == 6
    row = r["rows"][0]
    assert {"energyKwh", "lossesKwh", "minVpu", "maxVpu", "controlOps", "settings"} <= set(row)
    assert set(row["settings"]) == {"REG.vreg", "CAP.onsetting"}
    assert all(x["steps"] == 24 for x in r["rows"])
    # A higher setpoint means more energy from CVR loads.
    e = {x["settings"]["REG.vreg"]: x["energyKwh"] for x in r["rows"] if x["settings"]["CAP.onsetting"] == 117}
    assert e[126] > e[118]
    # Rows with no violations come first, then by losses.
    viol = [x["undervoltageBusSteps"] + x["overvoltageBusSteps"] + x["overloadSteps"] for x in r["rows"]]
    assert viol == sorted(viol)
    bad = voltvar.setting_sweep(c, [{"id": "ld", "property": "kw", "values": [1, 2]}])
    assert bad["converged"] is False


def test_cvr_saves_energy_with_cvr_loads():
    c = regulated()
    r = voltvar.cvr(c, reduction_v=3.0)
    assert r["converged"], r["issues"]
    assert "regulator" in r["how"]
    assert r["energySavedKwh"] > 0
    assert r["voltageReducedPct"] > 0
    assert 0.3 < r["cvrFactor"] < 1.5
    assert r["lowestLoadV120"] < r["base"]["minLoadVpu"] * 120
    assert r["cvrLoads"] == 2
    # Constant-power loads: a warning, and nothing saved to speak of.
    flat = regulated()
    for n in flat.nodes:
        if n.type == "load":
            n.params["model"] = 1
    r2 = voltvar.cvr(flat, reduction_v=3.0)
    assert any(i["code"] == "load-model" for i in r2["issues"])
    assert abs(r2["energySavedPct"] or 0) < 0.5


def test_capacitor_placement_prefers_the_far_end():
    c = regulated()
    c.nodes = [n for n in c.nodes if n.id != "cap"]
    c.edges = [e for e in c.edges if e.id != "w4"]
    # A low setpoint leaves room under the overvoltage limit for the banks.
    next(n for n in c.nodes if n.id == "reg").params["vreg"] = 118
    r = voltvar.capacitor_placement(c, kvar=300, banks=2)
    assert r["converged"], r["issues"]
    assert len(r["placed"]) == 2
    assert r["placed"][0]["bus"] in ("bus3", "bus2")
    assert r["placed"][0]["lossReductionKw"] > 0
    assert r["totalLossReductionKw"] >= r["placed"][0]["lossReductionKw"] * 0.9
    assert r["rounds"][0]["candidates"][0]["bus"] == r["placed"][0]["bus"]


# --- balancing ----------------------------------------------------------------------------

def unbalanced() -> Circuit:
    c = Circuit(name="bal", nodes=[
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3}),
        CircuitNode(id="bus", type="busbar", width=240, params={"name": "BUS", "basekv": 12.47}),
        CircuitNode(id="l3p", type="load", params={"name": "L3P", "kv": 12.47, "kw": 600, "pf": 0.95, "phases": 3}),
    ], edges=[
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="bus", targetHandle="b1"),
        CircuitEdge(id="w3p", type="wire", source="bus", sourceHandle="b9", target="l3p", targetHandle="t1"),
    ])
    # Three single-phase laterals, all on phase A: badly unbalanced.
    for i, hb in enumerate(("b3", "b5", "b7"), start=1):
        c.nodes += [
            CircuitNode(id=f"lat{i}", type="busbar", width=200, params={"name": f"LAT{i}", "basekv": 12.47}),
            CircuitNode(id=f"l{i}", type="load", params={"name": f"L{i}", "kv": 7.2, "kw": 100 * i, "pf": 0.95, "phases": 1, "phasing": "A"}),
        ]
        c.edges += [
            CircuitEdge(id=f"ln{i}", type="line", source="bus", sourceHandle=hb, target=f"lat{i}", targetHandle="b1",
                        params={"name": f"LN{i}", "length": 1, "phases": 1, "phasing": "A", "r1": 0.3, "x1": 0.5, "r0": 0.6, "x0": 1.2, "normamps": 100, "units": "km"}),
            CircuitEdge(id=f"w{i}", type="wire", source=f"lat{i}", sourceHandle="b3", target=f"l{i}", targetHandle="t1"),
        ]
    return c


def test_laterals_and_phase_balance():
    c = unbalanced()
    groups = balancing.laterals(c)
    assert len(groups) == 3
    assert all(g["phase"] == "A" and g["rootBuses"] for g in groups)
    assert groups[0]["loadKw"] == 300  # the biggest first
    assert {"ln3", "l3"} <= set(groups[0]["members"])
    r = balancing.phase_balance(c)
    assert r["converged"], r["issues"]
    assert r["base"]["currentUnbalancePct"] > 50
    assert r["candidates"], "every lateral tried on two other phases"
    best = r["candidates"][0]
    assert best["currentImprovementPct"] > 0
    assert best["toPhase"] in ("B", "C") and best["fromPhase"] == "A"
    assert all(v == {"phasing": best["toPhase"]} for v in best["overrides"].values())
    # Applying the best move really lowers the unbalance.
    moved = c.model_copy(deep=True)
    for n in moved.nodes:
        if n.id in best["overrides"]:
            n.params["phasing"] = best["toPhase"]
    for e in moved.edges:
        if e.id in best["overrides"]:
            e.params["phasing"] = best["toPhase"]
    r2 = balancing.phase_balance(moved, max_candidates=1)
    assert r2["base"]["currentUnbalancePct"] < r["base"]["currentUnbalancePct"]
    assert balancing.unbalance_pct([100, 100, 100]) == 0
    assert balancing.unbalance_pct([100, 50, 150]) == pytest.approx(50)


# --- losses and capacity --------------------------------------------------------------------

def test_loss_evaluation_by_class():
    c = regulated()
    r = capacity.loss_evaluation(c, mode="daily", price_per_kwh=0.1)
    assert r["converged"], r["issues"]
    assert r["steps"] == 24 and r["energyKwh"] > 0
    classes = {x["class"]: x for x in r["byClass"]}
    assert classes["line"]["kwh"] > 0 and classes["regulator"]["kwh"] >= 0
    assert sum(x["kwh"] for x in r["byClass"]) == pytest.approx(r["lossesKwh"], rel=1e-3)
    assert r["costTotal"] == pytest.approx(r["lossesKwh"] * 0.1, rel=1e-3)
    assert r["peakKw"] > 0 and r["peakLossKw"] > 0
    assert len(r["lossSeriesKw"]) == 24


def test_capacity_search_finds_the_binding_multiplier():
    c = regulated()
    r = capacity.capacity_search(c)
    assert r["converged"], r["issues"]
    assert r["binding"] in ("voltage", "thermal")
    assert r["capacityMult"] > 1.0
    assert r["headroomKw"] > 0
    # Just under the multiplier is clean; just over breaks the criterion.
    from opendss_designer.core.model import LoadLevel
    ok = engine.solve(c.model_copy(update={"loadLevels": [LoadLevel(name="x", loadmult=r["capacityMult"] * 0.98)], "activeLevel": "x"}))
    assert min(b["vminPu"] for b in ok["buses"].values()) >= 0.95 - 1e-3
    assert all((e["loadingPct"] or 0) < 100 for e in ok["elements"].values())
    over = engine.solve(c.model_copy(update={"loadLevels": [LoadLevel(name="x", loadmult=r["capacityMult"] * 1.05)], "activeLevel": "x"}))
    broke = (min(b["vminPu"] for b in over["buses"].values()) < 0.95
             or any((e["loadingPct"] or 0) >= 100 for e in over["elements"].values()))
    assert broke


def test_m14_routes():
    client = TestClient(server.app, base_url="http://127.0.0.1")
    c = two_feeders().model_dump(mode="json")
    res = client.post("/api/jobs/n-minus-1", json={"circuit": c})
    assert res.status_code == 200, res.text
    res = client.post("/api/transfer", json={"circuit": c, "tie": "tie"})
    assert res.status_code == 200 and res.json()["converged"]
    res = client.post("/api/switching", json={"circuit": c, "steps": [{"id": "brk1", "closed": False}]})
    assert res.status_code == 200 and res.json()["steps"][1]["unservedKw"] > 0
    reg = regulated().model_dump(mode="json")
    res = client.post("/api/cvr", json={"circuit": reg, "reductionV": 2})
    assert res.status_code == 200 and res.json()["converged"]
    res = client.post("/api/capacity", json={"circuit": reg})
    assert res.status_code == 200 and res.json()["capacityMult"] > 1
    res = client.post("/api/jobs/phase-balance", json={"circuit": unbalanced().model_dump(mode="json")})
    assert res.status_code == 200
    res = client.post("/api/jobs/sweep", json={"circuit": reg, "sweeps": [{"id": "reg", "property": "vreg", "values": [120, 124]}]})
    assert res.status_code == 200
    res = client.post("/api/jobs/capacitor-placement", json={"circuit": reg, "kvar": 300, "banks": 1})
    assert res.status_code == 200
    res = client.post("/api/jobs/loss-evaluation", json={"circuit": reg, "mode": "daily"})
    assert res.status_code == 200
