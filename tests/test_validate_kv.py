"""The bus kV sanity check reads a declaration the way OpenDSS does: a
single-phase wye element's kV is line-to-neutral, everything else is
line-to-line. Before this, every single-phase load on the IEEE 13-bus was
flagged against its own bus."""
from __future__ import annotations

from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode
from opendss_designer.core.validate import validate


def bus_with_load(load_params: dict) -> Circuit:
    return Circuit(
        name="kv",
        nodes=[
            CircuitNode(id="src", type="vsource",
                        params={"name": "src", "basekv": 4.16, "pu": 1.0, "phases": 3}),
            CircuitNode(id="bus", type="busbar", width=200, params={"name": "b", "basekv": 4.16}),
            CircuitNode(id="ld", type="load", params={"name": "ld", "kw": 100, "pf": 0.9,
                                                     "model": 1, **load_params}),
        ],
        edges=[
            CircuitEdge(id="w1", source="src", sourceHandle="t1", target="bus", targetHandle="b0"),
            CircuitEdge(id="w2", source="bus", sourceHandle="b1", target="ld", targetHandle="t1"),
        ])


def mismatches(circuit: Circuit) -> list[str]:
    return [i.message for i in validate(circuit) if i.code == "kv-mismatch"]


def test_single_phase_wye_load_declares_line_to_neutral():
    assert not mismatches(bus_with_load({"kv": 2.4, "phases": 1, "conn": "wye", "phasing": "B"}))


def test_single_phase_delta_load_declares_line_to_line():
    assert not mismatches(bus_with_load({"kv": 4.16, "phases": 1, "conn": "delta", "phasing": "BC"}))
    assert mismatches(bus_with_load({"kv": 2.4, "phases": 1, "conn": "delta", "phasing": "BC"}))


def test_three_phase_load_at_line_to_neutral_is_still_a_mismatch():
    assert mismatches(bus_with_load({"kv": 2.4, "phases": 3, "conn": "wye"}))
