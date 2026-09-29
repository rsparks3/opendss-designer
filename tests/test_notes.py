"""Notes are drawing annotations: the engine never sees them, the export
keeps them as comments, and they do not count against size limits."""
import json
from pathlib import Path

from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.connectivity import synthesize
from opendss_designer.core.model import Circuit, CircuitNode
from opendss_designer.core.validate import limit_issues, validate
from opendss_designer.settings import Settings

FIXTURE = Path(__file__).parent / "fixtures" / "full-circuit.oneline.json"


def _with_notes(substation_circuit: Circuit) -> Circuit:
    c = substation_circuit.model_copy(deep=True)
    c.nodes += [
        CircuitNode(id="nt1", type="note", params={"text": "Peak 2026\nper AMI", "target": "ld"}),
        CircuitNode(id="nt2", type="note", params={"text": "Feeder 12"}),
        CircuitNode(id="nt3", type="note", params={"text": "  "}),
    ]
    return c


def test_notes_are_invisible_to_the_engine(substation_circuit):
    c = _with_notes(substation_circuit)
    assert validate(c) == validate(substation_circuit)
    assert compile_circuit(c).commands == compile_circuit(substation_circuit).commands
    assert synthesize(c).node_buses["nt1"] == []
    solved = engine.solve(c)
    assert solved["converged"], solved["issues"]
    assert solved["losses"] == engine.solve(substation_circuit)["losses"]


def test_notes_export_as_comments(substation_circuit):
    text, _ = export_dss(_with_notes(substation_circuit))
    lines = text.splitlines()
    load = next(i for i, ln in enumerate(lines) if ln.lower().startswith("new load."))
    assert lines[load - 2:load] == ["! Note: Peak 2026", "!       per AMI"]
    first_new = next(i for i, ln in enumerate(lines) if ln.lower().startswith("new "))
    assert "! Note: Feeder 12" in lines[:first_new]
    assert sum(ln.startswith("! Note:") for ln in lines) == 2  # the blank one is dropped


def test_fixture_note_goes_above_the_circuit_line():
    circuit = Circuit.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))
    lines = export_dss(circuit)[0].splitlines()
    i = next(i for i, ln in enumerate(lines) if ln.lower().startswith("new circuit."))
    assert lines[i - 2:i] == ["! Note: Utility source", "!       Fault duty per 2026 study"]


def test_notes_do_not_count_against_the_element_limit(substation_circuit):
    c = _with_notes(substation_circuit)
    cfg = Settings(max_nodes=len(substation_circuit.nodes))
    assert not [i for i in limit_issues(c, cfg) if i.code == "limit-nodes"]
