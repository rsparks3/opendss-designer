"""Capacity headroom and the probe load (facility plan 2.2)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import engine
from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode, LoadLevel
from opendss_designer.studies import headroom, hosting_capacity

SAMPLES = Path(__file__).parent.parent / "src" / "opendss_designer" / "samples"


def service(load_kva: float = 300.0, kva: float = 500.0, line_km: float | None = None) -> Circuit:
    """A stiff 12.47 kV source, a 12.47/0.48 kV transformer of `kva`, and a
    480 V bus carrying `load_kva` at 0.95 pf; optionally a long 12.47 kV line
    ahead of the transformer, so voltage binds before the transformer does."""
    nodes = [
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3,
                                                      "mvasc3": 2000, "mvasc1": 2000, "pu": 1.0}),
        CircuitNode(id="hv", type="busbar", width=200, params={"name": "HV", "basekv": 12.47}),
        CircuitNode(id="xf", type="transformer", params={
            "name": "XF", "phases": 3, "xhl": 2.0,
            "windings": [{"kv": 12.47, "kva": kva, "conn": "delta"},
                         {"kv": 0.48, "kva": kva, "conn": "wye"}]}),
        CircuitNode(id="lv", type="busbar", width=200, params={"name": "LV", "basekv": 0.48}),
        CircuitNode(id="ld", type="load", params={"name": "LD", "kv": 0.48, "phases": 3, "model": 1,
                                                  "kw": load_kva * 0.95, "pf": 0.95}),
    ]
    edges = [
        CircuitEdge(id="w2", type="wire", source="xf", sourceHandle="t2", target="lv", targetHandle="b1"),
        CircuitEdge(id="w3", type="wire", source="lv", sourceHandle="b3", target="ld", targetHandle="t1"),
    ]
    if line_km:
        nodes.append(CircuitNode(id="far", type="busbar", width=200, params={"name": "FAR", "basekv": 12.47}))
        edges += [
            CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="hv", targetHandle="b1"),
            CircuitEdge(id="ln", type="line", source="hv", sourceHandle="b5", target="far", targetHandle="b1",
                        params={"name": "LN", "length": line_km, "units": "km", "phases": 3,
                                "r1": 0.4, "x1": 0.5, "r0": 0.8, "x0": 1.5, "normamps": 2000}),
            CircuitEdge(id="w1", type="wire", source="far", sourceHandle="b5", target="xf", targetHandle="t1"),
        ]
    else:
        edges += [
            CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="hv", targetHandle="b1"),
            CircuitEdge(id="w1", type="wire", source="hv", sourceHandle="b5", target="xf", targetHandle="t1"),
        ]
    return Circuit(name="svc", nodes=nodes, edges=edges)


def probe(c: Circuit, bus: str) -> dict:
    r = hosting_capacity.hosting_capacity(c, {
        "kind": "load", "method": "iterative", "buses": [bus], "threePhaseOnly": False, "minKv": 0,
        "criteria": {k: k in ("voltage", "thermal") for k in hosting_capacity.CRITERIA},
        "toleranceKw": 2.0,
    })
    assert r["converged"], r["issues"]
    return r["buses"][bus]


def test_transformer_rates_on_nameplate():
    """A 500 kVA unit at 300 kVA is 60 % loaded, not 300/550 (the engine's
    own default rating is 110 % of nameplate)."""
    r = engine.solve(service())
    xf = next(e for e in r["elements"].values() if e["id"] == "xf")
    assert xf["loadingPct"] == pytest.approx(60, abs=1.5)


def test_probe_behind_a_transformer_finds_its_spare_kva():
    c = service()
    lv = next(b for b in engine.solve(c)["buses"] if b.lower().startswith("lv"))
    p = probe(c, lv)
    assert p["binding"] == "thermal"
    assert p["where"]["id"] == "xf"
    # 200 kVA of room at the probe's 0.95 pf.
    assert p["kw"] / 0.95 == pytest.approx(200, rel=0.04)


def test_headroom_table_agrees_with_the_probe():
    r = headroom.headroom(service())
    assert r["converged"], r["issues"]
    xf = next(x for x in r["rows"] if x["id"] == "xf")
    cell = xf["levels"]["Rated"]
    assert cell["ratingKva"] == pytest.approx(500, rel=0.01)
    assert cell["loadingPct"] == pytest.approx(60, abs=1.5)
    assert cell["spareKva"] == pytest.approx(200, rel=0.04)
    assert cell["limit"] == "thermal"
    assert cell["headroomKva"] == pytest.approx(200, rel=0.04)


def test_voltage_binds_first_on_a_long_feeder():
    c = service(load_kva=300, kva=2000, line_km=14)
    r = headroom.headroom(c)
    xf = next(x for x in r["rows"] if x["id"] == "xf")["levels"]["Rated"]
    assert xf["limit"] == "voltage"
    assert xf["headroomKw"] < xf["spareKw"]
    # The linear estimate is held to the exact search at the same bus.
    lv = next(b for b in engine.solve(c)["buses"] if b.lower().startswith("lv"))
    p = probe(c, lv)
    assert p["binding"] == "voltage"
    assert xf["headroomKw"] == pytest.approx(p["kw"], rel=0.10)


def test_one_column_per_level_and_spare_shrinks_with_growth():
    c = service().model_copy(update={"loadLevels": [
        LoadLevel(name="2026", loadmult=1.0), LoadLevel(name="2031", loadmult=1.2)]})
    r = headroom.headroom(c)
    assert [lv["name"] for lv in r["levels"]] == ["2026", "2031"]
    xf = next(x for x in r["rows"] if x["id"] == "xf")["levels"]
    assert xf["2031"]["spareKva"] < xf["2026"]["spareKva"]
    assert xf["2031"]["spareKva"] == pytest.approx(500 - 360, rel=0.05)


def test_installation_sample_and_route():
    d = json.loads((SAMPLES / "installation-campus.oneline.json").read_text())
    c = Circuit.model_validate(d)
    r = headroom.headroom(c, {"voltage": False})
    assert r["converged"]
    kinds = {x["kind"] for x in r["rows"]}
    assert "transformer" in kinds
    spares = [x["levels"][r["levels"][0]["name"]]["headroomKva"] for x in r["rows"]]
    assert spares == sorted(spares)
    client = TestClient(server.app, base_url="http://127.0.0.1")
    res = client.post("/api/jobs/headroom", json={"circuit": d, "options": {"voltage": False}})
    assert res.status_code == 200, res.text
    assert headroom.estimate_solves(c) > headroom.estimate_solves(c, {"voltage": False})
