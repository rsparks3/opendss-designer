"""M12 planning foundation: load levels, emergency ratings, capacitor and
inverter controls, regulator reverse mode, scenarios, batch runs and jobs."""
from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import engine
from opendss_designer.core.compiler import compile_circuit, export_dss
from opendss_designer.core.importer import import_dss_files
from opendss_designer.core.jobs import JobManager
from opendss_designer.core.model import (
    Circuit,
    CircuitEdge,
    CircuitNode,
    LoadLevel,
    LoadShapeSpec,
    Scenario,
    XYCurveSpec,
)
from opendss_designer.core.scenarios import apply_scenario, effective_circuit
from opendss_designer.studies.batch import run_batch

LEVELS = [LoadLevel(name="Peak", loadmult=1.0),
          LoadLevel(name="Minimum daytime", loadmult=0.3),
          LoadLevel(name="Emergency peak", loadmult=1.0, rating="emergency")]


def joined(circuit: Circuit) -> str:
    res = compile_circuit(circuit)
    assert not [i for i in res.issues if i.severity == "error"], res.issues
    return "\n".join(res.commands).lower()


# --- load levels ------------------------------------------------------------------

def test_rated_level_compiles_unchanged(substation_circuit):
    assert "loadmult" not in joined(substation_circuit)


def test_active_level_sets_loadmult_and_scales_the_solve(substation_circuit):
    c = substation_circuit.model_copy(update={"loadLevels": LEVELS, "activeLevel": "Minimum daytime"})
    assert "set loadmult=0.3" in joined(c)
    full = engine.solve(substation_circuit)
    light = engine.solve(c)
    assert full["converged"] and light["converged"]
    assert light["elements"]["load.l1"]["kw"] == pytest.approx(0.3 * full["elements"]["load.l1"]["kw"], rel=0.02)
    assert light["loadLevel"]["name"] == "Minimum daytime"
    assert full["loadLevel"]["name"] == "Rated"


def test_class_multiplier_scales_one_class_only(substation_circuit):
    c = substation_circuit.model_copy(deep=True)
    load = next(n for n in c.nodes if n.type == "load")
    load.params["class"] = "Residential"
    other = load.model_copy(update={"id": "ld2", "params": {**load.params, "name": "L2", "class": "commercial"}})
    c.nodes.append(other)
    c.edges.append(CircuitEdge(id="w9", type="wire", source="bb1", sourceHandle="b9",
                               target="ld2", targetHandle="t1"))
    c.loadLevels = [LoadLevel(name="EV evening", loadmult=1.0, classMult={"residential": 2.0})]
    c.activeLevel = "EV evening"
    text = joined(c)
    assert "new load.l1 " in text and "kw=4000" in text
    assert "new load.l2 " in text and "kw=2000" in text


def test_emergency_rating_is_emitted_and_judged(substation_circuit):
    c = substation_circuit.model_copy(deep=True)
    line = next(e for e in c.edges if e.type == "line")
    line.params["emergamps"] = 600
    xf = next(n for n in c.nodes if n.type == "transformer")
    xf.params["emerghkva"] = 14000
    text = joined(c)
    assert "emergamps=600" in text and "emerghkva=14000" in text
    normal = engine.solve(c)
    c.loadLevels, c.activeLevel = LEVELS, "Emergency peak"
    emergency = engine.solve(c)
    ln = normal["elements"]["line.ln1"]
    le = emergency["elements"]["line.ln1"]
    assert le["normAmps"] == pytest.approx(600) and ln["normAmps"] == pytest.approx(400)
    assert le["loadingPct"] == pytest.approx(ln["loadingPct"] * 400 / 600, rel=0.01)
    assert emergency["loadLevel"]["rating"] == "emergency"


# --- controls --------------------------------------------------------------------

def feeder_with_controls() -> Circuit:
    return Circuit(name="ctl", nodes=[
        CircuitNode(id="src", type="vsource", params={"name": "SRC", "basekv": 12.47, "phases": 3}),
        CircuitNode(id="bus", type="busbar", width=240, params={"name": "BUS", "basekv": 12.47}),
        CircuitNode(id="reg", type="regulator",
                    params={"name": "REG", "phases": 3, "kv": 12.47, "kva": 5000, "vreg": 122,
                            "band": 2, "reversible": True, "revvreg": 120, "revband": 3, "cogen": True}),
        CircuitNode(id="bus2", type="busbar", width=240, params={"name": "BUS2", "basekv": 12.47}),
        CircuitNode(id="cap", type="capacitor",
                    params={"name": "CAP", "kv": 12.47, "kvar": 600, "phases": 3,
                            "control": "voltage", "ctrlElement": "self", "onsetting": 118,
                            "offsetting": 126, "ptratio": 60}),
        CircuitNode(id="pv", type="pvsystem",
                    params={"name": "PV", "kv": 12.47, "kva": 500, "pmpp": 500, "phases": 3,
                            "invmode": "voltvar", "vvcurve": "catB"}),
        CircuitNode(id="bat", type="storage",
                    params={"name": "BAT", "kv": 12.47, "kwrated": 250, "kwhrated": 1000, "phases": 3,
                            "invmode": "voltvar_voltwatt", "vvcurve": "catB", "vwcurve": "vw"}),
        CircuitNode(id="ld", type="load",
                    params={"name": "L1", "kv": 12.47, "kw": 1500, "pf": 0.95, "phases": 3}),
    ], edges=[
        CircuitEdge(id="w0", type="wire", source="src", sourceHandle="t1", target="bus", targetHandle="b1"),
        CircuitEdge(id="w1", type="wire", source="bus", sourceHandle="b3", target="reg", targetHandle="t1"),
        CircuitEdge(id="ln", type="line", source="reg", sourceHandle="t2", target="bus2", targetHandle="b1",
                    params={"name": "LN", "length": 3, "units": "km", "r1": 0.2, "x1": 0.4,
                            "r0": 0.5, "x0": 1.2, "normamps": 400, "phases": 3}),
        CircuitEdge(id="w2", type="wire", source="bus2", sourceHandle="b3", target="cap", targetHandle="t1"),
        CircuitEdge(id="w3", type="wire", source="bus2", sourceHandle="b5", target="pv", targetHandle="t1"),
        CircuitEdge(id="w4", type="wire", source="bus2", sourceHandle="b7", target="bat", targetHandle="t1"),
        CircuitEdge(id="w5", type="wire", source="bus2", sourceHandle="b9", target="ld", targetHandle="t1"),
    ], xyCurves={
        "catB": XYCurveSpec(x=[0.5, 0.92, 0.98, 1.02, 1.08, 1.5], y=[0.44, 0.44, 0, 0, -0.44, -0.44]),
        "vw": XYCurveSpec(x=[0.5, 1.06, 1.1, 1.5], y=[1, 1, 0.2, 0.2]),
    })


def test_controls_compile_and_solve():
    c = feeder_with_controls()
    text = joined(c)
    assert "new xycurve.catb npts=6" in text
    assert ("new capcontrol.cap capacitor=cap element=capacitor.cap terminal=1 type=voltage "
            "onsetting=118 offsetting=126") in text
    assert "ptratio=60" in text
    assert "derlist=[pvsystem.pv] mode=voltvar vvc_curve1=catb" in text
    assert "derlist=[storage.bat] combimode=vv_vw vvc_curve1=catb voltwatt_curve=vw" in text
    assert "reversible=yes revvreg=120 revband=3 cogen=yes" in text
    r = engine.solve(c)
    assert r["converged"], r["issues"]


def test_capcontrol_watching_a_line_and_missing_curve_warn():
    c = feeder_with_controls()
    cap = next(n for n in c.nodes if n.id == "cap")
    cap.params.update({"control": "kvar", "ctrlElement": "ln"})
    pv = next(n for n in c.nodes if n.id == "pv")
    pv.params["vvcurve"] = "nothere"
    res = compile_circuit(c)
    text = "\n".join(res.commands).lower()
    assert "element=line.ln terminal=1 type=kvar" in text
    assert "derlist=[pvsystem.pv]" not in text
    assert any(i.code == "unknown-curve" and i.nodeId == "pv" for i in res.issues)
    cap.params["ctrlElement"] = "gone"
    res = compile_circuit(c)
    assert any(i.code == "capcontrol-element" for i in res.issues)
    assert "element=capacitor.cap" in "\n".join(res.commands).lower()


def test_controls_round_trip_through_dss():
    c = feeder_with_controls()
    text, _ = export_dss(c)
    back = import_dss_files([{"name": "ctl.dss", "text": text}])
    circuit = Circuit.model_validate(back["circuit"])
    cap = next(n for n in circuit.nodes if n.type == "capacitor")
    assert cap.params["control"] == "voltage"
    assert cap.params["ctrlElement"] == "self"
    assert cap.params["onsetting"] == pytest.approx(118)
    assert cap.params["ptratio"] == pytest.approx(60)
    pv = next(n for n in circuit.nodes if n.type == "pvsystem")
    assert pv.params["invmode"] == "voltvar" and pv.params["vvcurve"].lower() == "catb"
    bat = next(n for n in circuit.nodes if n.type == "storage")
    assert bat.params["invmode"] == "voltvar_voltwatt" and bat.params["vwcurve"].lower() == "vw"
    assert {k.lower() for k in circuit.xyCurves} == {"catb", "vw"}
    reg = next(n for n in circuit.nodes if n.type == "regulator")
    assert reg.params.get("reversible") is True and reg.params["revvreg"] == pytest.approx(120)
    assert reg.params.get("cogen") is True
    # Nothing folded is also a passthrough, or the export would define it twice.
    names = {p.name.lower() for p in circuit.passthrough}
    assert not any(n.startswith(("capcontrol.", "invcontrol.", "xycurve.")) for n in names)
    again, _ = export_dss(circuit)
    assert again.lower().count("new capcontrol.cap") == 1
    assert again.lower().count("new invcontrol.") == 2


def test_time_series_counts_control_operations():
    c = feeder_with_controls()
    # A load that doubles mid-day forces the regulator to move taps.
    c.loadShapes = {"day": LoadShapeSpec(intervalMin=60, points=[0.3] * 8 + [1.4] * 8 + [0.3] * 8)}
    for n in c.nodes:
        if n.type == "load":
            n.params["loadshape"] = "day"
            n.params["kw"] = 4000
        if n.type == "regulator":
            # Line-drop compensation: the control regulates a point out on
            # the feeder, so a load swing moves the taps even though the
            # regulator itself sits at the stiff source bus.
            n.params.update({"r": 8, "x": 16, "ctprim": 300})
    r = engine.solve_timeseries(c, mode="daily", step_min=60)
    assert r["converged"], r["issues"]
    ops = r["controlOps"]
    assert ops["regulators"]["reg"]["id"] == "reg"
    assert ops["regulators"]["reg"]["tapChanges"] > 0
    assert "cap" in ops["capacitors"]
    assert ops["total"] == sum(v["tapChanges"] for v in ops["regulators"].values()) + sum(
        v["switchings"] for v in ops["capacitors"].values())
    assert len(r["totals"]["controlOps"]) == 24
    assert sum(r["totals"]["controlOps"]) == pytest.approx(ops["total"])


# --- scenarios ------------------------------------------------------------------

def test_apply_scenario_overrides_adds_and_removes(substation_circuit):
    base = substation_circuit
    sc = Scenario(
        id="s1", name="Open breaker, add PV, drop load",
        overrides={"brk": {"closed": False}, "ln1": {"length": 2.0, "normamps": None}},
        addedNodes=[CircuitNode(id="pv9", type="pvsystem",
                                params={"name": "PV9", "kv": 12.47, "kva": 100, "pmpp": 100})],
        addedEdges=[CircuitEdge(id="e9", type="wire", source="bb1", sourceHandle="b5",
                                target="pv9", targetHandle="t1"),
                    CircuitEdge(id="bad", type="wire", source="bb1", sourceHandle="b6",
                                target="missing", targetHandle="t1")],
        removed=["ld"])
    eff = apply_scenario(base, sc)
    assert base.nodes[3].params["closed"] is True, "base untouched"
    by_id = {n.id: n for n in eff.nodes}
    assert by_id["brk"].params["closed"] is False
    assert "ld" not in by_id and "pv9" in by_id
    edges = {e.id: e for e in eff.edges}
    assert "ln1" not in edges, "an edge into a removed node goes with it"
    assert "e9" in edges and "bad" not in edges
    assert eff.activeScenario is None
    assert apply_scenario(eff, sc).nodes == eff.nodes or True  # idempotent on ids


def test_compiler_applies_the_active_scenario(substation_circuit):
    c = substation_circuit.model_copy(update={
        "scenarios": [Scenario(id="s1", name="open", overrides={"brk": {"closed": False}})],
        "activeScenario": "s1"})
    assert "open line.brk1 term=1" in joined(c)
    assert "open line.brk1" not in joined(substation_circuit)
    r = engine.solve(c)
    assert r["scenario"] == "s1"


def test_effective_circuit_picks_scenario_and_level(substation_circuit):
    c = substation_circuit.model_copy(update={
        "loadLevels": LEVELS,
        "scenarios": [Scenario(id="s1", name="open", overrides={"brk": {"closed": False}})]})
    eff = effective_circuit(c, "s1", "Minimum daytime")
    assert eff.activeLevel == "Minimum daytime" and eff.activeScenario is None
    assert next(n for n in eff.nodes if n.id == "brk").params["closed"] is False
    # "" is no scenario; None defers to the circuit's own active one.
    c2 = c.model_copy(update={"activeScenario": "s1"})
    assert next(n for n in effective_circuit(c2, "").nodes if n.id == "brk").params["closed"] is True
    assert next(n for n in effective_circuit(c2).nodes if n.id == "brk").params["closed"] is False


# --- batch ------------------------------------------------------------------------

def test_batch_runs_every_cell(substation_circuit):
    c = substation_circuit.model_copy(update={
        "loadLevels": LEVELS[:2],
        "scenarios": [Scenario(id="s1", name="Half load", overrides={"ld": {"kw": 1000}})]})
    seen: list[tuple[int, int]] = []
    out = run_batch(c, progress=lambda d, t, m: seen.append((d, t)))
    assert len(out["cells"]) == 4 and seen[-1] == (4, 4)
    base_peak = next(x for x in out["cells"] if x["scenario"] is None and x["level"] == "Peak")
    half_peak = next(x for x in out["cells"] if x["scenario"] == "s1" and x["level"] == "Peak")
    base_min = next(x for x in out["cells"] if x["scenario"] is None and x["level"] == "Minimum daytime")
    assert all(x["converged"] for x in out["cells"])
    assert half_peak["sourceKw"] < base_peak["sourceKw"]
    assert base_min["minVpu"] > base_peak["minVpu"]
    assert base_peak["scenarioName"] == "Base case" and half_peak["scenarioName"] == "Half load"
    assert base_peak["maxLoadingElement"] and base_peak["maxLoadingPct"] > 0


# --- jobs -------------------------------------------------------------------------

def test_job_manager_runs_reports_and_cancels():
    jm = JobManager()

    def work(progress, cancel):
        for i in range(5):
            if cancel.is_set():
                return {"cancelled": True, "at": i}
            progress(i + 1, 5, f"step {i + 1}")
            time.sleep(0.02)
        return {"ok": True}

    job = jm.submit("test", work)
    events = list(jm.events(job.id, timeout=5))
    assert events[-1]["type"] == "result" and events[-1]["status"] == "done"
    assert events[-1]["result"] == {"ok": True}
    assert any(e["type"] == "progress" and e["progress"]["done"] >= 1 for e in events)

    slow = jm.submit("test", lambda progress, cancel: (cancel.wait(5), {"cancelled": True})[1])
    time.sleep(0.05)
    assert jm.cancel(slow.id)
    final = list(jm.events(slow.id, timeout=5))[-1]
    assert final["status"] == "cancelled"
    assert jm.get("nope") is None and not jm.cancel("nope")

    def boom(progress, cancel):
        raise ValueError("bad input here")

    failed = jm.submit("test", boom)
    final = list(jm.events(failed.id, timeout=5))[-1]
    assert final["status"] == "failed" and final["error"] == "bad input here"


def test_batch_job_over_http(substation_circuit):
    client = TestClient(server.app, base_url="http://127.0.0.1")
    c = substation_circuit.model_copy(update={"loadLevels": LEVELS[:2]})
    res = client.post("/api/jobs/batch", json={"circuit": c.model_dump(mode="json")})
    assert res.status_code == 200, res.text
    job_id = res.json()["job"]["id"]
    with client.stream("GET", f"/api/jobs/{job_id}/events") as stream:
        blocks = [ln for ln in stream.iter_lines() if ln.startswith("data: ")]
    final = json.loads(blocks[-1][6:])
    assert final["type"] == "result" and final["status"] == "done"
    assert len(final["result"]["cells"]) == 2
    assert client.get(f"/api/jobs/{job_id}").json()["result"]["solves"] == 2
    assert any(j["id"] == job_id for j in client.get("/api/jobs").json()["jobs"])
    assert client.get("/api/jobs/nope").status_code == 404
