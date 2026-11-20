"""Loss of utility (facility plan 1.3): a generator in isochronous mode
carries an island as a voltage source; the solve is read back by island."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit
from opendss_designer.core.model import Circuit
from opendss_designer.core.validate import validate
from opendss_designer.studies.islanding import solve_with_islands

SAMPLES = Path(__file__).parent.parent / "src" / "opendss_designer" / "samples"


def sample(name: str, **patches: dict) -> Circuit:
    d = json.loads((SAMPLES / f"{name}.oneline.json").read_text())
    for n in d["nodes"]:
        n["params"].update(patches.get(n["id"], {}))
    return Circuit.model_validate(d)


ISO = {"enabled": True, "islandMode": "isochronous"}


def outage(**more: dict) -> Circuit:
    return sample("installation-campus", util={"enabled": False}, gen1=ISO, gen2=ISO, **more)


def test_radial_feeder_with_a_generator_islands_on_it():
    d = json.loads((SAMPLES / "radial-feeder-der.oneline.json").read_text())
    d["nodes"].append({"id": "gen", "type": "generator", "params": {
        "name": "G1", "kv": 12.47, "kw": 800, "kva": 1250, "phases": 3, **ISO}})
    d["edges"].append({"id": "eg", "type": "wire", "source": "bus2", "target": "gen"})
    d["nodes"][0]["params"]["enabled"] = False  # the utility source
    c = Circuit.model_validate(d)
    cmds = compile_circuit(c).commands
    assert any(x.startswith("new vsource.g1 ") for x in cmds)
    assert not any(x.startswith("new generator.") for x in cmds)
    assert any(x.startswith("new pvsystem.") for x in cmds)  # PV and storage stay PQ
    assert any(x.startswith("new storage.") for x in cmds)
    r = solve_with_islands(c)
    assert r["converged"]
    live = [i for i in r["islands"]["islands"] if i["energized"]]
    assert len(live) == 1 and [s["id"] for s in live[0]["sources"]] == ["gen"]
    assert live[0]["servedKw"] == pytest.approx(900, rel=0.01)
    # The machine carries what PV does not.
    pv = next(e for e in r["elements"].values() if e["id"] == "pv1")
    assert live[0]["sources"][0]["kw"] == pytest.approx(900 - (-pv["kw"]) + r["losses"]["kw"], abs=5)
    assert 0.97 < live[0]["vminPu"] <= 1.0
    assert not [i for i in validate(c) if i.code == "island"]


def test_installation_outage_with_the_bus_tie_open():
    r = solve_with_islands(outage(brk_t={"closed": False}))
    isl = r["islands"]
    assert isl["energizedCount"] == 2
    by_source = {i["sources"][0]["id"]: i for i in isl["islands"] if i["energized"]}
    g1, g2 = by_source["gen1"], by_source["gen2"]
    assert g1["servedKw"] == pytest.approx(900 + 250, rel=0.01)
    assert g2["servedKw"] == pytest.approx(600 + 150 + 400 + 300 + 1200 + 300, rel=0.01)
    # G2 (2000 kVA) carrying 2950 kW is over its rating: red. G1 is not.
    assert g2["sources"][0]["loadingPct"] > 100 and g2["alarm"]
    assert g1["sources"][0]["loadingPct"] < 100 and not g1["alarm"]
    assert isl["unservedKw"]["critical"] == 0


def test_shedding_housing_brings_g2_inside_its_rating():
    r = solve_with_islands(outage(brk_t={"closed": False}, brk_f3={"closed": False}))
    isl = r["islands"]
    g2 = next(i for i in isl["islands"] if i["energized"] and i["sources"][0]["id"] == "gen2")
    assert g2["sources"][0]["loadingPct"] < 100 and not g2["alarm"]
    dark = [i for i in isl["islands"] if not i["energized"]]
    assert dark and dark[0]["unservedKw"]["nonessential"] == pytest.approx(1200)
    assert {d["id"] for d in isl["unservedLoads"]} == {"ld_hous", "ld_school"}
    assert isl["unservedLoads"][0]["priority"] == "essential"  # critical, essential first


def test_unserved_load_contributes_nothing():
    c = sample("installation-campus", brk_f3={"closed": False})
    r = solve_with_islands(c)
    hous = next(e for e in r["elements"].values() if e["id"] == "ld_hous")
    assert hous["kw"] == pytest.approx(0, abs=1e-6)
    base = solve_with_islands(sample("installation-campus"))
    assert r["losses"]["kw"] < base["losses"]["kw"]
    assert r["islands"]["unservedKw"]["essential"] == pytest.approx(300)


def test_no_source_at_all_is_said_out_loud():
    c = sample("installation-campus", util={"enabled": False})
    codes = {i.code for i in validate(c)}
    assert "no-energized-source" in codes
    r = solve_with_islands(c)
    assert r["islands"]["energizedCount"] == 0
    assert r["islands"]["unservedKw"]["critical"] == pytest.approx(1650)


def test_two_machines_on_one_island_warn():
    issues = [i for i in validate(outage()) if i.code == "parallel-sources"]
    assert len(issues) == 1 and "indicative" in issues[0].message
    assert not [i for i in validate(outage(brk_t={"closed": False})) if i.code == "parallel-sources"]


def test_fault_current_comes_from_the_subtransient_reactance():
    c = outage(brk_t={"closed": False})
    f = engine.fault_study(c)
    # G1: 1500 kVA, Xd'' 0.15 at 13.2 kV -> about 437 A for a fault at its bus.
    assert f["buses"]["hospital_mv"]["if3phA"] == pytest.approx(437, rel=0.1)
    stiff = [x for x in compile_circuit(c).commands if "vsource.g1" in x and x.startswith("new")]
    xd = [x for x in compile_circuit(c, fault=True).commands if "vsource.g1" in x and x.startswith("new")]
    assert "voltage-regulated" in stiff[0] and "Xd''=0.15" in xd[0]


def test_solve_route_carries_the_island_summary():
    client = TestClient(server.app, base_url="http://127.0.0.1")
    body = json.loads(outage(brk_t={"closed": False}).model_dump_json())
    r = client.post("/api/solve", json=body).json()
    assert r["converged"] and r["islands"]["energizedCount"] == 2


def test_islands_route_is_topology_only():
    client = TestClient(server.app, base_url="http://127.0.0.1")
    body = json.loads(sample("installation-campus", brk_f3={"closed": False}).model_dump_json())
    r = client.post("/api/islands", json=body).json()
    assert [i["energized"] for i in r["islands"]] == [True, False]
    assert r["unservedKw"]["nonessential"] == pytest.approx(1200)
    assert r["islands"][1]["loads"]["byPriority"]["essential"]["count"] == 1
