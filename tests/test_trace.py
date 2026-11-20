"""Upstream paths and downstream sets on the drawn topology (core/trace.py).

No engine: tracing is a graph question, so these run on the samples as
shipped plus small edits. The frontend's lib/trace.ts is held to the same
answers by trace.test.ts on the same samples."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import trace
from opendss_designer.core.model import Circuit, Scenario

SAMPLES = Path(__file__).parent.parent / "src" / "opendss_designer" / "samples"


def sample(name: str) -> Circuit:
    return Circuit.model_validate(json.loads((SAMPLES / f"{name}.oneline.json").read_text()))


def with_params(c: Circuit, **patches: dict) -> Circuit:
    c = c.model_copy(deep=True)
    for n in c.nodes:
        if n.id in patches:
            n.params.update(patches[n.id])
    for e in c.edges:
        if e.id in patches:
            e.params.update(patches[e.id])
    return c


def loads_below(c: Circuit, element_id: str) -> set[str]:
    return {r["id"] for r in trace.downstream(trace.build(c), element_id)["loads"]["rows"]}


# --- IEEE 13-bus: the path from every load back to the substation ------------

# Load bus -> the buses after 632 on its way to the source (EPRI's one-line).
IEEE13_TAIL = {
    "671": ["632", "670", "671"],
    "634": ["632", "633", "634"],
    "645": ["632", "645"],
    "646": ["632", "645", "646"],
    "652": ["632", "670", "671", "684", "652"],
    "611": ["632", "670", "671", "684", "611"],
    "692": ["632", "670", "671", "692"],
    "675": ["632", "670", "671", "692", "675"],
    "670": ["632", "670"],
}


def test_ieee13_every_load_traces_to_the_substation():
    c = sample("ieee-13-bus")
    topo = trace.build(c)
    loads = [n for n in c.nodes if n.type == "load"]
    assert len(loads) == 15
    for n in loads:
        paths = trace.upstream_paths(topo, n.id)
        assert len(paths) == 1, n.params.get("name")
        buses = paths[0]["buses"]
        assert buses[:3] == ["sourcebus", "650", "rg60"], n.params.get("name")
        assert buses[3:] == IEEE13_TAIL[buses[-1]], n.params.get("name")
        # One series element between each pair of consecutive buses.
        assert len(paths[0]["elements"]) == len(buses) - 1


def test_ieee13_downstream_of_the_head_is_every_load():
    c = sample("ieee-13-bus")
    head = next(n.id for n in c.nodes if n.params.get("name") == "sub")
    assert loads_below(c, head) == {n.id for n in c.nodes if n.type == "load"}


# --- The installation: feeders, laterals, the open tie ---------------------

def test_feeder_breaker_drops_its_feeder_and_a_fuse_its_lateral():
    c = sample("installation-campus")
    assert loads_below(c, "brk_f1") == {"ld_hosp", "ld_clinic"}
    assert loads_below(c, "fu_clinic") == {"ld_clinic"}
    assert loads_below(c, "brk_f3") == {"ld_hous", "ld_school"}
    assert loads_below(c, "brk_t") == {"ld_ops", "ld_comms", "ld_wh", "ld_dining",
                                       "ld_hous", "ld_school"}
    every = {n.id for n in c.nodes if n.type == "load"}
    assert loads_below(c, "util") == every
    assert loads_below(c, "brk_m") == every
    assert loads_below(c, "bus_hosp") == {"ld_hosp", "ld_clinic"}


def test_downstream_totals_by_priority():
    c = sample("installation-campus")
    out = trace.downstream(trace.build(c), "util")["loads"]
    assert out["byPriority"]["critical"]["kw"] == pytest.approx(900 + 600 + 150)
    assert out["byPriority"]["essential"]["kw"] == pytest.approx(250 + 300 + 300)
    assert out["byPriority"]["nonessential"]["numcust"] == 301
    assert out["rows"][0]["priority"] == "critical"
    assert [r["priority"] for r in out["rows"]] == sorted(
        (r["priority"] for r in out["rows"]), key=trace.PRIORITIES.index)


def test_closing_the_tie_makes_feeder_three_a_loop():
    c = with_params(sample("installation-campus"), brk_tie={"closed": True})
    assert loads_below(c, "brk_f3") == set()
    paths = trace.upstream_paths(trace.build(c), "ld_school")
    assert len(paths) == 1  # one source, the shorter way round
    assert "brk_f3" in paths[0]["elements"]


def test_open_and_out_of_service_elements_break_the_path():
    c = with_params(sample("installation-campus"), brk_f3={"closed": False})
    topo = trace.build(c)
    assert trace.upstream_paths(topo, "ld_hous") == []
    assert loads_below(c, "brk_f3") == set()  # already open: nothing more to drop
    assert loads_below(c, "brk_t") == {"ld_ops", "ld_comms", "ld_wh", "ld_dining"}
    c = with_params(sample("installation-campus"), ln_f1={"enabled": False})
    assert trace.upstream_paths(trace.build(c), "ld_hosp") == []


def test_first_protective_device_upstream():
    topo = trace.build(sample("installation-campus"))
    assert trace.first_protective_upstream(topo, "ld_clinic") == "fu_clinic"
    assert trace.first_protective_upstream(topo, "ld_hosp") == "brk_f1"
    assert trace.first_protective_upstream(topo, "brk_f1") == "brk_m"


def test_an_isochronous_generator_is_a_source():
    c = with_params(sample("installation-campus"), util={"enabled": False},
                    gen1={"enabled": True, "islandMode": "isochronous"})
    topo = trace.build(c)
    assert set(topo.sources) == {"gen1"}
    assert [p["sourceId"] for p in trace.upstream_paths(topo, "ld_hosp")] == ["gen1"]
    # The bus tie still closes main bus A to B, so G1 reaches every load.
    assert trace.upstream_paths(topo, "ld_hous")[0]["sourceId"] == "gen1"
    # A generator in grid mode is not.
    c = with_params(c, gen1={"islandMode": "grid"})
    assert trace.build(c).sources == {}


def test_the_open_scenario_is_applied():
    c = sample("installation-campus").model_copy(deep=True)
    c.scenarios = [Scenario(id="sc1", name="F1 open", overrides={"brk_f1": {"closed": False}})]
    c.activeScenario = "sc1"
    out = trace.trace(c, "ld_hosp")
    assert out["found"] and out["upstream"] == []


# --- Two sources on a loop --------------------------------------------------

def test_loop_returns_a_path_to_each_source():
    topo = trace.build(sample("looped-two-source"))
    paths = trace.upstream_paths(topo, "ld_c")
    assert [p["sourceId"] for p in paths] == ["sa", "sb"]
    assert paths[0]["elements"] == ["l1"]
    assert paths[1]["elements"] == ["l3", "l2"]
    assert paths[1]["buses"] == ["bus_b", "bus_d", "bus_c"]


def test_loop_device_drops_nothing_and_the_spur_fuse_its_spur():
    c = sample("looped-two-source")
    assert loads_below(c, "l2") == set()
    assert loads_below(c, "sa") == set()
    assert loads_below(c, "fu_e") == {"ld_e"}
    assert loads_below(c, "bus_d") == {"ld_d", "ld_e"}


def test_islands():
    c = with_params(sample("installation-campus"), brk_t={"closed": False})
    parts = trace.islands(trace.build(c))
    energized = [p for p in parts if p["energized"]]
    assert len(energized) == 1 and energized[0]["sources"] == ["util"]
    c = with_params(c, util={"enabled": False},
                    gen1={"enabled": True, "islandMode": "isochronous"},
                    gen2={"enabled": True, "islandMode": "isochronous"})
    parts = [p for p in trace.islands(trace.build(c)) if p["energized"]]
    assert sorted(p["sources"][0] for p in parts) == ["gen1", "gen2"]


# --- The route --------------------------------------------------------------

def test_trace_route():
    client = TestClient(server.app, base_url="http://127.0.0.1")
    body = json.loads((SAMPLES / "installation-campus.oneline.json").read_text())
    r = client.post("/api/trace", json={"circuit": body, "elementId": "fu_clinic"})
    assert r.status_code == 200
    out = r.json()
    assert out["found"] and out["firstProtective"] == "brk_f1"
    assert [x["id"] for x in out["downstream"]["loads"]["rows"]] == ["ld_clinic"]
    r = client.post("/api/trace", json={"circuit": body, "elementId": "nope"})
    assert r.json() == {"elementId": "nope", "found": False, "upstream": [],
                        "downstream": None, "firstProtective": None}
