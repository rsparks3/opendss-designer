"""M15: conductor and geometry libraries, split-phase service transformers,
model QA, transformer load management, load allocation, catalogues."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import catalog, engine, qa
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.importer import import_dss_files
from opendss_designer.core.model import (
    Circuit,
    CircuitEdge,
    CircuitNode,
    GeometryConductor,
    LineGeometrySpec,
    LoadShapeSpec,
    WireDataSpec,
)
from opendss_designer.core.validate import validate
from opendss_designer.studies import allocation, secondary

WIRES = {
    "acsr336": WireDataSpec(rac=0.306, gmr=0.0244, radius=0.3605, normamps=530),
    "acsr1_0": WireDataSpec(rac=1.12, gmr=0.00446, radius=0.199, normamps=230),
}
GEOM = LineGeometrySpec(nconds=4, nphases=3, reduce=True, units="ft", conductors=[
    GeometryConductor(wire="acsr336", x=-4, h=28), GeometryConductor(wire="acsr336", x=-1.5, h=28),
    GeometryConductor(wire="acsr336", x=3, h=28), GeometryConductor(wire="acsr1_0", x=0, h=24)])


def geometry_feeder() -> Circuit:
    return Circuit(name="geo", nodes=[
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3}),
        CircuitNode(id="bus", type="busbar", width=240, params={"name": "BUS", "basekv": 12.47}),
        CircuitNode(id="ld", type="load", params={"name": "L1", "kv": 12.47, "kw": 1500, "pf": 0.95, "phases": 3}),
    ], edges=[
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="bus", targetHandle="b1"),
        CircuitEdge(id="ln", type="line", source="bus", sourceHandle="b5", target="ld", targetHandle="t1",
                    params={"name": "LN", "length": 2, "units": "mi", "phases": 3, "geometry": "pole3"}),
    ], wireData=WIRES, lineGeometries={"pole3": GEOM})


def test_geometry_compiles_solves_and_round_trips():
    c = geometry_feeder()
    text = "\n".join(compile_circuit(c).commands).lower()
    assert "new wiredata.acsr336" in text and "gmrac=0.0244" in text and "gmrunits=ft" in text
    assert "new linegeometry.pole3 nconds=4 nphases=3 reduce=yes" in text
    assert "cond=4 wire=acsr1_0 x=0 h=24 units=ft" in text
    assert "geometry=pole3" in text and "normamps=" not in text.split("new line.ln")[1].split("\n")[0]
    r = engine.solve(c)
    assert r["converged"], r["issues"]
    # The 336 ACSR carries 530 A: the geometry's rating reached the line.
    assert r["elements"]["line.ln"]["normAmps"] == pytest.approx(530, rel=0.01)
    v1 = r["buses"]["ld"]["vminPu"] if "ld" in r["buses"] else min(b["vminPu"] for b in r["buses"].values())
    exported, _ = export_dss(c)
    back = Circuit.model_validate(import_dss_files([{"name": "geo.dss", "text": exported}])["circuit"])
    assert set(back.wireData) == {"acsr336", "acsr1_0"}
    assert back.lineGeometries["pole3"].nconds == 4 and len(back.lineGeometries["pole3"].conductors) == 4
    assert back.lineGeometries["pole3"].conductors[3].wire.lower() == "acsr1_0"
    line = next(e for e in back.edges if e.type == "line")
    assert line.params["geometry"] == "pole3" and "linecode" not in line.params
    assert not any(p.name.lower().startswith(("wiredata.", "linegeometry.")) for p in back.passthrough)
    r2 = engine.solve(back)
    assert min(b["vminPu"] for b in r2["buses"].values()) == pytest.approx(v1, abs=1e-4)


def test_missing_geometry_or_wire_is_an_error():
    c = geometry_feeder()
    c.edges[1].params["geometry"] = "nope"
    res = compile_circuit(c)
    assert any(i.code == "bad-geometry" and i.edgeId == "ln" for i in res.issues)
    c = geometry_feeder()
    c.lineGeometries["pole3"].conductors[0].wire = "ghost"
    assert any(i.code == "bad-geometry" for i in compile_circuit(c).issues)


def split_phase_feeder() -> Circuit:
    return Circuit(name="svc", nodes=[
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3}),
        CircuitNode(id="bus", type="busbar", width=240, params={"name": "BUS", "basekv": 12.47}),
        CircuitNode(id="xf", type="transformer",
                    params={"name": "T1", "phases": 1, "splitphase": True, "xhl": 2.0, "pctloadloss": 1.2,
                            "windings": [{"kv": 7.2, "kva": 25, "conn": "wye"}, {"kv": 0.12, "kva": 25, "conn": "wye"}],
                            "phasing": "B"}),
        CircuitNode(id="lv", type="busbar", width=200, params={"name": "LV", "basekv": 0.208}),
        CircuitNode(id="la", type="load", params={"name": "LA", "kv": 0.12, "kw": 5, "pf": 0.95, "phases": 1, "phasing": "A"}),
        CircuitNode(id="lb", type="load", params={"name": "LB", "kv": 0.12, "kw": 8, "pf": 0.95, "phases": 1, "phasing": "B"}),
        CircuitNode(id="lab", type="load", params={"name": "LAB", "kv": 0.24, "kw": 6, "pf": 0.95, "phases": 2, "phasing": "A-B"}),
    ], edges=[
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="bus", targetHandle="b1"),
        CircuitEdge(id="w1", type="wire", source="bus", sourceHandle="b5", target="xf", targetHandle="t1"),
        CircuitEdge(id="w2", type="wire", source="xf", sourceHandle="t2", target="lv", targetHandle="b1"),
        CircuitEdge(id="w3", type="wire", source="lv", sourceHandle="b3", target="la", targetHandle="t1"),
        CircuitEdge(id="w4", type="wire", source="lv", sourceHandle="b5", target="lb", targetHandle="t1"),
        CircuitEdge(id="w5", type="wire", source="lv", sourceHandle="b7", target="lab", targetHandle="t1"),
    ], voltageBases=[12.47, 0.208])


def test_split_phase_transformer_serves_120_and_240_volt_loads():
    c = split_phase_feeder()
    assert not [i for i in validate(c) if i.severity == "error"], validate(c)
    text = "\n".join(compile_circuit(c).commands).lower()
    assert "phases=1 windings=3" in text and ".1.0," in text and ".0.2)" in text
    assert "xhl=2.4 xht=2.4 xlt=1.6" in text and "%rs=(0.6, 1.2, 1.2)" in text
    r = engine.solve(c)
    assert r["converged"], r["issues"]
    lv = r["buses"]["lv"]
    # Both 120 V legs are energised near 1 pu.
    assert len(lv["vmagPu"]) == 2 and all(0.9 < v < 1.05 for v in lv["vmagPu"])
    assert r["elements"]["load.lab"]["kw"] == pytest.approx(6, rel=0.05)
    assert r["elements"]["transformer.t1"]["loadingPct"] == pytest.approx(100 * 19 / 25, rel=0.15)


def test_qa_report_lists_what_a_planner_wants_fixed():
    c = split_phase_feeder()
    c.edges.append(CircuitEdge(id="ln", type="line", source="bus", sourceHandle="b7", target="bus", targetHandle="b9",
                               params={"name": "LOOP", "length": 80, "units": "km", "phases": 3,
                                       "r1": 0.12, "x1": 0.38, "r0": 0.4, "x0": 1.2, "normamps": 400}))
    r = qa.qa_report(c)
    codes = {f["code"] for f in r["findings"]}
    assert {"long-line", "placeholder-impedance", "default-rating", "loop"} <= codes
    assert r["score"] < 100
    load_row = next(x for x in r["completeness"] if x["class"] == "load")
    assert load_row["missing"]["customers"] == 3 and load_row["missing"]["class"] == 3
    client = TestClient(server.app, base_url="http://127.0.0.1")
    res = client.post("/api/qa", json={"circuit": c.model_dump(mode="json")})
    assert res.status_code == 200 and res.json()["findings"]


def test_transformer_loading_and_secondary_voltage():
    c = split_phase_feeder()
    c.loadShapes = {"day": LoadShapeSpec(intervalMin=60, points=[0.5] * 17 + [3.0] * 3 + [0.6] * 4)}
    for n in c.nodes:
        if n.type == "load":
            n.params["loadshape"] = "day"
            n.params["kw"] = float(n.params["kw"]) * 1.5
    r = secondary.transformer_loading(c, mode="daily")
    assert r["converged"], r["issues"]
    (t,) = r["transformers"]
    assert t["name"] == "T1" and t["kva"] == 25
    assert t["peakPct"] > 150 and t["hoursOver100"] >= 3 and t["hoursOver150"] >= 3
    assert t["lossOfLifePctPerYear"] > 0 and t["maxHotSpotC"] > 110
    assert t["flag"] == "overloaded"
    assert len(r["services"]) == 3
    lowest = r["services"][0]
    assert lowest["minV120"] < 120 and lowest["minHour"] >= 17
    assert r["summary"]["overloaded"] == 1
    theta, faa = secondary.aging_factor(1.0, 30.0)
    assert theta == pytest.approx(110, abs=0.5) and faa == pytest.approx(1.0, abs=0.02)


def test_allocation_from_kwh_kw_and_intervals():
    c = split_phase_feeder()
    for n in c.nodes:
        if n.type == "load":
            n.params["class"] = "residential"
    r = allocation.allocate(c, [{"key": "LA", "kwh": 1460}, {"key": "lb", "kw": 4}, {"key": "nobody", "kwh": 1}],
                            {"hours": 730, "loadFactor": {"residential": 0.4}})
    assert r["converged"], r["issues"]
    assert r["overrides"]["la"]["kw"] == pytest.approx(1460 / (730 * 0.4))
    assert r["overrides"]["lb"]["kw"] == 4
    assert r["unmatched"] == ["nobody"] and r["noData"] == ["LAB"]
    assert r["headKwBefore"] and r["headKwAfter"]
    # Intervals make a shape and take the peak; a head target scales everything.
    r2 = allocation.allocate(c, [{"key": "LA", "values": [2, 4, 8, 4]}, {"key": "LB", "kw": 8}, {"key": "LAB", "kw": 6}],
                             {"targetHeadKw": 30.0})
    assert r2["loadShapes"]["ami_LA"]["points"] == [0.25, 0.5, 1.0, 0.5]
    assert r2["overrides"]["la"]["loadshape"] == "ami_LA"
    assert r2["headKwAfter"] == pytest.approx(30.0, rel=0.02)
    assert r2["scale"] and r2["scale"] > 1
    # Keyed by class, a row splits evenly over the class's loads.
    r3 = allocation.allocate(c, [{"key": "residential", "kw": 30}], {"keyBy": "class"})
    assert all(o["kw"] == 10 for o in r3["overrides"].values()) and len(r3["overrides"]) == 3


def _finished(client, res):
    """Follow a job to its end, so the study thread is done with the engine
    before the next test clears it (a race that only ever lost on Linux)."""
    assert res.status_code == 200, res.text
    job_id = res.json()["job"]["id"]
    with client.stream("GET", f"/api/jobs/{job_id}/events") as stream:
        for _ in stream.iter_lines():
            pass
    return client.get(f"/api/jobs/{job_id}").json()


def test_catalogues_load_and_routes_serve_them():
    w = catalog.load_wires()
    assert not w["errors"] and len(w["wires"]) >= 15
    cn = next(x for x in w["wires"] if x["kind"] == "cn")
    assert cn["spec"]["extra"]["k"] == 13 or cn["spec"]["extra"]["k"] == 6
    t = catalog.load_transformers()
    assert not t["errors"] and any(x["splitphase"] for x in t["transformers"])
    client = TestClient(server.app, base_url="http://127.0.0.1")
    assert client.get("/api/catalog/wires").json()["wires"]
    assert client.get("/api/catalog/transformers").json()["transformers"]
    c = split_phase_feeder()
    res = client.post("/api/jobs/transformer-loading", json={"circuit": c.model_dump(mode="json"), "mode": "daily"})
    assert _finished(client, res)["status"] == "done"
    res = client.post("/api/allocate", json={"circuit": c.model_dump(mode="json"), "rows": [{"key": "LA", "kw": 3}], "options": {}})
    assert res.status_code == 200 and res.json()["overrides"]["la"]["kw"] == 3


def test_pinned_two_phase_line_on_a_geometry_keeps_its_nodes():
    """EPRI ckt5's laterals are `bus1=x.1.3` lines on two-phase geometries. The
    geometry branch of the importer skipped the node pins, so the export put
    them on phases 1 and 2 and bus 8086 came back at 58 pu."""
    text = """
clear
new circuit.two basekv=12.47 phases=3 bus1=src
new wiredata.acsr rac=1.12 runits=mi gmrac=0.00446 gmrunits=ft radius=0.199 radunits=in normamps=230
new linegeometry.g2 nconds=2 nphases=2 reduce=no units=ft
~ cond=1 wire=acsr x=-3 h=28
~ cond=2 wire=acsr x=3 h=28
new line.lat bus1=src.1.3 bus2=end.1.3 phases=2 geometry=g2 length=0.5 units=mi
new load.ld bus1=end.1.3 phases=1 conn=delta kv=12.47 kw=50 pf=0.95
set voltagebases=[12.47]
calcvoltagebases
"""
    back = Circuit.model_validate(import_dss_files([{"name": "two.dss", "text": text}])["circuit"])
    line = next(e for e in back.edges if e.type == "line")
    assert line.params["geometry"].lower() == "g2"
    exported, _ = export_dss(back)
    lat = next(l for l in exported.lower().splitlines() if l.startswith("new line.lat"))
    assert ".1.3" in lat, lat
    assert engine.solve(back)["converged"]
