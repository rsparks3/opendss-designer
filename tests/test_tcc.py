"""Time-current curves: what the plot is drawn from."""
import json

import pytest

from opendss_designer.core import protection
from opendss_designer.core.model import Circuit

from test_protection import _feeder

FIXTURE = "tests/fixtures/full-circuit.oneline.json"


def _by_name(result, name):
    return next(d for d in result["devices"] if d["name"] == name)


def test_a_fuse_curve_comes_back_in_amps_and_seconds():
    result = protection.tcc_study(_feeder("fuse", {"ratedcurrent": 65, "fusecurve": "tlink"}))
    assert result["converged"], result["issues"]

    dev = _by_name(result, "dev1")
    assert dev["kind"] == "fuse"
    assert dev["nodeId"] == "dev"
    trace = dev["traces"][0]
    assert trace["curve"] == "tlink"
    assert trace["pickupA"] == 65
    # tlink starts at 2x rated current and 300 s, so the plot starts at 130 A.
    assert trace["points"][0] == [130.0, 300.0]
    # Monotonically faster as the current rises — that is what a TCC is.
    times = [t for _, t in trace["points"]]
    assert times == sorted(times, reverse=True)


def test_a_recloser_plots_both_its_curves_off_one_pickup():
    result = protection.tcc_study(_feeder("recloser", {"phasetrip": 120}))
    dev = _by_name(result, "dev1")
    labels = [t["label"] for t in dev["traces"]]
    assert labels == ["dev1 fast", "dev1 delayed"]
    assert all(t["pickupA"] == 120 for t in dev["traces"])
    fast, delayed = dev["traces"]
    assert [a for a, _ in fast["points"]] == [a for a, _ in delayed["points"]]
    # The fast curve is the faster one where a recloser does its fast tripping.
    # The engine's built-in A and D curves cross above about 10x pickup, where
    # A has flattened to its minimum response time and D is still steepening —
    # so this deliberately checks the low end rather than every point.
    assert fast["points"][1][1] < delayed["points"][1][1]  # 2.5x pickup
    for trace in dev["traces"]:
        times = [t for _, t in trace["points"]]
        assert times == sorted(times, reverse=True)


def test_a_relay_without_a_ground_curve_plots_one_trace():
    both = protection.tcc_study(_feeder("relay", {"groundcurve": "very_inv"}))
    assert len(_by_name(both, "dev1")["traces"]) == 2

    phase_only = protection.tcc_study(_feeder("relay", {"groundcurve": "none"}))
    traces = _by_name(phase_only, "dev1")["traces"]
    assert [t["label"] for t in traces] == ["dev1 phase"]


def test_added_delay_lifts_the_whole_curve():
    plain = protection.tcc_study(_feeder("fuse", {"ratedcurrent": 65, "delay": 0}))
    delayed = protection.tcc_study(_feeder("fuse", {"ratedcurrent": 65, "delay": 0.5}))
    a = _by_name(plain, "dev1")["traces"][0]["points"]
    b = _by_name(delayed, "dev1")["traces"][0]["points"]
    assert all(abs((tb - ta) - 0.5) < 1e-6 for (_, ta), (_, tb) in zip(a, b, strict=True))


def test_each_device_carries_the_fault_current_it_would_have_to_clear():
    result = protection.tcc_study(_feeder("recloser", {"phasetrip": 100}))
    dev = _by_name(result, "dev1")
    assert dev["bus"] == "bus_b"  # the device's downstream bus
    assert dev["faultA3ph"] and dev["faultA3ph"] > 1000
    assert dev["faultA1ph"] and dev["faultA1ph"] > 0
    # A fault this big is well past the pickup, so the device does see it.
    assert dev["faultA3ph"] > dev["traces"][0]["pickupA"]


def test_a_circuit_with_no_protection_plots_nothing_but_still_succeeds():
    circuit = _feeder("breaker", {})
    result = protection.tcc_study(circuit)
    assert result["converged"]
    assert result["devices"] == []


def test_the_fixture_feeder_returns_its_whole_protection_chain():
    with open(FIXTURE, encoding="utf-8") as fh:
        circuit = Circuit.model_validate(json.load(fh))
    result = protection.tcc_study(circuit)
    assert result["converged"]
    kinds = {d["kind"] for d in result["devices"]}
    assert kinds == {"fuse", "recloser", "relay"}
    # Every device maps back to the diagram element it belongs to.
    assert all(d["nodeId"] for d in result["devices"])


@pytest.mark.parametrize("device_type", ["fuse", "recloser", "relay"])
def test_curves_are_read_from_the_engine_not_invented(device_type):
    # Every point must sit on a multiple of the pickup that the engine's own
    # curve defines, which is what makes the plot and the solve agree.
    result = protection.tcc_study(_feeder(device_type, {}))
    for trace in _by_name(result, "dev1")["traces"]:
        pickup = trace["pickupA"]
        multiples = [round(a / pickup, 4) for a, _ in trace["points"]]
        assert multiples[0] >= 1.0
        assert multiples == sorted(multiples)


# --- coordination checks -------------------------------------------------

def _chain_circuit(upstream: dict, downstream: dict) -> Circuit:
    """Source -> upstream device -> mid bus -> downstream device -> load."""
    return Circuit.model_validate({
        "name": "chain",
        "nodes": [
            {"id": "src", "type": "vsource",
             "params": {"name": "SRC1", "basekv": 12.47, "pu": 1.0, "phases": 3,
                        "mvasc3": 2000, "mvasc1": 2100}},
            {"id": "b1", "type": "busbar", "params": {"name": "BUS-A", "basekv": 12.47}},
            {"id": "up", "type": upstream.pop("type"), "params": {"name": "UP", **upstream}},
            {"id": "b2", "type": "busbar", "params": {"name": "BUS-B", "basekv": 12.47}},
            {"id": "dn", "type": downstream.pop("type"), "params": {"name": "DN", **downstream}},
            {"id": "b3", "type": "busbar", "params": {"name": "BUS-C", "basekv": 12.47}},
            {"id": "ld", "type": "load",
             "params": {"name": "LOAD1", "kv": 12.47, "kw": 500, "pf": 0.95,
                        "phases": 3, "conn": "wye", "model": 1}},
        ],
        "edges": [
            {"id": "e1", "type": "wire", "source": "src", "sourceHandle": "t1",
             "target": "b1", "targetHandle": "b0"},
            {"id": "e2", "type": "wire", "source": "b1", "sourceHandle": "c0",
             "target": "up", "targetHandle": "t1"},
            {"id": "e3", "type": "wire", "source": "up", "sourceHandle": "t2",
             "target": "b2", "targetHandle": "b0"},
            {"id": "e4", "type": "wire", "source": "b2", "sourceHandle": "c0",
             "target": "dn", "targetHandle": "t1"},
            {"id": "e5", "type": "wire", "source": "dn", "sourceHandle": "t2",
             "target": "b3", "targetHandle": "b0"},
            {"id": "e6", "type": "wire", "source": "b3", "sourceHandle": "c0",
             "target": "ld", "targetHandle": "t1"},
        ],
    })


def _codes(result) -> list[str]:
    return [i["code"] for i in result["issues"]]


def test_the_walk_finds_which_device_is_upstream_of_which():
    with open(FIXTURE, encoding="utf-8") as fh:
        circuit = Circuit.model_validate(json.load(fh))
    result = protection.tcc_study(circuit)
    chains = protection._upstream_chain(circuit, result["devices"])
    # Station relay, then the mid-feeder recloser, then the lateral fuse.
    assert chains["rly1"] == []
    assert chains["rec1"] == ["rly1"]
    assert chains["fu1"] == ["rly1", "rec1"]


def test_a_device_that_cannot_see_its_own_fault_is_flagged():
    # A pickup far above anything the feeder can deliver.
    result = protection.tcc_study(_feeder("relay", {"phasetrip": 90000,
                                                    "groundcurve": "none"}))
    assert "pickup-above-fault" in _codes(result)
    msg = next(i["message"] for i in result["issues"]
               if i["code"] == "pickup-above-fault")
    assert "never trip" in msg


def test_a_downstream_device_slower_than_the_one_above_it_is_flagged():
    # Upstream relay set fast and sensitive, downstream one slow: backwards.
    result = protection.tcc_study(_chain_circuit(
        upstream={"type": "relay", "phasetrip": 50, "phasecurve": "definite",
                  "groundcurve": "none"},
        downstream={"type": "relay", "phasetrip": 300, "phasecurve": "ext_inv",
                    "groundcurve": "none", "delay": 2.0},
    ))
    assert "miscoordination" in _codes(result)
    msg = next(i["message"] for i in result["issues"] if i["code"] == "miscoordination")
    # The engine lowercases element names, so the message names them as it does.
    assert "'dn'" in msg and "'up'" in msg


def test_a_properly_graded_pair_is_not_flagged():
    # Downstream clears fast, upstream waits well past the margin.
    result = protection.tcc_study(_chain_circuit(
        upstream={"type": "relay", "phasetrip": 400, "phasecurve": "very_inv",
                  "groundcurve": "none", "delay": 3.0},
        downstream={"type": "relay", "phasetrip": 200, "phasecurve": "ext_inv",
                    "groundcurve": "none"},
    ))
    assert "miscoordination" not in _codes(result)


def test_a_breaker_gets_a_duty_check_even_though_it_has_no_curve():
    circuit = _feeder("breaker", {"interruptingka": 0.5})  # 500 A: far too small
    result = protection.tcc_study(circuit)
    assert result["devices"] == []  # nothing to plot, as expected
    switch = result["switches"][0]
    assert switch["kind"] == "breaker"
    assert switch["faultA3ph"] > 500
    assert "interrupting-duty" in _codes(result)
    msg = next(i["message"] for i in result["issues"] if i["code"] == "interrupting-duty")
    assert "0.5 kA" in msg


def test_a_breaker_within_its_rating_is_quiet():
    # The helper feeder has no impedance between source and device, so the
    # fault is the source's own 2000 MVA level — about 92 kA at 12.47 kV.
    result = protection.tcc_study(_feeder("breaker", {"interruptingka": 150}))
    assert "interrupting-duty" not in _codes(result)


def test_a_switch_with_no_rating_is_reported_but_not_judged():
    result = protection.tcc_study(_feeder("breaker", {}))
    switch = result["switches"][0]
    assert switch["interruptingKa"] is None
    assert switch["faultA3ph"] > 0
    assert "interrupting-duty" not in _codes(result)
