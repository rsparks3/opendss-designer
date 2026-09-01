"""Time-series engine: step loop, recording, energy integration, downsampling,
cancel — plus the SSE endpoint (the repo's first HTTP-layer test)."""
import json
import threading

import pytest

from opendss_designer.core import engine
from opendss_designer.core.engine import _downsample_minmax
from opendss_designer.core.model import LoadShapeSpec

SHAPE = [0.4] * 8 + [1.0] * 10 + [0.4] * 6  # peak 08:00-18:00


def _with_shape(circuit):
    circuit.loadShapes = {"day24": LoadShapeSpec(intervalMin=60, points=SHAPE)}
    load = next(n for n in circuit.nodes if n.type == "load")
    load.params["loadshape"] = "day24"
    return circuit


def test_daily_run_records_everything(substation_circuit):
    c = _with_shape(substation_circuit)
    r = engine.solve_timeseries(c, mode="daily", step_min=60)
    assert r["converged"], r["issues"]
    assert r["steps"] == 24
    assert not r["downsampled"]
    assert len(r["time"]) == 24
    assert r["time"][1] - r["time"][0] == pytest.approx(1.0)

    # Load kW follows the shape: 2000 kW at peak, 800 off-peak.
    load_kw = r["elements"]["load.l1"]["kw"]
    assert max(load_kw) == pytest.approx(2000, rel=0.05)
    assert min(load_kw) == pytest.approx(800, rel=0.05)

    # Energy ≈ mean(shape) × 2000 kW × 24 h (plus small losses).
    expected = sum(SHAPE) / len(SHAPE) * 2000 * 24
    assert r["summary"]["energyKwh"] == pytest.approx(expected, rel=0.05)
    assert r["summary"]["lossesKwh"] > 0
    assert 8 <= r["summary"]["peakHour"] <= 18

    # Bus voltage envelopes recorded for every bus, every step, with the
    # static kvBase the scrub view needs.
    for b, env in r["buses"].items():
        assert len(env["vmin"]) == 24, b
        assert env["kvBase"] > 0, b
    assert r["lineBuses"], "line->buses map needed for scrub tooltips"
    assert r["summary"]["minVpu"]["value"] < 1.0
    assert r["nonConvergedSteps"] == []


def test_yearly_run_downsamples(substation_circuit):
    c = _with_shape(substation_circuit)
    r = engine.solve_timeseries(c, mode="yearly", step_min=60)
    assert r["converged"], r["issues"]
    assert r["steps"] == 8760
    assert r["downsampled"]
    # min/max pairs per bucket: bounded, aligned across series.
    assert len(r["time"]) <= 2 * 750
    assert len(r["totals"]["kw"]) == len(r["time"])
    for env in r["buses"].values():
        assert len(env["vmin"]) == len(r["time"])
    # Envelope preserved: the peak survives downsampling (2000 kW + losses).
    assert max(r["totals"]["kw"]) == pytest.approx(2000, rel=0.05)
    assert max(r["totals"]["kw"]) == pytest.approx(r["summary"]["peakKw"], rel=1e-3)
    assert r["summary"]["energyKwh"] == pytest.approx(
        sum(SHAPE) / len(SHAPE) * 2000 * 8760, rel=0.05)


def test_yearly_scale_shape_solves_via_side_file(substation_circuit):
    """An 8760-point shape (NREL-import scale) exercises the mult=(file=...)
    path end to end — the inline form corrupts the DSS parser on Linux."""
    substation_circuit.loadShapes = {
        "year": LoadShapeSpec(intervalMin=60, points=SHAPE * 365)}
    load = next(n for n in substation_circuit.nodes if n.type == "load")
    load.params["loadshape"] = "year"
    r = engine.solve_timeseries(substation_circuit, mode="daily", step_min=60)
    assert r["converged"], r["issues"]
    load_kw = r["elements"]["load.l1"]["kw"]
    assert max(load_kw) == pytest.approx(2000, rel=0.05)
    assert min(load_kw) == pytest.approx(800, rel=0.05)


def test_cancel_stops_early(substation_circuit):
    c = _with_shape(substation_circuit)
    cancel = threading.Event()
    seen = []

    def progress(step, total):
        seen.append(step)
        if step >= total // 10:
            cancel.set()

    r = engine.solve_timeseries(c, mode="yearly", step_min=60,
                                progress_cb=progress, cancel=cancel)
    assert r["cancelled"]
    assert r["steps"] < 8760


def test_downsample_minmax_envelope():
    series = list(range(100)) + [500] + list(range(100, 0, -1))
    out = _downsample_minmax(series, 10)
    assert max(v for v in out if v is not None) == 500
    assert min(v for v in out if v is not None) == 0
    assert len(out) == 2 * ((len(series) + 9) // 10)
    assert _downsample_minmax([None, None], 2) == [None, None]


def test_compile_error_returns_cleanly(substation_circuit):
    load = next(n for n in substation_circuit.nodes if n.type == "load")
    load.params["loadshape"] = "ghost"
    r = engine.solve_timeseries(substation_circuit)
    assert not r["converged"]
    assert any(i["code"] == "missing-loadshape" for i in r["issues"])


def test_sse_endpoint_streams_progress_then_result(substation_circuit):
    from fastapi.testclient import TestClient
    from opendss_designer.server import create_app

    c = _with_shape(substation_circuit)
    app = create_app()
    # Explicit loopback host: the app validates Host (DNS-rebinding
    # defense), and TestClient would otherwise send "testserver".
    client = TestClient(app, base_url="http://127.0.0.1")
    body = {"circuit": json.loads(c.model_dump_json()), "mode": "daily", "stepMin": 60}
    events = []
    with client.stream("POST", "/api/timeseries", json=body) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        buffer = ""
        for chunk in resp.iter_text():
            buffer += chunk
        for block in buffer.split("\n\n"):
            if block.startswith("data: "):
                events.append(json.loads(block[len("data: "):]))
    kinds = [e["type"] for e in events]
    assert kinds[-1] == "result"
    assert all(k == "progress" for k in kinds[:-1])
    result = events[-1]["result"]
    assert result["converged"]
    assert result["steps"] == 24
