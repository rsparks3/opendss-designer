from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.model import Circuit, CircuitNode, LoadShapeSpec


def test_substation_commands(substation_circuit):
    res = compile_circuit(substation_circuit)
    assert not [i for i in res.issues if i.severity == "error"]
    joined = "\n".join(res.commands)
    assert joined.startswith("clear\n")
    assert "new circuit.test_substation basekv=115 pu=1 angle=0 phases=3" in joined
    assert "new transformer.t1 phases=3 windings=2" in joined
    assert "conns=(delta, wye) kvs=(115, 12.47)" in joined
    assert "new line.ln1" in joined and "length=0.5 units=km" in joined
    assert "new line.brk1" in joined and "switch=yes" in joined
    assert "new load.l1" in joined and "kw=2000" in joined
    assert "set voltagebases=[12.47, 115]" in joined
    assert res.commands[-1] == "calcvoltagebases"


def test_no_source_is_error():
    res = compile_circuit(Circuit(nodes=[], edges=[]))
    assert any(i.code == "no-source" for i in res.issues)


def test_duplicate_names_detected():
    c = Circuit(nodes=[
        CircuitNode(id="s", type="vsource", params={"basekv": 12.47}),
        CircuitNode(id="l1", type="load", params={"name": "Load 1", "kv": 12.47}),
        CircuitNode(id="l2", type="load", params={"name": "load_1", "kv": 12.47}),
    ])
    res = compile_circuit(c)
    assert any(i.code == "duplicate-name" for i in res.issues)


def test_default_rating_warning(substation_circuit):
    for e in substation_circuit.edges:
        if e.type == "line":
            e.params.pop("normamps")
    res = compile_circuit(substation_circuit)
    assert any(i.code == "default-rating" for i in res.issues)
    assert any("normamps=400" in c for c in res.commands)


def test_open_breaker_emits_open_command(substation_circuit):
    next(n for n in substation_circuit.nodes if n.id == "brk").params["closed"] = False
    res = compile_circuit(substation_circuit)
    assert "open line.brk1 term=1" in res.commands


def test_loadshape_emission_and_assignment(substation_circuit):
    substation_circuit.loadShapes = {
        "Day Shape": LoadShapeSpec(intervalMin=60, points=[0.4, 1.0, 0.6])}
    load = next(n for n in substation_circuit.nodes if n.id == "ld")
    load.params["loadshape"] = "Day Shape"
    res = compile_circuit(substation_circuit)
    assert not [i for i in res.issues if i.severity == "error"]
    shape_cmd = next(c for c in res.commands if c.startswith("new loadshape."))
    assert shape_cmd == "new loadshape.day_shape npts=3 minterval=60 mult=(0.4 1 0.6)"
    # Shapes come after `new circuit` and before any element referencing them.
    idx_circuit = next(i for i, c in enumerate(res.commands) if c.startswith("new circuit."))
    idx_load = next(i for i, c in enumerate(res.commands) if c.startswith("new load."))
    assert idx_circuit < res.commands.index(shape_cmd) < idx_load
    assert "daily=day_shape yearly=day_shape" in res.commands[idx_load]


def test_large_loadshape_goes_to_side_file(tmp_path, substation_circuit):
    """Solve path (shape_dir given): big shapes become mult=(file=...) + an
    aux_files entry; export path (no shape_dir) stays fully inline."""
    substation_circuit.loadShapes = {
        "year": LoadShapeSpec(intervalMin=60, points=[0.5] * 8760),
        "day": LoadShapeSpec(intervalMin=60, points=[0.5] * 24),
    }
    res = compile_circuit(substation_circuit, shape_dir=tmp_path)
    year_cmd = next(c for c in res.commands if c.startswith("new loadshape.year"))
    assert 'mult=(file="' in year_cmd and "shape_year.csv" in year_cmd
    assert res.aux_files["shape_year.csv"].count("\n") == 8760
    day_cmd = next(c for c in res.commands if c.startswith("new loadshape.day"))
    assert "file=" not in day_cmd  # small shapes stay inline even for solves

    text, _ = export_dss(substation_circuit)
    assert "file=" not in text  # exports remain a single portable file
    assert "new loadshape.year npts=8760" in text


def test_missing_loadshape_is_error(substation_circuit):
    load = next(n for n in substation_circuit.nodes if n.id == "ld")
    load.params["loadshape"] = "nope"
    res = compile_circuit(substation_circuit)
    issue = next(i for i in res.issues if i.code == "missing-loadshape")
    assert issue.severity == "error"
    assert issue.nodeId == "ld"


def test_export_contains_solve(substation_circuit):
    text, issues = export_dss(substation_circuit)
    assert "solve" in text
    assert text.startswith("//")
