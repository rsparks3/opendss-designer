import pytest

from opendss_designer.core import engine
from opendss_designer.core.compiler import export_dss
from opendss_designer.core.importer import ImportFailure, import_dss, import_dss_files
from opendss_designer.core.model import Circuit, LoadShapeSpec

MAIN_WITH_REDIRECT = """
new circuit.mini basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000
redirect codes.dss
new line.l1 bus1=srcbus bus2=b2 linecode=lc1 length=1 units=km
new load.ld1 bus1=b2.1.2 phases=1 conn=delta kv=12.47 kw=100 pf=0.95
set voltagebases=[12.47]
calcvoltagebases
buscoords coords.csv
"""

CODES = "new linecode.lc1 nphases=3 r1=0.1 x1=0.3 r0=0.3 x0=0.9 normamps=400 units=km\n"
COORDS = "srcbus,0,100\nb2,200,100\n"


def test_missing_redirect_is_clean_error():
    with pytest.raises(ImportFailure, match="codes.dss"):
        import_dss(MAIN_WITH_REDIRECT)


def test_multifile_import_with_redirect_and_coords():
    r = import_dss_files([
        {"name": "main.dss", "text": MAIN_WITH_REDIRECT},
        {"name": "codes.dss", "text": CODES},
        {"name": "coords.csv", "text": COORDS},
    ])
    c = Circuit.model_validate(r["circuit"])
    busbars = [n for n in c.nodes if n.type == "busbar"]
    assert len(busbars) == 2
    assert all(n.position is not None for n in busbars)
    # Exact delta node connection preserved and re-emitted on export.
    load = next(n for n in c.nodes if n.type == "load")
    assert load.params["busNodes"] == ".1.2"
    text, _ = export_dss(c)
    assert ".1.2 " in text or ".1.2\n" in text


def test_missing_buscoords_is_warning_not_error():
    r = import_dss_files([
        {"name": "main.dss", "text": MAIN_WITH_REDIRECT},
        {"name": "codes.dss", "text": CODES},
    ])
    assert any("BusCoords" in w for w in r["warnings"])
    busbars = [n for n in Circuit.model_validate(r["circuit"]).nodes
               if n.type == "busbar"]
    assert all(n.position is None for n in busbars)


def test_export_import_roundtrip(substation_circuit):
    text, _ = export_dss(substation_circuit)
    imported = import_dss(text)
    assert not imported["unsupported"]

    circuit = Circuit.model_validate(imported["circuit"])
    types = sorted(n.type for n in circuit.nodes if n.type != "busbar")
    assert types == ["breaker", "load", "transformer", "vsource"]
    assert sum(1 for e in circuit.edges if e.type == "line") == 1

    # The re-imported circuit must solve to the same load-bus voltage.
    original = engine.solve(substation_circuit)
    reimported = engine.solve(circuit)
    assert reimported["converged"], reimported["issues"]

    load_id = next(n.id for n in circuit.nodes if n.type == "load")
    v_new = reimported["buses"][reimported["nodeBuses"][load_id][0]]["vminPu"]
    v_old = original["buses"][original["nodeBuses"]["ld"][0]]["vminPu"]
    assert abs(v_new - v_old) < 1e-3


def test_import_reports_unsupported(substation_circuit):
    text, _ = export_dss(substation_circuit)
    text = text.replace("set mode=snapshot",
                        "new reactor.r1 bus1=main_bus kv=12.47 kvar=300\n"
                        "set mode=snapshot")
    imported = import_dss(text)
    assert any("reactor" in u.lower() for u in imported["unsupported"])


def test_pvsystem_storage_roundtrip(substation_circuit):
    substation_circuit.loadShapes = {
        "sun": LoadShapeSpec(intervalMin=60, points=[0.0, 0.8, 1.0, 0.6])}
    text, _ = export_dss(substation_circuit)
    text = text.replace(
        "set mode=snapshot",
        "new loadshape.sun npts=4 interval=1 mult=(0 0.8 1 0.6)\n"
        "new pvsystem.pv1 bus1=main_bus kv=12.47 kva=800 pmpp=750 pf=1.0 "
        "irradiance=0.9 phases=3 daily=sun\n"
        "new storage.bat1 bus1=main_bus kv=12.47 kwrated=250 kwhrated=1000 "
        "%stored=45 %reserve=20 %effcharge=95 %effdischarge=94 "
        "dispmode=follow daily=sun phases=3\n"
        "set mode=snapshot")
    imported = import_dss(text)
    assert not imported["unsupported"]

    circuit = Circuit.model_validate(imported["circuit"])
    pv = next(n for n in circuit.nodes if n.type == "pvsystem")
    assert pv.params["pmpp"] == pytest.approx(750)
    assert pv.params["kva"] == pytest.approx(800)
    assert pv.params["kv"] == pytest.approx(12.47)
    assert pv.params["irradiance"] == pytest.approx(0.9)
    assert pv.params["loadshape"] == "sun"
    # A shape driving a PV system reads back as an irradiance shape.
    assert circuit.loadShapes["sun"].kind == "irradiance"
    stg = next(n for n in circuit.nodes if n.type == "storage")
    assert stg.params["kwrated"] == pytest.approx(250)
    assert stg.params["kwhrated"] == pytest.approx(1000)
    assert stg.params["soc"] == pytest.approx(45)
    assert stg.params["effdischarge"] == pytest.approx(94)
    assert stg.params["dispatch"] == "follow"
    assert stg.params["loadshape"] == "sun"

    # And they re-export/re-solve cleanly.
    text2, _ = export_dss(circuit)
    assert "new pvsystem.pv1" in text2.lower()
    assert "new storage.bat1" in text2.lower()
    solved = engine.solve(circuit)
    assert solved["converged"], solved["issues"]


def test_loadshape_roundtrip(substation_circuit):
    substation_circuit.loadShapes = {
        "day3": LoadShapeSpec(intervalMin=60, points=[0.5, 1.0, 0.75])}
    load = next(n for n in substation_circuit.nodes if n.type == "load")
    load.params["loadshape"] = "day3"

    text, _ = export_dss(substation_circuit)
    assert "new loadshape.day3" in text
    imported = import_dss(text)
    assert not imported["unsupported"]

    circuit = Circuit.model_validate(imported["circuit"])
    assert list(circuit.loadShapes) == ["day3"]
    spec = circuit.loadShapes["day3"]
    assert spec.intervalMin == pytest.approx(60)
    assert spec.points == pytest.approx([0.5, 1.0, 0.75])
    re_load = next(n for n in circuit.nodes if n.type == "load")
    assert re_load.params["loadshape"] == "day3"

    solved = engine.solve(circuit)
    assert solved["converged"], solved["issues"]


def test_capacitor_generator_roundtrip(substation_circuit):
    text, _ = export_dss(substation_circuit)
    text = text.replace(
        "set mode=snapshot",
        "new capacitor.c1 bus1=main_bus kv=12.47 kvar=600 numsteps=2\n"
        "new generator.g1 bus1=main_bus kv=12.47 kw=250 pf=0.98 model=1\n"
        "set mode=snapshot")
    imported = import_dss(text)
    assert not imported["unsupported"]

    circuit = Circuit.model_validate(imported["circuit"])
    cap = next(n for n in circuit.nodes if n.type == "capacitor")
    gen = next(n for n in circuit.nodes if n.type == "generator")
    assert cap.params["kvar"] == 600
    assert cap.params["numsteps"] == 2
    assert gen.params["kw"] == pytest.approx(250)

    # And they re-export/re-solve cleanly.
    text2, _ = export_dss(circuit)
    assert "new capacitor.c1" in text2.lower()
    assert "new generator.g1" in text2.lower()
    solved = engine.solve(circuit)
    assert solved["converged"], solved["issues"]
