"""Reliability indices: SAIFI, SAIDI and CAIDI from the engine's EnergyMeter
calculation, with the protection sections it works from."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import reliability
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.importer import import_dss_files
from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode

FIXTURE = Path(__file__).parent / "fixtures" / "full-circuit.oneline.json"

LINE = {"r1": 0.12, "x1": 0.38, "r0": 0.4, "x0": 1.2, "normamps": 400, "phases": 3, "units": "km"}


def feeder() -> Circuit:
    """source -> relay -> 5 km trunk -> bus; bus -> fuse -> 2 km -> 50
    customers; bus -> 3 km -> 20 customers. The fused lateral takes 6 h to
    repair, the rest the default 3 h."""
    return Circuit(name="rel", nodes=[
        CircuitNode(id="src", type="vsource",
                    params={"name": "SRC", "basekv": 12.47, "phases": 3}),
        CircuitNode(id="rly", type="relay",
                    params={"name": "RLY", "closed": True, "phases": 3, "phasetrip": 200,
                            "phasecurve": "very_inv", "normamps": 600}),
        CircuitNode(id="bus", type="busbar", width=240, params={"name": "BUS", "basekv": 12.47}),
        CircuitNode(id="fu", type="fuse",
                    params={"name": "FU", "closed": True, "phases": 3, "ratedcurrent": 65,
                            "fusecurve": "tlink", "normamps": 100}),
        CircuitNode(id="ld1", type="load",
                    params={"name": "L1", "kv": 12.47, "kw": 500, "pf": 0.95, "phases": 3,
                            "numcust": 50}),
        CircuitNode(id="ld2", type="load",
                    params={"name": "L2", "kv": 12.47, "kw": 300, "pf": 0.95, "phases": 3,
                            "numcust": 20}),
    ], edges=[
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1",
                    target="rly", targetHandle="t1"),
        CircuitEdge(id="lnA", type="line", source="rly", sourceHandle="t2",
                    target="bus", targetHandle="b1", params={"name": "LNA", "length": 5, **LINE}),
        CircuitEdge(id="w1", type="wire", source="bus", sourceHandle="b3",
                    target="fu", targetHandle="t1"),
        CircuitEdge(id="lnB", type="line", source="fu", sourceHandle="t2",
                    target="ld1", targetHandle="t1",
                    params={"name": "LNB", "length": 2, "repair": 6, **LINE}),
        CircuitEdge(id="lnC", type="line", source="bus", sourceHandle="b7",
                    target="ld2", targetHandle="t1", params={"name": "LNC", "length": 3, **LINE}),
    ])


def test_indices_match_a_hand_calculation():
    """Default fault rate 0.1 per km per year, 20 % permanent. Section 1
    (relay, 8 km of line) interrupts all 70 customers; section 2 (fuse,
    2 km) only its 50. Switches add 1e-3 km each."""
    r = reliability.reliability_study(feeder())
    assert r["converged"], r["issues"]
    assert r["totalCustomers"] == 70
    lam1 = 0.1 * 0.2 * (5 + 3 + 0.001)
    lam2 = 0.1 * 0.2 * (2 + 0.001)
    cust_int = lam1 * 70 + lam2 * 50
    assert r["custInterrupts"] == pytest.approx(cust_int, rel=1e-4)
    assert r["saifi"] == pytest.approx(cust_int / 70, rel=1e-4)
    cust_hours = lam1 * 3 * 70 + (0.1 * 0.2 * 2 * 6 + 0.1 * 0.2 * 0.001 * 3) * 50
    assert r["saidi"] == pytest.approx(cust_hours / 70, rel=1e-4)
    assert r["caidi"] == pytest.approx(r["saidi"] / r["saifi"], rel=1e-3)
    # The engine's own per-zone figures agree with the section sums.
    (m,) = r["meters"]
    assert m["saifi"] == pytest.approx(r["saifi"], rel=1e-4)
    assert m["saidi"] == pytest.approx(r["saidi"], rel=1e-4)
    assert m["element"] == "line.rly" and m["elementId"] == "rly"
    assert not [i for i in r["issues"] if i["code"] in ("unsectioned", "no-customers")]


def test_sections_are_headed_by_the_protective_devices():
    r = reliability.reliability_study(feeder())
    heads = {s["head"]: s for s in r["sections"]}
    assert set(heads) == {"line.rly", "line.fu"}
    assert heads["line.rly"]["device"] == "relay"
    assert heads["line.rly"]["totalCustomers"] == 70
    assert heads["line.rly"]["customers"] == 20  # on its own buses
    assert heads["line.rly"]["branches"] == 3
    assert heads["line.rly"]["lengthKm"] == pytest.approx(8.0)
    assert heads["line.fu"]["device"] == "fuse"
    assert heads["line.fu"]["totalCustomers"] == 50
    assert heads["line.fu"]["avgRepairHrs"] == pytest.approx(6.0, abs=0.01)
    els = r["elements"]
    assert els["line.lnb"]["sectionId"] == heads["line.fu"]["id"]
    assert els["line.lnc"]["sectionId"] == heads["line.rly"]["id"]
    assert els["line.lnb"]["customers"] == 50 and els["line.lnb"]["repairHrs"] == 6.0
    assert els["line.lna"]["accumulatedLambda"] == pytest.approx(0.16, abs=1e-3)
    assert els["line.lna"]["id"] == "lnA"


def test_branches_above_the_first_device_are_reported_as_uncounted():
    """Put the relay's protection aside: a feeder whose head is a plain
    breaker has its trunk in no section, and the study says so instead of
    quietly reporting a tiny SAIFI."""
    c = feeder()
    rly = next(n for n in c.nodes if n.id == "rly")
    rly.type = "breaker"
    rly.params = {"name": "BRK", "closed": True, "normamps": 600, "phases": 3}
    r = reliability.reliability_study(c)
    assert r["converged"], r["issues"]
    assert r["unsectioned"]["count"] == 3  # breaker, trunk, LNC
    assert r["unsectioned"]["lambda"] == pytest.approx(0.1 * 0.2 * (8 + 0.001), rel=1e-3)
    assert [s["head"] for s in r["sections"]] == ["line.fu"]
    assert r["custInterrupts"] == pytest.approx(0.1 * 0.2 * 2.001 * 50, rel=1e-3)
    warning = next(i for i in r["issues"] if i["code"] == "unsectioned")
    assert "3 elements" in warning["message"] and "relay or recloser" in warning["message"]


def test_a_flagged_element_places_the_meter():
    """A meter on the fuse makes the fused lateral its own zone and leaves
    the rest of the feeder unmetered."""
    c = feeder()
    next(n for n in c.nodes if n.id == "fu").params["meter"] = True
    r = reliability.reliability_study(c)
    assert r["converged"], r["issues"]
    assert [m["element"] for m in r["meters"]] == ["line.fu"]
    assert r["totalCustomers"] == 50
    assert [s["head"] for s in r["sections"]] == ["line.fu"]
    assert "line.lnc" not in r["elements"]


def test_every_feeder_off_a_substation_bus_is_metered():
    """Two lines leave the source bus: each gets a meter, and the indices
    combine over both zones by customers."""
    c = feeder()
    c.nodes.append(CircuitNode(id="ld3", type="load",
                               params={"name": "L3", "kv": 12.47, "kw": 100, "pf": 0.95,
                                       "phases": 3, "numcust": 30}))
    c.nodes.append(CircuitNode(id="rec", type="recloser",
                               params={"name": "REC", "closed": True, "phases": 3,
                                       "normamps": 560}))
    c.edges.append(CircuitEdge(id="w2", type="wire", source="src", sourceHandle="t1",
                               target="rec", targetHandle="t1"))
    c.edges.append(CircuitEdge(id="lnD", type="line", source="rec", sourceHandle="t2",
                               target="ld3", targetHandle="t1",
                               params={"name": "LND", "length": 4, **LINE}))
    r = reliability.reliability_study(c)
    assert r["converged"], r["issues"]
    assert sorted(m["element"] for m in r["meters"]) == ["line.rec", "line.rly"]
    assert r["totalCustomers"] == 100
    by_el = {m["element"]: m for m in r["meters"]}
    assert by_el["line.rec"]["customers"] == 30
    assert r["custInterrupts"] == pytest.approx(
        sum(m["custInterrupts"] for m in r["meters"]), rel=1e-6)
    assert r["saifi"] == pytest.approx(r["custInterrupts"] / 100, rel=1e-6)
    assert r["saifiKw"] is None  # not combinable across zones


def test_reliability_parameters_compile_and_round_trip():
    c = feeder()
    joined = "\n".join(compile_circuit(c).commands)
    assert "new load.l1" in joined and "numcust=50" in joined
    assert "new line.lnb" in joined and "repair=6" in joined
    assert "faultrate" not in joined  # defaults are left to the engine
    trunk = next(e for e in c.edges if e.id == "lnA")
    trunk.params.update({"faultrate": 0.25, "pctperm": 35})
    text, _ = export_dss(c)
    line = next(ln for ln in text.splitlines() if ln.lower().startswith("new line.lna"))
    assert "faultrate=0.25 pctperm=35" in line
    # Import reads back what was not the default, and nothing else.
    back = Circuit.model_validate(import_dss_files([{"name": "rel.dss", "text": text}])["circuit"])
    lines = {e.params["name"].lower(): e.params for e in back.edges if e.type == "line"}
    assert lines["lna"]["faultrate"] == pytest.approx(0.25)
    assert lines["lna"]["pctperm"] == pytest.approx(35)
    assert "repair" not in lines["lna"]
    assert lines["lnb"]["repair"] == pytest.approx(6) and "faultrate" not in lines["lnb"]
    loads = {n.params["name"].lower(): n.params for n in back.nodes if n.type == "load"}
    assert loads["l1"]["numcust"] == 50 and loads["l2"]["numcust"] == 20


def test_fixture_runs_and_warns_about_its_unprotected_trunk():
    circuit = Circuit.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))
    r = reliability.reliability_study(circuit)
    assert r["converged"], r["issues"]
    assert r["totalCustomers"] == 2  # one per load by default
    assert {s["device"] for s in r["sections"]} == {"relay", "recloser", "fuse"}
    assert r["unsectioned"]["count"] > 0
    assert any(i["code"] == "unsectioned" for i in r["issues"])


def test_no_source_is_refused_cleanly():
    r = reliability.reliability_study(Circuit(nodes=[], edges=[]))
    assert not r["converged"]
    assert any(i["code"] == "no-source" for i in r["issues"])


def test_api_endpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "STATIC_DIR", tmp_path)
    client = TestClient(server.create_app(), base_url="http://127.0.0.1")
    res = client.post("/api/reliability", json=feeder().model_dump(mode="json"))
    assert res.status_code == 200
    body = res.json()
    assert body["converged"] and body["saifi"] > 0
