"""M16: faults along a line, reach, fuse saving, recloser placement,
sectionalizers and reclose intervals, the extra reliability indices."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import protection, reliability
from opendss_designer.core.compiler import compile_circuit
from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode
from opendss_designer.studies import faults, protection_depth

LINE = {"r1": 0.2, "x1": 0.4, "r0": 0.5, "x0": 1.2, "normamps": 300, "phases": 3, "units": "km"}


def protected_feeder() -> Circuit:
    """Source -> relay -> 2 km -> BUS1 -> recloser -> 3 km -> BUS2 -> fuse ->
    2 km -> BUS3 (load); BUS2 also carries a load. Customers on both."""
    return Circuit(name="prot", nodes=[
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3, "mvasc3": 300, "mvasc1": 300}),
        CircuitNode(id="rly", type="relay", params={"name": "RLY", "closed": True, "phases": 3, "phasetrip": 400, "groundtrip": 100,
                                                     "phasecurve": "very_inv", "groundcurve": "very_inv", "normamps": 600, "interruptingka": 20}),
        CircuitNode(id="bus1", type="busbar", width=240, params={"name": "BUS1", "basekv": 12.47}),
        CircuitNode(id="rec", type="recloser", params={"name": "REC", "closed": True, "phases": 3, "phasetrip": 200, "groundtrip": 60,
                                                        "phasefast": "a", "phasedelayed": "d", "groundfast": "a", "grounddelayed": "d",
                                                        "numfast": 1, "shots": 3,
                                                        "recloseintervals": [0.5, 2, 5], "normamps": 400, "interruptingka": 12}),
        CircuitNode(id="bus2", type="busbar", width=240, params={"name": "BUS2", "basekv": 12.47}),
        CircuitNode(id="fu", type="fuse", params={"name": "FU", "closed": True, "phases": 3, "ratedcurrent": 65, "fusecurve": "tlink",
                                                   "normamps": 100, "interruptingka": 10}),
        CircuitNode(id="bus3", type="busbar", width=240, params={"name": "BUS3", "basekv": 12.47}),
        CircuitNode(id="ld2", type="load", params={"name": "L2", "kv": 12.47, "kw": 600, "pf": 0.95, "phases": 3, "numcust": 40, "class": "commercial"}),
        CircuitNode(id="ld3", type="load", params={"name": "L3", "kv": 12.47, "kw": 300, "pf": 0.95, "phases": 3, "numcust": 60, "class": "residential"}),
    ], edges=[
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="rly", targetHandle="t1"),
        CircuitEdge(id="ln1", type="line", source="rly", sourceHandle="t2", target="bus1", targetHandle="b1", params={"name": "LN1", "length": 2, **LINE}),
        CircuitEdge(id="w1", type="wire", source="bus1", sourceHandle="b5", target="rec", targetHandle="t1"),
        CircuitEdge(id="ln2", type="line", source="rec", sourceHandle="t2", target="bus2", targetHandle="b1", params={"name": "LN2", "length": 3, **LINE}),
        CircuitEdge(id="w2", type="wire", source="bus2", sourceHandle="b5", target="fu", targetHandle="t1"),
        CircuitEdge(id="ln3", type="line", source="fu", sourceHandle="t2", target="bus3", targetHandle="b1", params={"name": "LN3", "length": 2, **LINE}),
        CircuitEdge(id="w3", type="wire", source="bus2", sourceHandle="b8", target="ld2", targetHandle="t1"),
        CircuitEdge(id="w4", type="wire", source="bus3", sourceHandle="b5", target="ld3", targetHandle="t1"),
    ])


def test_fault_on_a_line_sits_between_the_bus_values():
    c = protected_feeder()
    at_bus2 = faults.fault_point(c, "bus2", "3ph")["faultA"]
    at_bus3 = faults.fault_point(c, "bus3", "3ph")["faultA"]
    mid = protection_depth.fault_on_line(c, "ln3", 0.5, "3ph")
    assert mid["converged"], mid["issues"]
    assert at_bus3 < mid["faultA"] < at_bus2
    # Every upstream device carries it; the fuse most directly.
    assert mid["devices"]["line.fu"]["amps"] == pytest.approx(mid["faultA"], rel=0.1)
    assert mid["devices"]["line.rly"]["amps"] > 0.8 * mid["faultA"]
    near = protection_depth.fault_on_line(c, "ln3", 0.05, "lg", r_ohm=5.0)
    far = protection_depth.fault_on_line(c, "ln3", 0.95, "lg", r_ohm=5.0)
    assert near["faultA"] > far["faultA"]
    assert protection_depth.fault_on_line(c, "nope", 0.5)["converged"] is False


def test_reach_study_reads_every_device_and_counts_der_infeed():
    c = protected_feeder()
    r = protection_depth.reach_study(c, r_ohm=20.0)
    assert r["converged"], r["issues"]
    by = {d["name"]: d for d in r["devices"]}
    assert set(by) == {"RLY", "REC", "FU"}
    fu = by["FU"]
    assert fu["sectionBuses"] >= 1 and fu["minFaultA"] > 0 and fu["minFaultKind"] in ("ll", "lg")
    assert fu["reachRatio"] == pytest.approx(fu["seenByDeviceA"] / 65, rel=1e-3)
    assert by["REC"]["groundReachRatio"] is not None
    # Devices are listed weakest reach first.
    ratios = [d["reachRatio"] for d in r["devices"] if d["reachRatio"] is not None]
    assert ratios == sorted(ratios)
    # DER in the fuse's section takes from what the fuse sees.
    c2 = protected_feeder()
    c2.nodes.append(CircuitNode(id="pv", type="pvsystem", params={"name": "PV", "kv": 12.47, "kva": 500, "pmpp": 500, "phases": 3}))
    c2.edges.append(CircuitEdge(id="wpv", type="wire", source="bus3", sourceHandle="b8", target="pv", targetHandle="t1"))
    r2 = protection_depth.reach_study(c2, r_ohm=20.0)
    fu2 = next(d for d in r2["devices"] if d["name"] == "FU")
    assert fu2["derInfeedA"] > 0 and fu2["seenByDeviceA"] < fu2["minFaultA"]
    assert fu2["reachRatio"] < fu["reachRatio"]


def test_fuse_saving_pairs_the_recloser_with_its_fuse():
    r = protection_depth.fuse_saving(protected_feeder())
    assert r["converged"], r["issues"]
    (pair,) = r["pairs"]
    assert pair["fuse"] == "FU" and pair["recloser"] == "REC"
    assert pair["maxFaultA"] > pair["minFaultA"] > 0
    assert pair["recloserFastS"] is not None and pair["fuseMeltS"] is not None
    assert pair["fuseSaving"] == (pair["recloserFastS"] < pair["fuseMeltS"])
    assert pair["clearFrom"].startswith("melt x")
    assert pair["fuseBlowing"] == (pair["fuseClearS"] is not None and pair["recloserDelayedS"] is not None
                                   and pair["fuseClearS"] < pair["recloserDelayedS"])
    assert isinstance(pair["note"], str) and pair["note"]


def test_recloser_placement_ranks_by_saidi_fall():
    c = protected_feeder()
    r = protection_depth.recloser_placement(c)
    assert r["converged"], r["issues"]
    assert r["base"]["saidi"] > 0
    assert r["candidates"], "every line is a candidate"
    best = r["candidates"][0]
    assert best["saidiChange"] <= 0
    assert r["candidates"] == sorted(r["candidates"], key=lambda x: x["saidiChange"])
    assert {"line", "name", "lengthKm", "saifi", "saidi", "custHoursSaved"} <= set(best)


def test_sectionalizer_and_reclose_intervals_compile():
    c = protected_feeder()
    c.nodes.append(CircuitNode(id="sec", type="breaker", params={"name": "SEC", "closed": True, "phases": 3, "sectionalizer": True, "normamps": 400}))
    # Put the sectionalizer in LN2 by splitting it at a new bus.
    c.nodes.append(CircuitNode(id="busx", type="busbar", width=200, params={"name": "BUSX", "basekv": 12.47}))
    c.edges = [e for e in c.edges if e.id != "ln2"] + [
        CircuitEdge(id="ln2a", type="line", source="rec", sourceHandle="t2", target="busx", targetHandle="b1", params={"name": "LN2A", "length": 1.5, **LINE}),
        CircuitEdge(id="ws", type="wire", source="busx", sourceHandle="b5", target="sec", targetHandle="t1"),
        CircuitEdge(id="ln2b", type="line", source="sec", sourceHandle="t2", target="bus2", targetHandle="b1", params={"name": "LN2B", "length": 1.5, **LINE}),
    ]
    text = "\n".join(compile_circuit(c).commands).lower()
    assert "recloseintervals=(0.5, 2, 5)" in text
    assert "new relay.sec" in text and "phasetrip=1e9" in text
    # It heads a reliability section but never appears in the TCC plot.
    rel = reliability.reliability_study(c)
    assert rel["converged"], rel["issues"]
    assert any(s["headId"] == "sec" for s in rel["sections"])
    tcc = protection.tcc_study(c)
    assert "SEC" not in {d["name"].upper() for d in tcc["devices"]}


def test_extra_reliability_indices():
    r = reliability.reliability_study(protected_feeder())
    assert r["converged"], r["issues"]
    assert r["maifi"] is not None and r["maifi"] >= 0
    assert r["asai"] == pytest.approx(1 - r["saidi"] / 8760, abs=1e-6)
    assert set(r["cemi"]) == {"1", "2", "3", "5"} and 0 <= r["cemi"]["1"] <= 1
    assert r["asifi"] is not None and r["asifi"] > 0
    assert r["outageCost"] > 0 and r["outageCostRates"]["commercial"]["perInterruption"] == 1200.0
    assert r["loadsConsidered"] == 2
    # A feeder whose only device is a fuse has no momentary interruptions.
    c = protected_feeder()
    c.nodes = [n for n in c.nodes if n.id != "rec"]
    c.edges = [e for e in c.edges if e.id not in ("w1", "ln2")] + [
        CircuitEdge(id="ln2", type="line", source="bus1", sourceHandle="b5", target="bus2", targetHandle="b1", params={"name": "LN2", "length": 3, **LINE})]
    r2 = reliability.reliability_study(c)
    assert r2["converged"] and r2["maifi"] == 0


def test_m16_routes():
    client = TestClient(server.app, base_url="http://127.0.0.1")
    c = protected_feeder().model_dump(mode="json")
    res = client.post("/api/faultline", json={"circuit": c, "line": "ln3", "fraction": 0.5, "kind": "ll"})
    assert res.status_code == 200 and res.json()["converged"]
    res = client.post("/api/fusesaving", json={"circuit": c})
    assert res.status_code == 200 and res.json()["pairs"]
    import json as _json
    for path, body in (("/api/jobs/reach", {"circuit": c}),
                       ("/api/jobs/recloser-placement", {"circuit": c, "maxCandidates": 3})):
        res = client.post(path, json=body)
        assert res.status_code == 200, res.text
        with client.stream("GET", f"/api/jobs/{res.json()['job']['id']}/events") as stream:
            blocks = [ln for ln in stream.iter_lines() if ln.startswith("data: ")]
        assert _json.loads(blocks[-1][6:])["status"] == "done"
