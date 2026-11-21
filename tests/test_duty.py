"""Equipment duty screening (facility plan 2.4)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import protection
from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode, Limits
from opendss_designer.studies import duty


def feeder(**brk: object) -> Circuit:
    """Source -> bus A -> breaker -> bus B -> load, plus a fuse on bus B."""
    nodes = [
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3,
                                                      "mvasc3": 200, "mvasc1": 210}),
        CircuitNode(id="a", type="busbar", width=200, params={"name": "A", "basekv": 12.47}),
        CircuitNode(id="brk", type="breaker", params={"name": "BRK", "closed": True, "phases": 3, **brk}),
        CircuitNode(id="b", type="busbar", width=200, params={"name": "B", "basekv": 12.47, "bracingka": 40}),
        CircuitNode(id="fu", type="fuse", params={"name": "FU", "closed": True, "phases": 3, "ratedcurrent": 65}),
        CircuitNode(id="ld", type="load", params={"name": "LD", "kv": 12.47, "kw": 500, "pf": 0.95, "phases": 3}),
    ]
    edges = [
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="a", targetHandle="b1"),
        CircuitEdge(id="w1", type="wire", source="a", sourceHandle="b5", target="brk", targetHandle="t1"),
        CircuitEdge(id="w2", type="wire", source="brk", sourceHandle="t2", target="b", targetHandle="b1"),
        CircuitEdge(id="w3", type="wire", source="b", sourceHandle="b5", target="fu", targetHandle="t1"),
        CircuitEdge(id="w4", type="wire", source="fu", sourceHandle="t2", target="ld", targetHandle="t1"),
    ]
    return Circuit(name="duty", nodes=nodes, edges=edges)


def row(r: dict, rid: str) -> dict:
    assert r["converged"], r["issues"]
    return next(x for x in r["rows"] if x["id"] == rid)


def fault_ka() -> float:
    b = row(duty.duty_screening(feeder()), "brk")
    return max(b["faultA3ph"], b["faultA1ph"]) / 1000.0


def test_pass_fail_and_unrated():
    f = fault_ka()  # about 9.7 kA at 200 MVA, 12.47 kV
    assert 5 < f < 15
    fail = row(duty.duty_screening(feeder(interruptingka=round(f / 1.2, 2))), "brk")
    assert fail["status"] == "fail" and fail["checks"]["interrupting"]["ratio"] > 1
    ok = row(duty.duty_screening(feeder(interruptingka=round(f / 0.8, 2))), "brk")
    assert ok["status"] == "pass"
    r = duty.duty_screening(feeder())
    assert row(r, "brk")["status"] == "unrated"
    assert row(r, "fu")["status"] == "unrated"
    assert row(r, "b")["status"] == "pass"  # 40 kA bracing
    assert r["counts"]["unrated"] >= 2
    assert "not an ANSI C37" in r["disclaimer"]
    # Fails first in the list.
    rf = duty.duty_screening(feeder(interruptingka=round(f / 1.2, 2)))
    assert rf["rows"][0]["id"] == "brk"


def test_the_larger_of_three_phase_and_ground_fault_governs():
    c = feeder()
    c.nodes[0].params.update({"mvasc3": 200, "mvasc1": 300})  # ground fault stronger here
    b = row(duty.duty_screening(c), "brk")
    assert b["faultA1ph"] > b["faultA3ph"]
    assert b["governing"] == "1ph"
    assert b["dutyA"] == pytest.approx(b["faultA1ph"], rel=1e-3)


def test_duty_margin_and_asymmetry():
    f = fault_ka()
    rating = round(f / 0.95, 2)  # fault is 95 % of the rating: passes at margin 1.0
    c = feeder(interruptingka=rating)
    assert row(duty.duty_screening(c), "brk")["status"] == "pass"
    c.limits = Limits(dutyMargin=1.1)
    assert row(duty.duty_screening(c), "brk")["status"] == "fail"
    c.limits = Limits(asymmetryFactor=1.25)
    b = row(duty.duty_screening(c), "brk")
    assert b["status"] == "fail"
    assert b["dutyA"] == pytest.approx(f * 1000 * 1.25, rel=0.01)


def test_withstand_and_bracing_are_checked_too():
    f = fault_ka()
    b = row(duty.duty_screening(feeder(interruptingka=f * 2, withstandka=round(f / 2, 2))), "brk")
    assert b["checks"]["interrupting"]["status"] == "pass"
    assert b["checks"]["withstand"]["status"] == "fail"
    assert b["status"] == "fail"
    c = feeder()
    c.nodes[3].params["bracingka"] = round(f / 2, 2)
    assert row(duty.duty_screening(c), "b")["status"] == "fail"


def test_protection_warning_uses_the_ground_fault_and_margin():
    f = fault_ka()
    c = feeder(interruptingka=round(f / 0.95, 2))
    codes = [i["code"] for i in protection.tcc_study(c)["issues"]]
    assert "interrupting-duty" not in codes
    c.limits = Limits(dutyMargin=1.1)
    codes = [i["code"] for i in protection.tcc_study(c)["issues"]]
    assert "interrupting-duty" in codes


def test_route():
    client = TestClient(server.app, base_url="http://127.0.0.1")
    res = client.post("/api/duty", json={"circuit": feeder(interruptingka=50).model_dump()})
    assert res.status_code == 200, res.text
    assert res.json()["converged"]
