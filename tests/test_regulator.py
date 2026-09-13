"""Step-voltage regulators: a transformer plus the RegControl that taps it."""
from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.importer import import_dss
from opendss_designer.core.model import Circuit


# Source, a line long enough to sag the far end by about 6%, then a regulator
# feeding the load. The RegControl should tap that back into 122 V ± 1 V (on a
# 120 V base, i.e. 1.0083–1.0250 pu). The sag is kept inside the regulator's
# ±10% tap range on purpose — past that it saturates and the band is missed.
def _feeder(with_regulator: bool) -> Circuit:
    nodes: list[dict] = [
        {"id": "src", "type": "vsource",
         "params": {"name": "SRC1", "basekv": 12.47, "pu": 1.0, "phases": 3,
                    "mvasc3": 2000, "mvasc1": 2100}},
        {"id": "b1", "type": "busbar", "params": {"name": "BUS-SRC", "basekv": 12.47}},
        {"id": "b2", "type": "busbar", "params": {"name": "BUS-END", "basekv": 12.47}},
        {"id": "ld", "type": "load",
         "params": {"name": "LOAD1", "kv": 12.47, "kw": 2500, "pf": 0.95,
                    "phases": 3, "conn": "wye", "model": 1}},
    ]
    edges: list[dict] = [
        {"id": "e1", "type": "wire", "source": "src", "sourceHandle": "t1",
         "target": "b1", "targetHandle": "b0"},
        {"id": "e2", "type": "line", "source": "b1", "sourceHandle": "c0",
         "target": "b2", "targetHandle": "b0",
         "params": {"name": "LN1", "length": 8.0, "units": "km", "r1": 0.3,
                    "x1": 0.6, "r0": 0.8, "x0": 1.8, "normamps": 400, "phases": 3}},
    ]
    if with_regulator:
        nodes.append({"id": "reg", "type": "regulator",
                      "params": {"name": "REG1", "phases": 3, "kv": 12.47,
                                 "kva": 5000, "vreg": 122, "band": 2,
                                 "ptratio": 60, "ctprim": 300, "r": 0, "x": 0}})
        nodes.append({"id": "b3", "type": "busbar",
                      "params": {"name": "BUS-REG", "basekv": 12.47}})
        edges.append({"id": "e3", "type": "wire", "source": "b2",
                      "sourceHandle": "c0", "target": "reg", "targetHandle": "t1"})
        edges.append({"id": "e4", "type": "wire", "source": "reg",
                      "sourceHandle": "t2", "target": "b3", "targetHandle": "b0"})
        edges.append({"id": "e5", "type": "wire", "source": "b3",
                      "sourceHandle": "c0", "target": "ld", "targetHandle": "t1"})
    else:
        edges.append({"id": "e3", "type": "wire", "source": "b2",
                      "sourceHandle": "c0", "target": "ld", "targetHandle": "t1"})
    return Circuit.model_validate({"name": "regtest", "nodes": nodes, "edges": edges})


def test_regulator_taps_the_load_bus_into_band():
    plain = engine.solve(_feeder(with_regulator=False))
    regulated = engine.solve(_feeder(with_regulator=True))
    assert plain["converged"] and regulated["converged"]

    unregulated_v = plain["buses"]["bus_end"]["vminPu"]
    assert unregulated_v < 1.0, "feeder should sag without the regulator"

    load_v = regulated["buses"]["bus_reg"]["vminPu"]
    assert load_v > unregulated_v, "regulator should raise the load-side voltage"
    # 122 V ± half the 2 V band, on the 120 V control base.
    assert 121.0 / 120.0 <= load_v <= 123.0 / 120.0


def test_regulator_emits_a_transformer_and_a_regcontrol():
    res = compile_circuit(_feeder(with_regulator=True))
    assert not [i for i in res.issues if i.severity == "error"]
    joined = "\n".join(res.commands).lower()
    assert "new transformer.reg1" in joined
    assert "new regcontrol.reg1 transformer=reg1 winding=2" in joined
    # Equal ratio both sides, so the regulator never changes the kV base.
    assert "kvs=(12.47, 12.47)" in joined
    # Results map through the power element, which is the transformer.
    assert res.element_map["transformer.reg1"] == "reg"


def test_ptratio_defaults_to_the_120v_control_base():
    circuit = _feeder(with_regulator=True)
    reg = next(n for n in circuit.nodes if n.type == "regulator")
    del reg.params["ptratio"]
    joined = "\n".join(compile_circuit(circuit).commands).lower()
    # 12.47 kV line-line -> 7200 V line-neutral -> 60.
    assert "ptratio=60" in joined


def test_regulator_survives_export_and_import():
    text, _ = export_dss(_feeder(with_regulator=True))
    imported = import_dss(text)
    assert not imported["unsupported"], imported["unsupported"]

    circuit = Circuit.model_validate(imported["circuit"])
    regs = [n for n in circuit.nodes if n.type == "regulator"]
    assert len(regs) == 1, "a controlled transformer should come back as a regulator"
    p = regs[0].params
    assert p["name"] == "reg1"
    assert p["vreg"] == 122
    assert p["band"] == 2
    assert p["ptratio"] == 60
    assert p["kv"] == 12.47
    # And the plain transformer stays a transformer.
    assert not [n for n in circuit.nodes if n.type == "transformer"]
