"""Fault-element solves (fault point and sweep) and interconnection screening."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from test_hosting_capacity import feeder as _feeder

from opendss_designer import server
from opendss_designer.core import engine
from opendss_designer.core.model import LoadLevel
from opendss_designer.studies.faults import fault_point, fault_sweep
from opendss_designer.studies.screening import screen


def feeder():
    """The hosting-capacity feeder with a less resistive zero sequence, so
    the PCC is effectively grounded (R0/X1 under 1) and the grounding
    screen tests the other screens rather than the conductor choice."""
    c = _feeder()
    for e in c.edges:
        if e.type == "line":
            e.params["r0"] = 0.25
    return c


def test_fault_point_kinds_and_device_currents():
    c = feeder()
    three = fault_point(c, "bus3", "3ph")
    assert three["converged"], three["issues"]
    assert three["faultA"] > 0 and len(three["faultPhaseA"]) == 3
    # The relay carries the fault current (plus a little load).
    assert three["devices"]["line.rly"]["amps"] == pytest.approx(three["faultA"], rel=0.15)
    assert three["busVoltages"]["bus3"] < 0.05
    study = engine.fault_study(c)
    assert three["faultA"] == pytest.approx(study["buses"]["bus3"]["if3phA"], rel=0.05)
    lg = fault_point(c, "bus3", "lg")
    assert lg["converged"] and lg["faultA"] == pytest.approx(study["buses"]["bus3"]["if1phA"], rel=0.05)
    ll = fault_point(c, "bus3", "ll")
    llg = fault_point(c, "bus3", "llg", r_ohm=0.0)
    assert ll["converged"] and llg["converged"]
    # Line-to-line is about 87 % of three-phase; through 20 ohm the ground fault is far smaller.
    assert ll["faultA"] == pytest.approx(three["faultA"] * 0.866, rel=0.08)
    soft = fault_point(c, "bus3", "lg", r_ohm=20.0)
    assert soft["faultA"] < 0.5 * lg["faultA"]
    assert fault_point(c, "nowhere", "3ph")["converged"] is False
    with pytest.raises(ValueError):
        fault_point(c, "bus3", "weird")


def test_fault_sweep_adds_minimum_currents():
    seen = []
    r = fault_sweep(feeder(), r_ohm=20.0, progress=lambda d, t, m: seen.append(d))
    assert r["converged"] and seen and seen[-1] == len(r["buses"])
    b3 = r["buses"]["bus3"]
    assert b3["if3phA"] > b3["ifLLA"] > 0
    assert b3["ifLGrA"] < b3["if1phA"]
    assert b3["ifMinA"] == min(b3["ifLLA"], b3["ifLGrA"])


def test_screen_passes_a_small_unit_and_fails_a_large_one():
    c = feeder()
    c.loadLevels = [LoadLevel(name="Minimum daytime", loadmult=0.3)]
    small = screen(c, "bus3", {"kw": 100})
    assert small["converged"], small["issues"]
    keys = [s["key"] for s in small["screens"]]
    assert keys[:1] == ["aggregate"] and "grounding" in keys and "inverter" in keys
    assert small["outcome"] == "pass", small["failed"]
    assert small["section"]["peakLoadKw"] == pytest.approx(2000)
    assert small["section"]["minLoadKw"] == pytest.approx(600)
    agg = next(s for s in small["screens"] if s["key"] == "aggregate")
    assert agg["value"] == 100 and agg["limit"] == pytest.approx(300)

    # 500 kW fails the 15 % screen but passes 100 % of minimum load.
    mid = screen(c, "bus3", {"kw": 500})
    assert mid["outcome"] == "supplemental"
    assert any(s["key"] == "minimumLoad" and s["pass"] for s in mid["screens"])

    # 3 MW at the end of a weak feeder fails on more than the aggregate.
    big = screen(c, "bus3", {"kw": 3000})
    assert big["outcome"] == "fail"
    assert set(big["failed"]) & {"voltage", "deviation", "minimumLoad", "thermal"}
    dev = next(s for s in big["screens"] if s["key"] == "deviation")
    assert dev["value"] > 3


def test_screen_counts_existing_der_and_respects_options():
    c = feeder()
    from opendss_designer.core.model import CircuitEdge, CircuitNode
    c.nodes.append(CircuitNode(id="pv", type="pvsystem",
                               params={"name": "PV", "kv": 12.47, "kva": 250, "pmpp": 250, "phases": 3}))
    c.edges.append(CircuitEdge(id="wpv", type="wire", source="bus2", sourceHandle="b5",
                               target="pv", targetHandle="t1"))
    r = screen(c, "bus3", {"kw": 100, "derType": "synchronous", "export": False})
    assert r["section"]["existingDerKw"] == pytest.approx(250)
    agg = next(s for s in r["screens"] if s["key"] == "aggregate")
    assert agg["value"] == pytest.approx(350) and agg["pass"] is False
    # Not exporting: no supplemental minimum-load screen, so it fails outright.
    assert "minimumLoad" not in [s["key"] for s in r["screens"]]
    assert r["outcome"] == "fail"
    fc = next(s for s in r["screens"] if s["key"] == "faultCurrent")
    assert "5 x rated" in fc["note"]
    assert screen(c, "nowhere", {"kw": 10})["converged"] is False


def test_screen_route():
    client = TestClient(server.app, base_url="http://127.0.0.1")
    c = feeder()
    res = client.post("/api/screen", json={"circuit": c.model_dump(mode="json"), "bus": "bus2",
                                           "options": {"kw": 200}})
    assert res.status_code == 200, res.text
    assert res.json()["outcome"] in ("pass", "supplemental", "fail")
    res = client.post("/api/faultpoint", json={"circuit": c.model_dump(mode="json"), "bus": "bus2",
                                               "kind": "llg", "rOhm": 1.0})
    assert res.status_code == 200 and res.json()["converged"]
