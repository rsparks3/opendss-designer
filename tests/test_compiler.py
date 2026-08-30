from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.model import Circuit, CircuitNode


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


def test_export_contains_solve(substation_circuit):
    text, issues = export_dss(substation_circuit)
    assert "solve" in text
    assert text.startswith("//")
