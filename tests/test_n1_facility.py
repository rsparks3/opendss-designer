"""N-1 for facility planning (facility plan 2.1): unserved load by priority,
losses and islands per case, standby generators carrying the islands an
outage cuts off, the candidate options, and the time budget."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from opendss_designer.core import trace
from opendss_designer.core.model import Circuit, LoadLevel, Scenario
from opendss_designer.studies import contingency
from opendss_designer.studies.islanding import demand_kw, solve_with_islands

SAMPLES = Path(__file__).parent.parent / "src" / "opendss_designer" / "samples"


def sample(name: str, **patches: dict) -> Circuit:
    d = json.loads((SAMPLES / f"{name}.oneline.json").read_text())
    for n in d["nodes"]:
        n["params"].update(patches.get(n["id"], {}))
    return Circuit.model_validate(d)


def cases_by_id(r: dict) -> dict[str, dict]:
    assert r["converged"], r["issues"]
    return {c["id"]: c for c in r["cases"]}


def test_ieee13_each_outage_drops_its_downstream_set():
    """With no tie anywhere, what an outage leaves dark is exactly the load
    the trace finds downstream of the element."""
    c = sample("ieee-13-bus")
    r = contingency.n_minus_1(c, {"candidates": "all"})
    topo = trace.build(c)
    checked = 0
    for case in r["cases"]:
        if not case["converged"]:
            continue
        down = trace.downstream(topo, case["id"])
        expected = sum(demand_kw(topo.nodes[row["id"]], c.level) for row in down["loads"]["rows"])
        assert case["unservedKw"] == pytest.approx(expected, abs=1.0), case["element"]
        assert case["bestTie"] is None
        assert (case["islandsFormed"] > 0) == (expected > 0.5)
        checked += 1
    assert checked >= 10


def test_unserved_load_is_split_by_priority_and_ranked_by_critical():
    r = contingency.n_minus_1(sample("installation-campus"))
    cases = cases_by_id(r)
    f1 = cases["brk_f1"]
    assert sum(f1["unservedByPriority"].values()) == pytest.approx(f1["unservedKw"], abs=0.5)
    assert f1["unservedByPriority"]["critical"] > 0
    crit = [(c["remainingByPriority"] or {}).get("critical", 0) for c in r["cases"]]
    assert crit == sorted(crit, reverse=True)
    assert r["base"]["lossesKw"] > 0
    assert f1["noAction"]["lossesKw"] is not None


def test_standby_generators_carry_the_island_an_outage_cuts_off():
    c = sample("installation-campus")
    off = cases_by_id(contingency.n_minus_1(c))["brk_f1"]
    on_r = contingency.n_minus_1(c, {"standby": True})
    on = cases_by_id(on_r)["brk_f1"]
    assert off["remainingByPriority"]["critical"] > 0
    assert on["remainingByPriority"]["critical"] == pytest.approx(0, abs=0.5)
    assert on["standbyStarted"] == ["gen1"]
    gens = on["noAction"]["generators"]
    assert [g["id"] for g in gens] == ["gen1"]
    assert 0 < gens[0]["loadingPct"] < 100
    # No standby unit runs in the base case: the utility is there.
    assert on_r["base"]["standbyRunning"] == []
    assert on_r["base"]["generators"] == []
    # Losing the main breaker overloads both units, and that is a violation.
    main = cases_by_id(on_r)["brk_m"]
    assert sorted(main["standbyStarted"]) == ["gen1", "gen2"]
    assert main["noAction"]["genOverloads"] >= 1


def test_saving_a_row_as_a_scenario_reproduces_it():
    c = sample("installation-campus")
    row = cases_by_id(contingency.n_minus_1(c, {"standby": True}))["brk_f1"]
    overrides = {"brk_f1": {"closed": False}}
    for gid in row["standbyStarted"]:
        overrides[gid] = {"enabled": True, "islandMode": "isochronous"}
    case = c.model_copy(update={
        "scenarios": [Scenario(id="sc1", name="N-1", overrides=overrides)],
        "activeScenario": "sc1",
    })
    result = solve_with_islands(case)
    assert result["converged"]
    assert result["islands"]["unservedKw"]["critical"] == pytest.approx(0, abs=0.5)
    g1 = next(s for i in result["islands"]["islands"] for s in i["sources"] if s["id"] == "gen1")
    assert g1["loadingPct"] == pytest.approx(row["noAction"]["generators"][0]["loadingPct"], rel=0.02)


def test_standby_with_none_marked_says_so():
    c = sample("installation-campus", gen1={"standby": False}, gen2={"standby": False})
    r = contingency.n_minus_1(c, {"standby": True})
    assert any(i["code"] == "no-standby" for i in r["issues"])
    assert r["standbyUnits"] == []


def test_candidate_sets_and_tag_exclusion():
    c = sample("installation-campus")
    tx = contingency.n_minus_1(c, {"candidates": "transformers"})
    assert {x["kind"] for x in tx["cases"]} <= {"transformer", "regulator"}
    assert tx["cases"]
    sw = cases_by_id(contingency.n_minus_1(c))
    assert "brk_f1" in sw
    tagged = sample("installation-campus", brk_f1={"tags": ["Feeder-Head"]})
    ex = cases_by_id(contingency.n_minus_1(tagged, {"excludeTags": ["feeder-head"]}))
    assert "brk_f1" not in ex and len(ex) == len(sw) - 1
    assert contingency.estimate_n1_solves(tagged, {"excludeTags": ["feeder-head"]}) < \
        contingency.estimate_n1_solves(tagged)


def test_unserved_load_counts_the_class_multiplier():
    """N-1 and the islanding study agree on what a load asks for."""
    loads = [n["id"] for n in json.loads((SAMPLES / "installation-campus.oneline.json").read_text())["nodes"]
             if n["type"] == "load"]
    c = sample("installation-campus", **{lid: {"class": "hvac"} for lid in loads})
    cls = "hvac"
    c = c.model_copy(update={
        "loadLevels": [LoadLevel(name="Hot", loadmult=1.0, classMult={cls: 2.0})],
        "activeLevel": "Hot",
    })
    plain = cases_by_id(contingency.n_minus_1(sample("installation-campus")))
    hot = cases_by_id(contingency.n_minus_1(c))
    assert hot["brk_m"]["unservedKw"] > plain["brk_m"]["unservedKw"]


def test_ieee123_every_element_within_budget():
    c = sample("ieee-123-bus")
    t = time.perf_counter()
    r = contingency.n_minus_1(c, {"candidates": "all"})
    assert r["converged"]
    assert time.perf_counter() - t < 10.0
