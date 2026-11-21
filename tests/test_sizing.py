"""Generator and battery sizing against an island (facility plan 2.3)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode, LoadShapeSpec
from opendss_designer.studies import sizing

SUN = [0.0] * 8 + [1.0] * 8 + [0.0] * 8  # PV at full output from 08:00 to 16:00


def island(load_kw: float = 100.0, pv_kw: float | None = None) -> Circuit:
    """Utility -> breaker BRK -> bus ISL with a flat load (and optionally PV)."""
    nodes = [
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3,
                                                      "mvasc3": 500, "mvasc1": 500}),
        CircuitNode(id="sub", type="busbar", width=200, params={"name": "SUB", "basekv": 12.47}),
        CircuitNode(id="brk", type="breaker", params={"name": "BRK", "closed": True, "phases": 3}),
        CircuitNode(id="isl", type="busbar", width=200, params={"name": "ISL", "basekv": 12.47}),
        CircuitNode(id="ld", type="load", params={"name": "LD", "kv": 12.47, "kw": load_kw,
                                                  "pf": 0.95, "phases": 3, "model": 1}),
    ]
    edges = [
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="sub", targetHandle="b1"),
        CircuitEdge(id="w1", type="wire", source="sub", sourceHandle="b5", target="brk", targetHandle="t1"),
        CircuitEdge(id="w2", type="wire", source="brk", sourceHandle="t2", target="isl", targetHandle="b1"),
        CircuitEdge(id="w3", type="wire", source="isl", sourceHandle="b3", target="ld", targetHandle="t1"),
    ]
    shapes = {}
    if pv_kw:
        nodes.append(CircuitNode(id="pv", type="pvsystem", params={
            "name": "PV", "kv": 12.47, "pmpp": pv_kw, "kva": pv_kw * 1.1, "irradiance": 1.0,
            "phases": 3, "pf": 1.0, "loadshape": "sun"}))
        edges.append(CircuitEdge(id="w4", type="wire", source="isl", sourceHandle="b7", target="pv",
                                 targetHandle="t1"))
        shapes["sun"] = LoadShapeSpec(kind="irradiance", intervalMin=60, points=SUN)
    return Circuit(name="isl", nodes=nodes, edges=edges, loadShapes=shapes)


def test_flat_load_with_a_margin():
    r = sizing.size_backup(island(), {"elementId": "brk", "marginPct": 20, "verify": False})
    assert r["ok"], r["issues"]
    assert r["generator"]["requiredKw"] == pytest.approx(120, abs=0.5)
    assert r["generator"]["peakNetKw"] == pytest.approx(100, abs=0.5)
    assert r["battery"]["kwh"] == 0


def test_night_deficit_sizes_the_battery_and_an_open_cycle_is_called_out():
    r = sizing.size_backup(island(pv_kw=50), {
        "elementId": "brk", "generatorKw": 60, "efficiencyPct": 90, "verify": False})
    b = r["battery"]
    assert b["drawdownKwh"] == pytest.approx(640, rel=0.01)  # 40 kW for 16 hours
    assert b["usableKwh"] == pytest.approx(640 / 0.9, rel=0.01)
    assert b["kw"] == pytest.approx(40, abs=0.5)
    assert b["energyBalanceKwh"] < 0
    assert b["cycleCloses"] is False
    assert b["emptiesAfterHours"] is not None


def test_a_big_enough_generator_closes_the_cycle_and_verifies():
    r = sizing.size_backup(island(pv_kw=50), {"elementId": "brk", "generatorKw": 100})
    assert r["battery"]["cycleCloses"] is True
    assert r["battery"]["kwh"] == 0
    v = r["verification"]
    assert v["ran"] and v["converged"], v
    assert v["passed"], v
    assert v["maxGenLoadingPct"] < 100


def test_a_battery_that_cycles_verifies():
    r = sizing.size_backup(island(pv_kw=50), {"elementId": "brk", "generatorKw": 90, "reservePct": 20})
    b = r["battery"]
    assert b["cycleCloses"] is True and b["kwh"] > 0
    v = r["verification"]
    assert v["ran"] and v["passed"], v
    assert v["minSocPct"] >= 19


def test_pv_larger_than_the_load_flags_reverse_power():
    """150 kW of PV over 100 kW of load at midday, and no battery needed for
    the night: the surplus has nowhere to go but into the generator."""
    r = sizing.size_backup(island(load_kw=100, pv_kw=150), {"elementId": "brk", "verify": False})
    assert r["battery"]["kwh"] == 0
    assert r["reversePowerHours"] == list(range(8, 16))


def test_unknown_element_and_route():
    assert not sizing.size_backup(island(), {"elementId": "nope"})["ok"]
    client = TestClient(server.app, base_url="http://127.0.0.1")
    res = client.post("/api/sizing", json={"circuit": island().model_dump(),
                                           "options": {"elementId": "brk", "verify": False}})
    assert res.status_code == 200, res.text
    assert res.json()["generator"]["requiredKw"] > 0


def test_a_day_carried_on_a_draining_battery_does_not_pass():
    r = sizing.size_backup(island(pv_kw=50), {"elementId": "brk", "generatorKw": 60})
    v = r["verification"]
    assert v["ran"] and v["converged"]
    assert v["passed"] is False
    assert v.get("oneDayOnly") is True


def test_the_new_unit_takes_the_island_bus_voltage_not_a_load_behind_a_transformer():
    import json
    from pathlib import Path
    d = json.loads((Path(__file__).parent.parent / "src" / "opendss_designer" / "samples"
                    / "installation-campus.oneline.json").read_text())
    c = Circuit.model_validate(d)
    r = sizing.size_backup(c, {"elementId": "brk_f1", "generatorKw": 1400})
    assert r["islandKv"] == pytest.approx(13.2)
    v = r["verification"]
    assert v["passed"], v
    assert 50 < v["maxGenLoadingPct"] < 100
