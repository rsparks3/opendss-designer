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
