"""Phase pinning: saying which of the three a single-phase element sits on.

Real feeders are mostly single-phase laterals, so until an element can be put
on B rather than always on A, a model of one is a polite fiction.
"""
import pytest

from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.importer import import_dss
from opendss_designer.core.model import Circuit
from opendss_designer.core.phasing import (
    default_phasing,
    nodes_for,
    parse_phasing,
    phase_count,
    phase_set,
    phasing_from_suffix,
)
from opendss_designer.core.validate import validate

# --- the letters <-> nodes translation -------------------------------------

@pytest.mark.parametrize("raw, expected", [
    ("B", "B"), ("b", "B"), ("ca", "AC"), ("A-B", "AB"), ("abc", "ABC"),
    ("", None), ("D", None), ("AA", None), (None, None), (3, None),
    # Not "B": a pin picked out of arbitrary text would be a confident guess.
    ("bogus", None), ("phase B", None), ("1", None),
])
def test_parse_phasing(raw, expected):
    assert parse_phasing(raw) == expected


@pytest.mark.parametrize("phasing, suffix", [
    ("A", ".1"), ("B", ".2"), ("C", ".3"), ("AB", ".1.2"), ("BC", ".2.3"),
    ("ABC", ".1.2.3"), (None, ""), ("nonsense", ""),
])
def test_nodes_for(phasing, suffix):
    assert nodes_for(phasing) == suffix


@pytest.mark.parametrize("suffix, expected", [
    (".2", "B"), (".1.2", "AB"), (".2.1", "AB"), (".1.2.3", "ABC"),
    # A neutral, a repeat, a centre tap: things the letters cannot say, so the
    # raw text has to be kept instead of being approximated.
    (".1.0", None), (".1.1", None), (".1.2.3.4", None), ("", None), (None, None),
])
def test_phasing_from_suffix(suffix, expected):
    assert phasing_from_suffix(suffix) == expected


def test_phase_count_clamps():
    assert phase_count({"phases": 1}) == 1
    assert phase_count({"phases": 1e9}) == 3
    assert phase_count({"phases": 0}) == 1
    assert phase_count({"phases": "2"}) == 2
    assert phase_count({"phases": "abc"}) == 3
    assert phase_count({}) == 3


def test_phase_set_falls_back_to_the_count():
    assert phase_set(None, 1) == frozenset("A")
    assert phase_set(None, 3) == frozenset("ABC")
    assert phase_set("C", 1) == frozenset("C")
    assert default_phasing(2) == "AB"


# --- a feeder with a single-phase lateral ----------------------------------

def _feeder(pin: str | None, *, with_fuse: bool = False) -> Circuit:
    """3-phase trunk, then a lateral carrying one phase to a 1-phase load.
    `pin` is the phase the lateral and its load sit on."""
    nodes: list[dict] = [
        {"id": "src", "type": "vsource",
         "params": {"name": "SRC1", "basekv": 12.47, "pu": 1.0, "phases": 3,
                    "mvasc3": 2000, "mvasc1": 2100}},
        {"id": "b1", "type": "busbar", "params": {"name": "BUS-SRC", "basekv": 12.47}},
        {"id": "b2", "type": "busbar", "params": {"name": "BUS-TAP", "basekv": 12.47}},
        {"id": "ld", "type": "load",
         "params": {"name": "LOAD1", "kv": 7.2, "kw": 100, "pf": 0.95,
                    "phases": 1, "conn": "wye", "model": 1,
                    **({"phasing": pin} if pin else {})}},
    ]
    edges: list[dict] = [
        {"id": "e1", "type": "wire", "source": "src", "sourceHandle": "t1",
         "target": "b1", "targetHandle": "b0"},
        {"id": "e2", "type": "line", "source": "b1", "sourceHandle": "c0",
         "target": "b2", "targetHandle": "b0",
         "params": {"name": "LAT1", "length": 1.0, "units": "km", "r1": 0.3,
                    "x1": 0.6, "r0": 0.8, "x0": 1.8, "normamps": 200,
                    "phases": 1, **({"phasing": pin} if pin else {})}},
    ]
    if with_fuse:
        nodes.append({"id": "fu", "type": "fuse",
                      "params": {"name": "FU1", "phases": 1, "ratedcurrent": 25,
                                 "closed": True, **({"phasing": pin} if pin else {})}})
        nodes.append({"id": "b3", "type": "busbar",
                      "params": {"name": "BUS-END", "basekv": 12.47}})
        edges.append({"id": "e3", "type": "wire", "source": "b2",
                      "sourceHandle": "c0", "target": "fu", "targetHandle": "t1"})
        edges.append({"id": "e4", "type": "wire", "source": "fu",
                      "sourceHandle": "t2", "target": "b3", "targetHandle": "b0"})
        edges.append({"id": "e5", "type": "wire", "source": "b3",
                      "sourceHandle": "c0", "target": "ld", "targetHandle": "t1"})
    else:
        edges.append({"id": "e3", "type": "wire", "source": "b2",
                      "sourceHandle": "c0", "target": "ld", "targetHandle": "t1"})
    return Circuit.model_validate({"name": "pintest", "nodes": nodes, "edges": edges})


def test_pin_reaches_the_dss_text():
    joined = "\n".join(compile_circuit(_feeder("B")).commands).lower()
    assert "bus1=bus_src.2 bus2=bus_tap.2" in joined
    assert "bus1=bus_tap.2" in joined  # the load


def test_unpinned_still_defaults_to_phase_a():
    """Every circuit drawn before pinning existed must compile unchanged."""
    joined = "\n".join(compile_circuit(_feeder(None)).commands).lower()
    assert "bus1=bus_src.1 bus2=bus_tap.1" in joined


@pytest.mark.parametrize("pin, node", [("A", 1), ("B", 2), ("C", 3)])
def test_a_pinned_lateral_is_energized_on_its_own_phase(pin, node):
    """The point of the whole feature: the load has to draw power from the
    phase it was pinned to, and that phase only."""
    res = engine.solve(_feeder(pin))
    assert res["converged"]
    tap = res["buses"]["bus_tap"]
    assert tap["nodes"] == [node], "the lateral bus should carry one node only"
    assert 0.9 < tap["vmagPu"][0] < 1.05, "and it should be energized"
    # The readout has to name the phase too, or a current on B reads as
    # "phase 1" in the tooltip.
    load = next(el for el in res["elements"].values() if el["id"] == "ld")
    assert load["phaseNodes"] == [node]
    assert len(load["currents"]) == 1


def test_a_fuse_in_a_pinned_lateral_keeps_the_pin():
    """A switch used to take .1 on both terminals whatever the lateral did,
    which quietly islanded everything past it."""
    joined = "\n".join(compile_circuit(_feeder("C", with_fuse=True)).commands).lower()
    assert "bus1=bus_tap.3 bus2=bus_end.3" in joined
    res = engine.solve(_feeder("C", with_fuse=True))
    assert res["converged"]
    assert res["buses"]["bus_end"]["nodes"] == [3]


def test_pin_survives_export_and_import():
    text, _ = export_dss(_feeder("B"))
    imported = import_dss(text)
    assert not imported["unsupported"], imported["unsupported"]
    circuit = Circuit.model_validate(imported["circuit"])
    load = next(n for n in circuit.nodes if n.type == "load")
    lateral = next(e for e in circuit.edges if e.type == "line")
    assert load.params["phasing"] == "B"
    assert lateral.params["phasing"] == "B"


def test_a_neutral_connection_stays_raw_rather_than_being_approximated():
    """'.1.0' is a phase and a neutral; the letters cannot say it, so it has to
    come back as the text it was, not as a pin to A."""
    text = ("new circuit.mini basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000\n"
            "new line.l1 bus1=srcbus bus2=b2 phases=3 r1=0.1 x1=0.3 r0=0.3 x0=0.9 "
            "length=1 units=km normamps=400\n"
            "new load.ld1 bus1=b2.1.0 phases=1 conn=wye kv=7.2 kw=100 pf=0.95\n"
            "set voltagebases=[12.47]\ncalcvoltagebases\n")
    circuit = Circuit.model_validate(import_dss(text)["circuit"])
    load = next(n for n in circuit.nodes if n.type == "load")
    assert load.params["busNodes"] == ".1.0"
    assert "phasing" not in load.params
    assert ".1.0" in export_dss(circuit)[0]


# --- validation -------------------------------------------------------------

def _codes(circuit: Circuit) -> list[str]:
    return [i.code for i in validate(circuit)]


def test_a_pin_off_a_lateral_that_does_not_carry_it_is_flagged():
    circuit = _feeder("B")
    load = next(n for n in circuit.nodes if n.type == "load")
    load.params["phasing"] = "C"  # lateral is on B; C never gets here
    issues = [i for i in validate(circuit) if i.code == "phase-mismatch"]
    assert len(issues) == 1
    assert "C" in issues[0].message and "does not carry" in issues[0].message


def test_a_consistent_pin_is_quiet():
    assert "phase-mismatch" not in _codes(_feeder("C"))
    assert "phase-mismatch" not in _codes(_feeder(None))
    assert "phase-mismatch" not in _codes(_feeder("B", with_fuse=True))


def test_three_phases_pinned_to_one_is_an_error():
    circuit = _feeder(None)
    load = next(n for n in circuit.nodes if n.type == "load")
    load.params.update({"phases": 3, "phasing": "A"})
    issues = [i for i in validate(circuit) if i.code == "phase-count-mismatch"]
    assert len(issues) == 1 and issues[0].severity == "error"


def test_an_open_fuse_does_not_deliver_phases_downstream():
    """The walk has to respect an open switch, or nothing past a blown fuse
    could ever be reported as mis-phased."""
    circuit = _feeder("B", with_fuse=True)
    fuse = next(n for n in circuit.nodes if n.type == "fuse")
    fuse.params["closed"] = False
    # The load is now islanded, which is already reported as such; the phase
    # walk must stay quiet rather than say the same thing a second way.
    assert "phase-mismatch" not in _codes(circuit)


# --- the phase walk, shipped to the one-line -------------------------------

def _phase_map(circuit: Circuit) -> dict:
    from opendss_designer.core.validate import phase_map
    return phase_map(circuit)


def test_phase_map_names_what_reaches_each_bus():
    """The drawing colours buses by what actually gets there, so a B lateral
    has to read B at the tap and the trunk all three."""
    m = _phase_map(_feeder("B", with_fuse=True))
    assert m["nodes"]["b1"] == ["ABC"]
    assert m["nodes"]["b2"] == ["B"]
    assert m["nodes"]["b3"] == ["B"]
    assert m["nodes"]["fu"] == ["B", "B"]
    assert m["nodes"]["ld"] == ["B"]
    # Wires read as the bus they sit on, whichever end they were drawn from.
    assert m["wires"]["e1"] == "ABC"
    assert m["wires"]["e3"] == "B"
    assert m["wires"]["e5"] == "B"
    assert "e2" not in m["wires"]  # a line colours by its own phasing


def test_phase_map_leaves_an_unreached_bus_blank():
    """Past an open fuse nothing arrives; that must read as nothing rather
    than as the default A, or a dead lateral would look live."""
    circuit = _feeder("B", with_fuse=True)
    fuse = next(n for n in circuit.nodes if n.type == "fuse")
    fuse.params["closed"] = False
    m = _phase_map(circuit)
    assert m["nodes"]["b2"] == ["B"]
    assert m["nodes"]["fu"] == ["B", ""]
    assert m["nodes"]["b3"] == [""]
    assert m["wires"]["e5"] == ""


def test_phase_map_is_empty_without_a_source():
    circuit = _feeder("B")
    circuit.nodes = [n for n in circuit.nodes if n.type != "vsource"]
    circuit.edges = [e for e in circuit.edges if e.id != "e1"]
    m = _phase_map(circuit)
    assert all(v == [""] * len(v) for v in m["nodes"].values())
    assert all(v == "" for v in m["wires"].values())


def test_validate_route_ships_the_phase_map():
    from fastapi.testclient import TestClient

    from opendss_designer import server
    client = TestClient(server.create_app(), base_url="http://127.0.0.1")
    resp = client.post("/api/validate", json=_feeder("C").model_dump())
    assert resp.status_code == 200
    body = resp.json()
    assert body["phases"]["nodes"]["b2"] == ["C"]
    assert body["phases"]["wires"]["e3"] == "C"
