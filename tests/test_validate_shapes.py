"""Shape-kind validation: loads follow load shapes, PV follows irradiance
shapes, storage dispatch may follow either."""
from opendss_designer.core.model import CircuitEdge, CircuitNode, LoadShapeSpec
from opendss_designer.core.validate import validate


def _wire(eid, a, b):
    return CircuitEdge(id=eid, type="wire", source=a, sourceHandle="t1",
                       target=b, targetHandle="b0")


def _mismatches(circuit):
    return {i.nodeId for i in validate(circuit) if i.code == "shape-kind-mismatch"}


def test_kind_mismatch_warnings(substation_circuit):
    c = substation_circuit
    c.loadShapes = {
        "day": LoadShapeSpec(kind="load", points=[0.5, 1.0]),
        "sun": LoadShapeSpec(kind="irradiance", points=[0.0, 1.0]),
    }
    c.nodes.append(CircuitNode(id="pv", type="pvsystem",
                               params={"name": "PV1", "kv": 12.47, "loadshape": "sun"}))
    c.nodes.append(CircuitNode(id="bat", type="storage",
                               params={"name": "B1", "kv": 12.47, "loadshape": "sun"}))
    c.edges.append(_wire("wpv", "pv", "bb1"))
    c.edges.append(_wire("wbat", "bat", "bb1"))
    load = next(n for n in c.nodes if n.type == "load")
    load.params["loadshape"] = "day"

    # Correct kinds everywhere (storage may follow anything): no warnings.
    assert _mismatches(c) == set()

    # Swap them: load follows irradiance, PV follows a load shape.
    load.params["loadshape"] = "sun"
    next(n for n in c.nodes if n.id == "pv").params["loadshape"] = "day"
    assert _mismatches(c) == {load.id, "pv"}
    # Storage still exempt.
    next(n for n in c.nodes if n.id == "bat").params["loadshape"] = "day"
    assert "bat" not in _mismatches(c)
