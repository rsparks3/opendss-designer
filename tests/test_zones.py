"""Zones are labelled rectangles behind groups of elements: drawing only,
like notes. The engine never sees them, the export records what each one
encloses as a comment, and they count against no size limit."""
import json
from pathlib import Path

from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.connectivity import synthesize
from opendss_designer.core.model import Circuit, CircuitNode, Position
from opendss_designer.core.validate import limit_issues, validate
from opendss_designer.settings import Settings

FIXTURE = Path(__file__).parent / "fixtures" / "full-circuit.oneline.json"


def _with_zones(substation_circuit: Circuit) -> Circuit:
    c = substation_circuit.model_copy(deep=True)
    for n in c.nodes:  # spread the elements out so a zone can take some
        n.position = Position(x={"src": 0, "t1": 0, "bb1": 0, "brk": 400, "ld": 400}[n.id], y=100)
    c.nodes += [
        CircuitNode(id="z1", type="zone", position=Position(x=-20, y=50), width=100, height=100,
                    params={"label": "Substation A", "color": "blue"}),
        CircuitNode(id="z2", type="zone", position=Position(x=380, y=50), width=100, height=100,
                    params={"label": "  Feeder 12 ", "color": "green"}),
        CircuitNode(id="z3", type="zone", position=Position(x=900, y=50), width=50, height=50,
                    params={"label": "Empty", "color": "grey"}),
        CircuitNode(id="z4", type="zone", position=Position(x=0, y=0), width=50, height=50,
                    params={"label": "", "color": "grey"}),
    ]
    return c


def test_zones_are_invisible_to_the_engine(substation_circuit):
    c = _with_zones(substation_circuit)
    assert validate(c) == validate(substation_circuit)
    assert compile_circuit(c).commands == compile_circuit(substation_circuit).commands
    assert synthesize(c).node_buses["z1"] == []
    solved = engine.solve(c)
    assert solved["converged"], solved["issues"]
    assert solved["losses"] == engine.solve(substation_circuit)["losses"]


def test_zones_export_as_comments_naming_what_they_enclose(substation_circuit):
    text, _ = export_dss(_with_zones(substation_circuit))
    lines = text.splitlines()
    first_new = next(i for i, ln in enumerate(lines) if ln.lower().startswith("new "))
    zone_lines = [ln for ln in lines[:first_new] if ln.startswith("! Zone:")]
    assert zone_lines == [
        "! Zone: Substation A - vsource.source, transformer.t1",
        "! Zone: Feeder 12 - line.brk1, load.l1, line.ln1",
        "! Zone: Empty",
    ]  # the unlabelled one is dropped


def test_fixture_zone_encloses_the_substation():
    circuit = Circuit.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))
    text, _ = export_dss(circuit)
    zone = next(ln for ln in text.splitlines() if ln.startswith("! Zone:"))
    assert zone.startswith("! Zone: Substation - ")
    assert "transformer.t1" in zone


def test_zones_do_not_count_against_the_element_limit(substation_circuit):
    c = _with_zones(substation_circuit)
    cfg = Settings(max_nodes=len(substation_circuit.nodes))
    assert not [i for i in limit_issues(c, cfg) if i.code == "limit-nodes"]
