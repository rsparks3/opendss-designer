"""Load allocation to a metered value by zone (facility plan 1.4)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.model import Allocation, Circuit, Scenario
from opendss_designer.studies.allocation import allocate_zone, bake

SAMPLES = Path(__file__).parent.parent / "src" / "opendss_designer" / "samples"


def sample(name: str, **patches: dict) -> Circuit:
    d = json.loads((SAMPLES / f"{name}.oneline.json").read_text())
    for n in d["nodes"]:
        n["params"].update(patches.get(n["id"], {}))
    d.pop("scenarios", None)
    return Circuit.model_validate(d)


def flow(result: dict, element_id: str) -> float:
    return abs(next(e for e in result["elements"].values() if e["id"] == element_id)["kw"])


def load_kw(c: Circuit, load_id: str) -> float:
    name = next(n.params["name"] for n in c.nodes if n.id == load_id).lower().replace(" ", "_")
    cmd = next(x for x in compile_circuit(c).commands if x.startswith(f"new load.{name} "))
    return float(cmd.split(" kw=")[1].split()[0])


def test_demo_substation_to_ninety_percent_in_three_or_fewer():
    c = sample("demo-substation")
    before = flow(engine.solve(c), "src")
    out = allocate_zone(c, Allocation(id="a", meterElementId="src", targetKW=0.9 * before))
    assert out["ok"] and out["converged"] and out["iterations"] <= 3
    assert out["achievedKw"] == pytest.approx(0.9 * before, rel=0.005)
    # Stored and applied at compile time; the entered values stay.
    c2 = c.model_copy(update={"allocations": [Allocation.model_validate(out["allocation"])]})
    assert flow(engine.solve(c2), "src") == pytest.approx(0.9 * before, rel=0.005)
    assert next(n for n in c2.nodes if n.id == "ld1").params["kw"] == 2000


def test_fixed_loads_keep_their_values():
    c = sample("demo-substation", ld2={"fixed": True})
    out = allocate_zone(c, Allocation(id="a", meterElementId="src", targetKW=1500))
    assert out["ok"] and out["converged"]
    c2 = c.model_copy(update={"allocations": [Allocation.model_validate(out["allocation"])]})
    assert load_kw(c2, "ld2") == 400
    assert load_kw(c2, "ld1") < 2000


def test_two_zones_allocate_independently_and_overlap_is_refused():
    c = sample("installation-campus")
    f1 = allocate_zone(c, Allocation(id="f1", meterElementId="brk_f1", targetKW=1000))
    assert f1["ok"] and f1["converged"]
    c = c.model_copy(update={"allocations": [Allocation.model_validate(f1["allocation"])]})
    f3 = allocate_zone(c, Allocation(id="f3", meterElementId="brk_f3", targetKW=1800))
    assert f3["ok"] and f3["converged"]
    c = c.model_copy(update={"allocations": [*c.allocations, Allocation.model_validate(f3["allocation"])]})
    r = engine.solve(c)
    assert flow(r, "brk_f1") == pytest.approx(1000, rel=0.005)
    assert flow(r, "brk_f3") == pytest.approx(1800, rel=0.005)
    assert load_kw(c, "ld_ops") == 600  # outside both zones
    clash = allocate_zone(c, Allocation(id="m", meterElementId="brk_m", targetKW=4000))
    assert not clash["ok"] and "overlap" in clash["error"]


def test_zone_stays_put_when_a_scenario_reconfigures():
    c = sample("installation-campus")
    out = allocate_zone(c, Allocation(id="u", meterElementId="util", targetKW=3800))
    c = c.model_copy(update={"allocations": [Allocation.model_validate(out["allocation"])]})
    scaled = load_kw(c, "ld_hosp")
    # The utility lost: its zone is still judged on the base drawing.
    c = c.model_copy(update={
        "scenarios": [Scenario(id="o", name="out", overrides={
            "util": {"enabled": False}, "gen1": {"enabled": True, "islandMode": "isochronous"}})],
        "activeScenario": "o"})
    assert load_kw(c, "ld_hosp") == pytest.approx(scaled)


def test_pf_target_and_bake():
    c = sample("demo-substation")
    out = allocate_zone(c, Allocation(id="a", meterElementId="brk1", targetKW=1500, targetPF=0.9))
    assert out["ok"] and out["converged"] and out["kvarFactor"] is not None
    c2 = c.model_copy(update={"allocations": [Allocation.model_validate(out["allocation"])]})
    before = engine.solve(c2)
    baked = bake(c2, "a")
    assert baked["ok"] and set(baked["overrides"]) == {"ld1"}
    d = json.loads(c2.model_dump_json())
    d["allocations"] = []
    for n in d["nodes"]:
        n["params"].update(baked["overrides"].get(n["id"], {}))
    after = engine.solve(Circuit.model_validate(d))
    assert flow(after, "brk1") == pytest.approx(flow(before, "brk1"), rel=1e-3)


def test_export_writes_scaled_values_with_a_comment():
    c = sample("demo-substation").model_copy(update={"allocations": [
        Allocation(id="a", meterElementId="brk1", targetKW=1800, lastFactor=0.9)]})
    text, _ = export_dss(c)
    assert "! allocated: kW scaled by 0.9000 (allocation a); entered 2000 kW" in text
    assert "kw=1800 " in text


def test_routes():
    client = TestClient(server.app, base_url="http://127.0.0.1")
    body = json.loads(sample("demo-substation").model_dump_json())
    r = client.post("/api/allocate/zone", json={
        "circuit": body, "allocation": {"id": "a", "meterElementId": "src", "targetKW": 2000}}).json()
    assert r["ok"] and r["converged"]
    body["allocations"] = [r["allocation"]]
    b = client.post("/api/allocate/bake", json={"circuit": body, "allocationId": "a"}).json()
    assert b["ok"] and b["overrides"]
