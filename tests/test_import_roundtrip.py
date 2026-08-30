from opendss_designer.core import engine
from opendss_designer.core.compiler import export_dss
from opendss_designer.core.importer import import_dss
from opendss_designer.core.model import Circuit


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
                        "new capacitor.c1 bus1=main_bus kv=12.47 kvar=600\n"
                        "set mode=snapshot")
    imported = import_dss(text)
    assert any("capacitor" in u.lower() for u in imported["unsupported"])
