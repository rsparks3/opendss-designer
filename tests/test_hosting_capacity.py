"""Hosting capacity: the iterative and sensitivity methods, the criteria,
load hosting capacity, and the job route."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import engine
from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode, LoadLevel, LoadShapeSpec
from opendss_designer.studies.hosting_capacity import estimate_solves, hosting_capacity

FIXTURE = Path(__file__).parent / "fixtures" / "full-circuit.oneline.json"

LINE = {"r1": 0.2, "x1": 0.4, "r0": 0.5, "x0": 1.2, "normamps": 200, "phases": 3, "units": "km"}


def feeder(load_kw: float = 1000.0) -> Circuit:
    """Source -> relay -> 6 km trunk -> BUS2 (load) -> 4 km -> BUS3 (load).
    Long and lightly rated so voltage and thermal both come into play."""
    return Circuit(name="hc", nodes=[
        CircuitNode(id="src", type="vsource",
                    params={"name": "SRC", "basekv": 12.47, "phases": 3, "mvasc3": 300, "mvasc1": 300}),
        CircuitNode(id="rly", type="relay",
                    params={"name": "RLY", "closed": True, "phases": 3, "phasetrip": 400,
                            "phasecurve": "very_inv", "normamps": 600, "interruptingka": 20}),
        CircuitNode(id="bus2", type="busbar", width=240, params={"name": "BUS2", "basekv": 12.47}),
        CircuitNode(id="bus3", type="busbar", width=240, params={"name": "BUS3", "basekv": 12.47}),
        CircuitNode(id="ld2", type="load",
                    params={"name": "L2", "kv": 12.47, "kw": load_kw, "pf": 0.95, "phases": 3}),
        CircuitNode(id="ld3", type="load",
                    params={"name": "L3", "kv": 12.47, "kw": load_kw, "pf": 0.95, "phases": 3}),
    ], edges=[
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="rly", targetHandle="t1"),
        CircuitEdge(id="ln1", type="line", source="rly", sourceHandle="t2", target="bus2", targetHandle="b1",
                    params={"name": "LN1", "length": 6, **LINE}),
        CircuitEdge(id="ln2", type="line", source="bus2", sourceHandle="b7", target="bus3", targetHandle="b1",
                    params={"name": "LN2", "length": 4, **LINE}),
        CircuitEdge(id="w2", type="wire", source="bus2", sourceHandle="b3", target="ld2", targetHandle="t1"),
        CircuitEdge(id="w3", type="wire", source="bus3", sourceHandle="b3", target="ld3", targetHandle="t1"),
    ])


def test_iterative_finds_a_capacity_that_the_engine_confirms():
    c = feeder()
    seen = []
    r = hosting_capacity(c, {"criteria": {"substationReverse": False, "islanding": False}},
                         progress=lambda d, t, m: seen.append((d, t)))
    assert r["converged"], r["issues"]
    assert r["summary"]["evaluated"] == len(r["buses"]) >= 2
    assert seen and seen[-1][0] == seen[-1][1]
    far = r["buses"]["bus3"]
    assert far["kw"] > 0 and far["binding"] in ("voltage", "thermal", "deviation", "faultCurrent", "interrupting")
    # The capacity is feasible: putting a generator of that size there keeps
    # every criterion inside its limit...
    def solve_with(kw: float) -> dict:
        cc = c.model_copy(deep=True)
        cc.nodes.append(CircuitNode(id="g", type="generator",
                                    params={"name": "G", "kv": 12.47, "kw": kw, "pf": 1.0, "phases": 3,
                                            "kva": 10 * kw}))
        cc.edges.append(CircuitEdge(id="wg", type="wire", source="bus3", sourceHandle="b5",
                                    target="g", targetHandle="t1"))
        return engine.solve(cc)
    ok = solve_with(far["kw"] - 20)
    assert ok["converged"]
    assert max(b["vmaxPu"] for b in ok["buses"].values()) <= 1.05 + 1e-3
    assert all((e["loadingPct"] or 0) < 100 for e in ok["elements"].values() if e["normAmps"])
    # ...and a little more than that breaks one, when voltage or thermal bound.
    if far["binding"] in ("voltage", "thermal"):
        over = solve_with(far["kw"] * 1.3)
        broke_v = max(b["vmaxPu"] for b in over["buses"].values()) > 1.05
        broke_i = any((e["loadingPct"] or 0) >= 100 for e in over["elements"].values())
        assert broke_v or broke_i
    # Nearer the source there is more room.
    assert r["buses"]["bus2"]["kw"] > far["kw"]


def test_sensitivity_agrees_with_iterative_within_tolerance():
    c = feeder()
    opts = {"criteria": {"substationReverse": False, "islanding": False, "deviation": False}}
    it = hosting_capacity(c, opts)
    se = hosting_capacity(c, {**opts, "method": "sensitivity"})
    assert se["summary"]["solves"] < it["summary"]["solves"]
    for bus in ("bus2", "bus3"):
        a, b = it["buses"][bus]["kw"], se["buses"][bus]["kw"]
        assert b == pytest.approx(a, rel=0.08), (bus, a, b)
        assert se["buses"][bus]["byCriterion"]


def test_substation_reverse_and_islanding_bind_where_expected():
    c = feeder(load_kw=500)
    r = hosting_capacity(c, {"criteria": {"faultCurrent": False, "interrupting": False}})
    b3 = r["buses"]["bus3"]
    # Export at the head is forbidden by default, so the total load (1 MW plus
    # losses) caps every bus; the islanding ratio (2/3 of the section's
    # 1 MW) binds first.
    assert b3["binding"] == "islanding"
    assert b3["kw"] == pytest.approx(667, abs=15)
    r2 = hosting_capacity(c, {"criteria": {"faultCurrent": False, "interrupting": False, "islanding": False}})
    assert r2["buses"]["bus3"]["binding"] == "substationReverse"
    assert 990 <= r2["buses"]["bus3"]["kw"] < 1100


def test_load_hosting_capacity_binds_on_undervoltage_or_thermal():
    r = hosting_capacity(feeder(), {"kind": "load"})
    b3 = r["buses"]["bus3"]
    assert b3["binding"] in ("voltage", "thermal")
    assert b3["kw"] > 0
    assert "faultCurrent" not in b3["byCriterion"]
    assert r["kind"] == "load"


def test_a_device_already_over_its_interrupting_duty_is_excluded():
    c = feeder()
    rly = next(n for n in c.nodes if n.id == "rly")
    rly.params["interruptingka"] = 8  # the 14 kA source fault already exceeds it
    r = hosting_capacity(c, {"criteria": {"substationReverse": False, "islanding": False}})
    assert r["exclusions"]["overDuty"] == ["line.rly"]
    assert r["buses"]["bus3"]["kw"] > 0 and r["buses"]["bus3"]["binding"] != "interrupting"


def test_pre_existing_violations_are_excluded_and_options_respected():
    c = feeder(load_kw=3000)  # already undervoltage at the far end
    base = engine.solve(c)
    assert min(b["vminPu"] for b in base["buses"].values()) < 0.95
    r = hosting_capacity(c, {"kind": "load", "buses": ["bus2"], "maxKw": 500, "toleranceKw": 50,
                             "criteria": {"thermal": False}})
    assert list(r["buses"]) == ["bus2"]
    # Capped: nothing bound below 500 kW once the existing undervoltage is excluded.
    assert r["buses"]["bus2"]["capped"] or r["buses"]["bus2"]["kw"] <= 500
    assert estimate_solves(c, {"buses": ["bus2"], "method": "sensitivity"}) < estimate_solves(c, {"buses": ["bus2"]})


def test_time_granular_takes_the_worst_hour():
    c = feeder()
    c.loadShapes = {"day": LoadShapeSpec(intervalMin=60, points=[0.3] * 10 + [1.0] * 8 + [0.3] * 6)}
    for n in c.nodes:
        if n.type == "load":
            n.params["loadshape"] = "day"
    r = hosting_capacity(c, {"hours": [2, 12], "criteria": {"faultCurrent": False, "interrupting": False,
                                                            "islanding": False}})
    assert r["hours"] == [2, 12]
    b3 = r["buses"]["bus3"]
    assert set(b3["kwByHour"]) == {"2", "12"}
    # Light load (hour 2) leaves less room for export than peak (hour 12).
    assert b3["kwByHour"]["2"] < b3["kwByHour"]["12"]
    assert b3["kw"] == min(b3["kwByHour"].values())


def test_runs_at_the_active_level_and_scenario():
    c = feeder()
    c.loadLevels = [LoadLevel(name="Min", loadmult=0.3)]
    c.activeLevel = "Min"
    r = hosting_capacity(c, {"criteria": {"faultCurrent": False, "interrupting": False, "islanding": False}})
    assert r["loadLevel"]["name"] == "Min"
    # Reverse power at 30 % load binds near 600 kW rather than 2 MW.
    assert 500 < r["buses"]["bus3"]["kw"] < 700


def test_fixture_runs_and_the_job_route_streams_a_result():
    c = Circuit.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))
    r = hosting_capacity(c, {"method": "sensitivity"})
    assert r["converged"] and r["buses"]
    client = TestClient(server.app, base_url="http://127.0.0.1")
    res = client.post("/api/jobs/hosting-capacity",
                      json={"circuit": c.model_dump(mode="json"), "options": {"method": "sensitivity"}})
    assert res.status_code == 200, res.text
    job_id = res.json()["job"]["id"]
    with client.stream("GET", f"/api/jobs/{job_id}/events") as stream:
        blocks = [ln for ln in stream.iter_lines() if ln.startswith("data: ")]
    final = json.loads(blocks[-1][6:])
    assert final["status"] == "done", final
    assert final["result"]["summary"]["evaluated"] == len(final["result"]["buses"])
