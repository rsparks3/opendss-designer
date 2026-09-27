"""Line codes: a conductor library that travels with the circuit.

A line names a code; the compiler emits the code as a `LineCode` object and
the line as `linecode=<name>`; the importer reads codes back whole (matrix
and all) and pins lines to them. The IEEE feeders in test_ieee_feeders.py
are the end-to-end proof; these are the edges.
"""
from __future__ import annotations

from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.importer import import_dss
from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode, LineCodeSpec
from opendss_designer.core.validate import validate

MTX601 = LineCodeSpec(
    nphases=3, units="mi",
    rmatrix=[[0.3465, 0.1560, 0.1580], [0.1560, 0.3375, 0.1535], [0.1580, 0.1535, 0.3414]],
    xmatrix=[[1.0179, 0.5017, 0.4236], [0.5017, 1.0478, 0.3849], [0.4236, 0.3849, 1.0348]],
    normamps=530, source="typed in")


def two_bus(line_params: dict, codes: dict[str, LineCodeSpec]) -> Circuit:
    return Circuit(
        name="lc",
        nodes=[
            CircuitNode(id="src", type="vsource",
                        params={"name": "src", "basekv": 4.16, "pu": 1.0, "phases": 3}),
            CircuitNode(id="ld", type="load",
                        params={"name": "ld", "kv": 4.16, "kw": 500, "pf": 0.9,
                                "phases": 3, "conn": "wye", "model": 1}),
        ],
        edges=[CircuitEdge(id="ln", type="line", source="src", sourceHandle="t1",
                           target="ld", targetHandle="t1", params=line_params)],
        lineCodes=codes)


def commands(circuit: Circuit) -> str:
    res = compile_circuit(circuit)
    assert not [i for i in res.issues if i.severity == "error"], res.issues
    return "\n".join(res.commands).lower()


def test_matrix_code_is_emitted_lower_triangular_and_referenced():
    c = two_bus({"name": "l1", "linecode": "mtx601", "length": 2000, "units": "ft",
                 "phases": 3}, {"mtx601": MTX601})
    text = commands(c)
    assert ("new linecode.mtx601 nphases=3 units=mi "
            "rmatrix=[0.3465 | 0.156 0.3375 | 0.158 0.1535 0.3414] "
            "xmatrix=[1.0179 | 0.5017 1.0478 | 0.4236 0.3849 1.0348] normamps=530") in text
    line = next(l for l in text.splitlines() if l.startswith("new line.l1 "))
    assert "linecode=mtx601" in line
    assert "r1=" not in line
    # The line's own rating is absent, so the code's applies: no default
    # warning and no normamps on the line.
    assert "normamps" not in line
    assert not [i for i in compile_circuit(c).issues if i.code == "default-rating"]


def test_sequence_code_emits_sequence_values():
    code = LineCodeSpec(nphases=3, units="km", r1=0.12, x1=0.38, r0=0.4, x0=1.2, c1=9.0, c0=3.0)
    text = commands(two_bus({"name": "l1", "linecode": "seq", "length": 1, "units": "km",
                             "phases": 3}, {"seq": code}))
    assert "new linecode.seq nphases=3 units=km r1=0.12 x1=0.38 r0=0.4 x0=1.2 c1=9 c0=3" in text


def test_a_code_name_the_circuit_does_not_hold_falls_back_to_the_line_values():
    """A conductor preset from linecodes.csv is also a `linecode` tag; its
    values are stamped on the line, so the line compiles from them."""
    text = commands(two_bus({"name": "l1", "linecode": "acsr_336", "r1": 0.19, "x1": 0.39,
                             "r0": 0.5, "x0": 1.3, "length": 1, "units": "km", "phases": 3,
                             "normamps": 530}, {}))
    assert "new linecode." not in text
    assert "r1=0.19 x1=0.39 r0=0.5 x0=1.3" in text


def test_incomplete_code_is_refused_not_emitted_with_defaults():
    bad = LineCodeSpec(nphases=3, units="km", rmatrix=[[0.1, 0.0], [0.0, 0.1]],
                       xmatrix=[[0.3, 0.0], [0.0, 0.3]])
    res = compile_circuit(two_bus({"name": "l1", "linecode": "bad", "phases": 3,
                                   "r1": 0.1, "x1": 0.3, "r0": 0.3, "x0": 0.9}, {"bad": bad}))
    assert [i for i in res.issues if i.code == "bad-linecode"]
    assert "new linecode." not in "\n".join(res.commands).lower()


def test_phase_count_mismatch_is_a_validation_error():
    c = two_bus({"name": "l1", "linecode": "mtx601", "phases": 1, "length": 1, "units": "mi"},
                {"mtx601": MTX601})
    codes = [i.code for i in validate(c)]
    assert "linecode-phases" in codes


def test_export_import_keeps_the_matrix():
    c = two_bus({"name": "l1", "linecode": "mtx601", "length": 2000, "units": "ft",
                 "phases": 3}, {"mtx601": MTX601})
    text, _ = export_dss(c)
    back = Circuit.model_validate(import_dss(text)["circuit"])
    assert set(back.lineCodes) == {"mtx601"}
    spec = back.lineCodes["mtx601"]
    assert spec.nphases == 3 and spec.units == "mi"
    assert spec.rmatrix == MTX601.rmatrix
    assert spec.xmatrix == MTX601.xmatrix
    # The engine filled in the capacitance it used; that comes back too.
    assert spec.cmatrix is not None and spec.cmatrix[0][0] > 0
    line = next(e for e in back.edges if e.type == "line")
    assert line.params["linecode"] == "mtx601"
    assert "r1" not in line.params


def test_import_reads_a_code_written_as_sequence_values_as_its_matrix():
    text = """
    new circuit.seq basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000
    new linecode.lc1 nphases=3 r1=0.1 x1=0.3 r0=0.4 x0=1.2 units=km normamps=400
    new line.l1 bus1=srcbus bus2=b2 linecode=lc1 length=1 units=km
    new load.ld1 bus1=b2 phases=3 kv=12.47 kw=100 pf=0.95
    set voltagebases=[12.47]
    calcvoltagebases
    """
    back = Circuit.model_validate(import_dss(text)["circuit"])
    spec = back.lineCodes["lc1"]
    zs, zm = (2 * 0.1 + 0.4) / 3, (0.4 - 0.1) / 3
    assert abs(spec.rmatrix[0][0] - zs) < 1e-9 and abs(spec.rmatrix[0][1] - zm) < 1e-9


def test_import_keeps_a_lines_own_sequence_values_and_capacitance():
    text = """
    new circuit.seq basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000
    new line.l1 bus1=srcbus bus2=b2 r1=0.1 x1=0.3 r0=0.4 x0=1.2 c1=0 c0=0 length=1 units=km
    new load.ld1 bus1=b2 phases=3 kv=12.47 kw=100 pf=0.95
    set voltagebases=[12.47]
    calcvoltagebases
    """
    back = Circuit.model_validate(import_dss(text)["circuit"])
    assert not back.lineCodes
    line = next(e for e in back.edges if e.type == "line")
    assert line.params["r1"] == 0.1 and line.params["c1"] == 0 and line.params["c0"] == 0
    out, _ = export_dss(back)
    assert "c1=0 c0=0" in out


def test_import_gives_a_matrix_line_a_code_of_its_own():
    text = """
    new circuit.mtx basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000
    new line.l1 bus1=srcbus bus2=b2 phases=3 units=mi length=1
    ~ rmatrix=(0.3465 | 0.1560 0.3375 | 0.1580 0.1535 0.3414)
    ~ xmatrix=(1.0179 | 0.5017 1.0478 | 0.4236 0.3849 1.0348)
    new load.ld1 bus1=b2 phases=3 kv=12.47 kw=100 pf=0.95
    set voltagebases=[12.47]
    calcvoltagebases
    """
    back = Circuit.model_validate(import_dss(text)["circuit"])
    assert set(back.lineCodes) == {"l1"}
    assert back.lineCodes["l1"].source == "line matrix"
    assert back.lineCodes["l1"].rmatrix[0][2] == 0.158
    line = next(e for e in back.edges if e.type == "line")
    assert line.params["linecode"] == "l1"


def test_import_shares_one_code_between_lines_on_the_same_geometry():
    text = """
    new circuit.geo basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000
    new wiredata.acsr336 diam=0.721 gmrac=0.0244 rac=0.306 runits=mi radunits=in gmrunits=ft
    new linegeometry.hpole nconds=3 nphases=3 reduce=n
    ~ cond=1 wire=acsr336 x=-4 h=28 units=ft
    ~ cond=2 wire=acsr336 x=0 h=28 units=ft
    ~ cond=3 wire=acsr336 x=4 h=28 units=ft
    new line.l1 bus1=srcbus bus2=b2 geometry=hpole length=1 units=mi
    new line.l2 bus1=b2 bus2=b3 geometry=hpole length=0.5 units=mi
    new load.ld1 bus1=b3 phases=3 kv=12.47 kw=100 pf=0.95
    set voltagebases=[12.47]
    calcvoltagebases
    """
    back = Circuit.model_validate(import_dss(text)["circuit"])
    assert set(back.lineCodes) == {"geom_hpole"}
    spec = back.lineCodes["geom_hpole"]
    assert spec.source == "geometry:hpole" and spec.units == "mi"
    assert spec.rmatrix[0][0] > 0.3 and spec.rmatrix[0][1] > 0
    assert all(e.params["linecode"] == "geom_hpole" for e in back.edges if e.type == "line")
    # And the circuit solves on the copied matrix.
    assert engine.solve(back)["converged"]


def test_unused_codes_are_left_out_with_a_note():
    text = """
    new circuit.lib basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000
    new linecode.used nphases=3 r1=0.1 x1=0.3 r0=0.4 x0=1.2 units=km
    new linecode.spare1 nphases=3 r1=0.2 x1=0.3 r0=0.4 x0=1.2 units=km
    new linecode.spare2 nphases=1 r1=0.3 x1=0.3 r0=0.4 x0=1.2 units=km
    new line.l1 bus1=srcbus bus2=b2 linecode=used length=1 units=km
    new load.ld1 bus1=b2 phases=3 kv=12.47 kw=100 pf=0.95
    set voltagebases=[12.47]
    calcvoltagebases
    """
    r = import_dss(text)
    assert set(r["circuit"]["lineCodes"]) == {"used"}
    assert any("2 line codes" in w and "spare1" in w for w in r["warnings"])
