"""What a .dss import keeps that the diagram cannot show (core/passthrough.py):
elements of classes the editor does not model, and the file's comments."""
from __future__ import annotations

from opendss_designer.core import engine, passthrough
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.importer import import_dss, import_dss_files
from opendss_designer.core.model import Circuit, PassthroughSpec
from opendss_designer.core.validate import validate

FEEDER = """\
! Mini feeder for the passthrough tests
! Second header line

new circuit.mini basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000
redirect extras.dss

! The only line
new line.l1 bus1=srcbus bus2=b2 r1=0.1 x1=0.3 r0=0.3 x0=0.9 length=1 units=km
new load.ld1 bus1=b2 phases=3 kv=12.47 kw=500 pf=0.95  ! the one customer
new capacitor.c1 bus1=b2 phases=3 kv=12.47 kvar=300

! Meters at the head of the feeder
new energymeter.m1 element=line.l1 terminal=1
new monitor.mon1 element=line.l1
~ terminal=2 mode=0
edit monitor.mon1 ppolar=no
new capcontrol.cc1 element=line.l1 capacitor=c1 type=voltage on=118 off=126 ptratio=60
set voltagebases=[12.47]
calcvoltagebases
solve
"""

EXTRAS = """\
// A curve nothing in the diagram uses
new xycurve.vv npts=2 xarray=[0.9 1.1] yarray=[1 -1]
new reactor.gnd bus1=srcbus bus2=gndx kvar=100 phases=3
"""


def _import() -> dict:
    return import_dss_files([
        {"name": "main.dss", "text": FEEDER},
        {"name": "extras.dss", "text": EXTRAS},
    ])


def test_import_keeps_unmodelled_elements_in_file_order():
    r = _import()
    names = [p["name"] for p in r["circuit"]["passthrough"]]
    # The redirect is followed where it sits, so extras.dss comes first.
    assert names == ["xycurve.vv", "reactor.gnd", "energymeter.m1", "monitor.mon1", "capcontrol.cc1"]
    mon = next(p for p in r["circuit"]["passthrough"] if p["name"] == "monitor.mon1")
    # Continuation joined, the later Edit kept with it.
    assert mon["text"] == "new monitor.mon1 element=line.l1 terminal=2 mode=0\nedit monitor.mon1 ppolar=no"
    # Nothing is reported as dropped any more.
    assert r["unsupported"] == []
    assert set(r["passthrough"]) == set(names)


def test_import_keeps_comments_by_element():
    c = _import()["circuit"]["comments"]
    assert c["circuit"] == "! Mini feeder for the passthrough tests\n! Second header line"
    assert c["line.l1"] == "! The only line"
    assert c["load.ld1"] == "! the one customer"
    assert c["energymeter.m1"] == "! Meters at the head of the feeder"
    assert c["xycurve.vv"] == "// A curve nothing in the diagram uses"


def test_export_writes_both_back_and_reimports_the_same():
    circuit = Circuit.model_validate(_import()["circuit"])
    text, _ = export_dss(circuit)
    assert "! Mini feeder for the passthrough tests" in text
    assert "! The only line\nnew line.l1 " in text
    assert "new capcontrol.cc1 element=line.l1 capacitor=c1" in text
    assert "edit monitor.mon1 ppolar=no" in text
    again = import_dss(text)
    assert [p["name"] for p in again["circuit"]["passthrough"]] == [
        p.name for p in circuit.passthrough]
    assert again["circuit"]["comments"]["line.l1"] == "! The only line"


def test_passthrough_runs_in_the_solve():
    circuit = Circuit.model_validate(_import()["circuit"])
    res = compile_circuit(circuit)
    joined = "\n".join(res.commands)
    assert "new reactor.gnd" in joined and "new capcontrol.cc1" in joined
    # After every modelled element, before the voltage bases.
    assert joined.index("new capcontrol.cc1") > joined.index("new load.ld1")
    assert joined.index("new capcontrol.cc1") < joined.index("set voltagebases")
    result = engine.solve(circuit)
    assert result["converged"], result["issues"]
    assert not [i for i in result["issues"] if i["severity"] == "error"]


def test_a_stale_reference_is_left_out_with_a_warning_and_commented_out_on_export():
    circuit = Circuit.model_validate(_import()["circuit"])
    # The user renamed the line in the editor.
    for e in circuit.edges:
        if e.type == "line":
            e.params["name"] = "trunk"
    issues = validate(circuit)
    stale = [i for i in issues if i.code == "passthrough"]
    assert any("energymeter.m1" in i.message and "line.l1" in i.message for i in stale)
    assert all(i.severity == "warning" for i in stale)
    solve_cmds = "\n".join(compile_circuit(circuit).commands)
    assert "energymeter.m1" not in solve_cmds
    assert "new reactor.gnd" in solve_cmds  # its bus is still there
    text, _ = export_dss(circuit)
    assert "! Left out by OpenDSS Designer: it refers to line.l1" in text
    assert "! new energymeter.m1 element=line.l1" in text
    assert engine.solve(circuit)["converged"]


def test_only_listed_classes_run_and_nothing_that_reads_a_file():
    entries = [
        PassthroughSpec(name="gicline.g", text="new gicline.g bus1=a bus2=b volts=10"),
        PassthroughSpec(name="xycurve.f", text="new xycurve.f csvfile=curve.csv"),
        PassthroughSpec(name="reactor.r", text="new reactor.r bus1=a kvar=10\nredirect evil.dss"),
        PassthroughSpec(name="monitor.x", text="new monitor.x element=line.l1\nedit load.ld1 kw=0"),
        PassthroughSpec(name="notnew", text="set mode=daily"),
        PassthroughSpec(name="reactor.ok", text="new reactor.ok bus1=a kvar=10"),
    ]
    checked, issues = passthrough.check(entries, {"line.l1", "load.ld1"}, {"a"})
    assert [c.solvable for c in checked] == [False, False, False, False, False, True]
    assert len(issues) == 5
    # Kept for export all the same, except that nothing here is stale.
    exported = passthrough.commands(checked, export=True)
    assert "new gicline.g bus1=a bus2=b volts=10" in exported
    assert passthrough.commands(checked, export=False) == ["new reactor.ok bus1=a kvar=10"]


def test_a_passthrough_the_engine_rejects_is_a_warning_not_a_failed_solve():
    circuit = Circuit.model_validate(_import()["circuit"])
    circuit.passthrough.append(PassthroughSpec(
        name="reactor.bad", text="new reactor.bad bus1=srcbus kvar=abc"))
    result = engine.solve(circuit)
    assert result["converged"]
    warned = [i for i in result["issues"] if i["code"] == "passthrough"]
    assert any("reactor.bad" in i["message"] for i in warned)


def test_fault_study_mutes_passthrough_controls():
    circuit = Circuit.model_validate(_import()["circuit"])
    result = engine.fault_study(circuit)
    assert result["converged"], result.get("issues")


def test_a_circuit_without_any_is_unchanged():
    circuit = Circuit.model_validate(_import()["circuit"])
    circuit.passthrough = []
    circuit.comments = {}
    text, _ = export_dss(circuit)
    assert "capcontrol" not in text and "! The only line" not in text
