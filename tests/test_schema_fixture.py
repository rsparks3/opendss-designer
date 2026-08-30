"""Schema-drift guard.

tests/fixtures/full-circuit.oneline.json contains every node type, both edge
types, handles, waypoints, and a busNames entry — exactly as the frontend's
toCircuitJSON emits them. The frontend's vitest suite round-trips the same
file through fromCircuitJSON/toCircuitJSON. If either side changes the wire
format, one of the two suites breaks and forces the mirror
(frontend/src/types/circuit.ts vs core/model.py) to be updated in lockstep.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from opendss_designer.core.compiler import compile_circuit
from opendss_designer.core.model import Circuit, NODE_TERMINALS
from opendss_designer.core.validate import validate

FIXTURE = Path(__file__).parent / "fixtures" / "full-circuit.oneline.json"


@pytest.fixture()
def fixture_json() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_covers_every_type(fixture_json):
    """Keep the fixture honest: it must exercise the full schema."""
    node_types = {n["type"] for n in fixture_json["nodes"]}
    edge_types = {e["type"] for e in fixture_json["edges"]}
    from opendss_designer.core import model

    assert node_types == set(model.NodeType.__args__)  # type: ignore[attr-defined]
    assert edge_types == set(model.EdgeType.__args__)  # type: ignore[attr-defined]
    assert any(e.get("waypoints") for e in fixture_json["edges"])
    assert fixture_json["busNames"]


def test_fixture_validates_and_round_trips(fixture_json):
    circuit = Circuit.model_validate(fixture_json)
    dumped = circuit.model_dump(mode="json")
    # Everything the frontend sent must survive the model unchanged.
    assert dumped["version"] == fixture_json["version"]
    assert dumped["name"] == fixture_json["name"]
    assert dumped["busNames"] == fixture_json["busNames"]
    assert dumped["nodes"] == [
        {**n, "height": None} for n in fixture_json["nodes"]
    ], "node round trip drifted (height is backend-optional and absent in exports)"
    assert dumped["edges"] == fixture_json["edges"]


def test_fixture_compiles_cleanly(fixture_json):
    circuit = Circuit.model_validate(fixture_json)
    assert not [i for i in validate(circuit) if i.severity == "error"]
    res = compile_circuit(circuit)
    assert not [i for i in res.issues if i.severity == "error"]
    # One command per element at minimum: circuit vsource, transformer,
    # line, breaker (as a switch line), load.
    joined = "\n".join(res.commands)
    for fragment in ("new circuit.", "new transformer.t1", "new line.ln1",
                     "new line.brk1", "new load.load1",
                     "new capacitor.cap1", "new generator.gen1"):
        assert fragment in joined.lower()


def test_node_terminals_matches_node_types():
    """Every fixed-terminal node type must declare its handles (busbars are
    dynamic and deliberately absent)."""
    from opendss_designer.core import model

    expected = set(model.NodeType.__args__) - {"busbar"}  # type: ignore[attr-defined]
    assert set(NODE_TERMINALS) == expected
