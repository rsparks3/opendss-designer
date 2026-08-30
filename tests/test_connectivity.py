from opendss_designer.core.connectivity import sanitize_name, synthesize
from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode


def _node(id, type, **params):
    return CircuitNode(id=id, type=type, params=params)


def _wire(id, s, sh, t, th):
    return CircuitEdge(id=id, type="wire", source=s, sourceHandle=sh,
                       target=t, targetHandle=th)


def test_sanitize():
    assert sanitize_name("Main Bus") == "main_bus"
    assert sanitize_name("  66kV Busbar!! ") == "66kv_busbar"
    assert sanitize_name("a.b.c") == "a_b_c"


def test_wires_merge_terminals():
    c = Circuit(nodes=[_node("a", "vsource"), _node("b", "load")],
                edges=[_wire("e1", "a", "t1", "b", "t1")])
    r = synthesize(c)
    assert r.node_buses["a"] == r.node_buses["b"]
    assert len(r.all_buses) == 1


def test_line_edges_do_not_merge():
    c = Circuit(nodes=[_node("a", "vsource"), _node("b", "load")],
                edges=[CircuitEdge(id="e1", type="line", source="a", sourceHandle="t1",
                                   target="b", targetHandle="t1")])
    r = synthesize(c)
    assert r.node_buses["a"] != r.node_buses["b"]
    assert r.line_buses["e1"] == (r.node_buses["a"][0], r.node_buses["b"][0])
    assert len(r.all_buses) == 2


def test_busbar_names_group_and_any_handle():
    c = Circuit(nodes=[_node("bb", "busbar", name="Main Bus"),
                       _node("a", "vsource"), _node("b", "load")],
                edges=[_wire("e1", "a", "t1", "bb", "b0"),
                       _wire("e2", "bb", "b9", "b", "t1")])
    r = synthesize(c)
    assert r.node_buses["a"] == ["main_bus"]
    assert r.node_buses["b"] == ["main_bus"]


def test_busbar_name_conflict_errors():
    c = Circuit(nodes=[_node("b1", "busbar", name="BusA"),
                       _node("b2", "busbar", name="BusB")],
                edges=[_wire("e1", "b1", "b0", "b2", "b0")])
    r = synthesize(c)
    assert any(i.code == "busbar-name-conflict" for i in r.issues)


def test_transformer_separates_sides():
    c = Circuit(nodes=[_node("s", "vsource"), _node("x", "transformer"),
                       _node("l", "load")],
                edges=[_wire("e1", "s", "t1", "x", "t1"),
                       _wire("e2", "x", "t2", "l", "t1")])
    r = synthesize(c)
    assert r.node_buses["x"][0] != r.node_buses["x"][1]
    assert r.node_buses["s"][0] == r.node_buses["x"][0]
    assert r.node_buses["l"][0] == r.node_buses["x"][1]


def test_implicit_bus_names_stable_via_persisted_map(substation_circuit):
    r1 = synthesize(substation_circuit)
    # Persist generated names back (as the frontend would) and re-run.
    substation_circuit.busNames = dict(r1.bus_names)
    r2 = synthesize(substation_circuit)
    assert r1.node_buses == r2.node_buses
    assert r1.line_buses == r2.line_buses


def test_fresh_names_never_collide_with_persisted():
    # Group "a*" is processed first (smaller fingerprint) and has no persisted
    # name; group "z*" persisted the name bus_1 in an earlier session. The
    # fresh name generator must not hand bus_1 to the "a*" group.
    c = Circuit(
        nodes=[_node("a1", "vsource"), _node("a2", "load"),
               _node("z1", "vsource"), _node("z2", "load")],
        edges=[_wire("e1", "a1", "t1", "a2", "t1"),
               _wire("e2", "z1", "t1", "z2", "t1")],
    )
    fingerprint_z = "z1:t1"
    c.busNames = {fingerprint_z: "bus_1"}
    r = synthesize(c)
    assert not r.issues
    assert r.node_buses["z1"] == ["bus_1"]
    assert r.node_buses["a1"] != ["bus_1"]
    assert len({r.node_buses["a1"][0], r.node_buses["z1"][0]}) == 2


def test_busbar_name_beats_stale_persisted_name():
    # A persisted junction name that now clashes with a busbar name is
    # silently discarded instead of erroring.
    c = Circuit(
        nodes=[_node("bb", "busbar", name="bus_1"),
               _node("a1", "vsource"), _node("a2", "load")],
        edges=[_wire("e1", "a1", "t1", "a2", "t1")],
    )
    c.busNames = {"a1:t1": "bus_1"}
    r = synthesize(c)
    assert not r.issues
    assert r.node_buses["bb"] == ["bus_1"]
    assert r.node_buses["a1"] != ["bus_1"]


def test_substation_fixture_buses(substation_circuit):
    r = synthesize(substation_circuit)
    assert not [i for i in r.issues if i.severity == "error"]
    # src+xfmr-hv share a bus; xfmr-lv joins the busbar; breaker t2 is an
    # implicit junction; load hangs off the line's far end.
    assert r.node_buses["t1"][1] == "main_bus"
    assert r.node_buses["brk"][0] == "main_bus"
    b1, b2 = r.line_buses["ln1"]
    assert b1 == r.node_buses["brk"][1]
    assert b2 == r.node_buses["ld"][0]
    assert len(r.all_buses) == 4
