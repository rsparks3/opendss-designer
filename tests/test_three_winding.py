"""Three-winding transformers: a third entry in `windings` is a third terminal."""
from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.connectivity import synthesize
from opendss_designer.core.importer import import_dss
from opendss_designer.core.model import Circuit, node_terminals
from opendss_designer.core.validate import validate


# A 115 kV source feeding a substation transformer with a 12.47 kV secondary
# and a 4.16 kV tertiary, a load on each low-side bus. `wire_tertiary=False`
# leaves t3 in the air, which the validator has to notice.
def _substation(windings: int = 3, wire_tertiary: bool = True,
                tertiary_load_pin: str | None = None) -> Circuit:
    wdgs = [
        {"kv": 115, "kva": 10000, "conn": "delta"},
        {"kv": 12.47, "kva": 10000, "conn": "wye"},
        {"kv": 4.16, "kva": 5000, "conn": "wye"},
    ][:windings]
    nodes: list[dict] = [
        {"id": "src", "type": "vsource",
         "params": {"name": "SRC1", "basekv": 115, "pu": 1.0, "phases": 3,
                    "mvasc3": 2000, "mvasc1": 2100}},
        {"id": "bhv", "type": "busbar", "params": {"name": "BUS-HV", "basekv": 115}},
        {"id": "bmv", "type": "busbar", "params": {"name": "BUS-MV", "basekv": 12.47}},
        {"id": "xf", "type": "transformer",
         "params": {"name": "T1", "phases": 3, "xhl": 8.0, "xht": 12.0, "xlt": 6.0,
                    "pctloadloss": 0.5, "windings": wdgs}},
        {"id": "ldmv", "type": "load",
         "params": {"name": "LOAD-MV", "kv": 12.47, "kw": 3000, "pf": 0.95,
                    "phases": 3, "conn": "wye", "model": 1}},
    ]
    edges: list[dict] = [
        {"id": "e1", "type": "wire", "source": "src", "sourceHandle": "t1",
         "target": "bhv", "targetHandle": "b0"},
        {"id": "e2", "type": "wire", "source": "bhv", "sourceHandle": "c0",
         "target": "xf", "targetHandle": "t1"},
        {"id": "e3", "type": "wire", "source": "xf", "sourceHandle": "t2",
         "target": "bmv", "targetHandle": "b0"},
        {"id": "e4", "type": "wire", "source": "bmv", "sourceHandle": "c0",
         "target": "ldmv", "targetHandle": "t1"},
    ]
    if windings == 3 and wire_tertiary:
        nodes.append({"id": "blv", "type": "busbar",
                      "params": {"name": "BUS-LV", "basekv": 4.16}})
        nodes.append({"id": "ldlv", "type": "load",
                      "params": {"name": "LOAD-LV", "kv": 4.16, "kw": 1500, "pf": 0.9,
                                 "phases": 1 if tertiary_load_pin else 3,
                                 "conn": "wye", "model": 1,
                                 **({"phasing": tertiary_load_pin} if tertiary_load_pin else {})}})
        edges.append({"id": "e5", "type": "wire", "source": "xf", "sourceHandle": "t3",
                      "target": "blv", "targetHandle": "b0"})
        edges.append({"id": "e6", "type": "wire", "source": "blv", "sourceHandle": "c0",
                      "target": "ldlv", "targetHandle": "t1"})
    return Circuit.model_validate({"name": "threewdg", "nodes": nodes, "edges": edges})


def test_terminal_list_follows_the_winding_count():
    three = next(n for n in _substation(3).nodes if n.type == "transformer")
    two = next(n for n in _substation(2).nodes if n.type == "transformer")
    assert node_terminals(three) == ["t1", "t2", "t3"]
    assert node_terminals(two) == ["t1", "t2"]
    assert synthesize(_substation(3)).node_buses["xf"] == ["bus_hv", "bus_mv", "bus_lv"]


def test_three_windings_reach_the_dss_text():
    joined = "\n".join(compile_circuit(_substation(3)).commands).lower()
    assert ("new transformer.t1 phases=3 windings=3 buses=(bus_hv, bus_mv, bus_lv) "
            "conns=(delta, wye, wye) kvs=(115, 12.47, 4.16) kvas=(10000, 10000, 5000) "
            "xhl=8 %loadloss=0.5 xht=12 xlt=6") in joined
    assert "set voltagebases=[4.16, 12.47, 115]" in joined


def test_two_windings_compile_as_before():
    """No tertiary, no extra reactances -- a circuit drawn before this must
    produce the same command it always did."""
    joined = "\n".join(compile_circuit(_substation(2)).commands).lower()
    assert "windings=2 buses=(bus_hv, bus_mv)" in joined
    assert "xht" not in joined and "xlt" not in joined


def test_tertiary_bus_is_energized_at_its_own_voltage():
    res = engine.solve(_substation(3))
    assert res["converged"], res["issues"]
    lv = res["buses"]["bus_lv"]
    assert abs(lv["kvBase"] * 3 ** 0.5 - 4.16) < 0.01
    assert 0.93 < lv["vminPu"] < 1.02
    assert 0.93 < res["buses"]["bus_mv"]["vminPu"] < 1.02
    tertiary_load = next(el for el in res["elements"].values() if el["id"] == "ldlv")
    assert abs(tertiary_load["kw"] - 1500) < 50


def test_unwired_tertiary_is_reported_and_a_two_winding_unit_has_no_t3():
    issues = validate(_substation(3, wire_tertiary=False))
    assert any(i.code == "unconnected-terminal" and "t3" in i.message for i in issues)
    issues = validate(_substation(2))
    assert not any("t3" in i.message for i in issues)


def test_phases_start_fresh_on_the_tertiary():
    """A load pinned to C on the tertiary bus is fine: every winding hands
    its bus all the phases the transformer has, the same as the secondary."""
    issues = validate(_substation(3, tertiary_load_pin="C"))
    assert not [i for i in issues if i.severity == "error"], issues
    assert not any(i.code == "phase-mismatch" for i in issues), issues


def test_three_windings_survive_export_and_import():
    text, _ = export_dss(_substation(3))
    imported = import_dss(text)
    assert not imported["unsupported"], imported["unsupported"]
    circuit = Circuit.model_validate(imported["circuit"])
    xf = next(n for n in circuit.nodes if n.type == "transformer")
    assert [w["kv"] for w in xf.params["windings"]] == [115, 12.47, 4.16]
    assert xf.params["xht"] == 12 and xf.params["xlt"] == 6
    t3_edges = [e for e in circuit.edges
                if (e.source == xf.id and e.sourceHandle == "t3")
                or (e.target == xf.id and e.targetHandle == "t3")]
    assert len(t3_edges) == 1
    res = engine.solve(circuit)
    assert res["converged"], res["issues"]
