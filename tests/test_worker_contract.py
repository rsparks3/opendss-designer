"""The worker contract (0.4.0): what a trusted gateway may ask of this app.

Three generic reverse-proxy features, all inert unless configured:
per-request limit *tightening* from a trusted header, engine-time reporting,
and request-id passthrough. None of them introduces a user concept here.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.settings import BadLimitsHeader, Settings, reload_settings

HEADER = "x-opendss-limits"


def _json(circuit) -> dict:
    return json.loads(circuit.model_dump_json())


def _plan(**limits) -> str:
    return json.dumps({"plan": {"name": "Free", "message": "12 of 20 min used",
                                "links": [{"label": "Upgrade", "url": "/account"}]},
                       **limits})


@pytest.fixture()
def worker(tmp_path, monkeypatch):
    """A demo-mode process that trusts the limits header, like a gateway worker."""
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("SPA", encoding="utf-8")
    monkeypatch.setattr(server, "STATIC_DIR", static)
    cfg = reload_settings({
        "OPENDSS_DESIGNER_MODE": "demo",
        "OPENDSS_DESIGNER_MAX_NODES": "10",
        "OPENDSS_DESIGNER_TRUSTED_LIMITS_HEADER": HEADER,
    })
    try:
        yield TestClient(server.create_app(cfg), base_url="http://127.0.0.1")
    finally:
        reload_settings({})


@pytest.fixture()
def untrusting(tmp_path, monkeypatch):
    """Same limits, but no header is trusted: the local/plain-demo default."""
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("SPA", encoding="utf-8")
    monkeypatch.setattr(server, "STATIC_DIR", static)
    cfg = reload_settings({"OPENDSS_DESIGNER_MODE": "demo",
                           "OPENDSS_DESIGNER_MAX_NODES": "10"})
    try:
        yield TestClient(server.create_app(cfg), base_url="http://127.0.0.1")
    finally:
        reload_settings({})


# --- Settings.tightened: the ceiling is the process environment -----------

def test_tightened_only_ever_lowers_a_limit():
    base = Settings.from_env({"OPENDSS_DESIGNER_MODE": "demo",
                              "OPENDSS_DESIGNER_MAX_NODES": "100"})
    assert base.tightened({"maxNodes": 5}).max_nodes == 5
    assert base.tightened({"maxNodes": 5000}).max_nodes == 100
    # 0 means "disable this cap" for env vars; from a proxy it means nothing.
    assert base.tightened({"maxNodes": 0}).max_nodes == 100
    assert base.tightened({"maxNodes": -1}).max_nodes == 100


def test_tightened_applies_where_the_process_has_no_limit():
    local = Settings.from_env({})
    assert local.max_nodes is None
    assert local.tightened({"maxNodes": 7}).max_nodes == 7
    assert local.tightened({"engineResultTimeoutS": 2.5}).engine_result_timeout_s == 2.5


def test_tightened_ignores_unknown_keys_and_rejects_bad_values():
    base = Settings.from_env({})
    assert base.tightened({"maxConcurrentTimeseries": 99, "whatever": 1}) == base
    with pytest.raises(BadLimitsHeader):
        base.tightened({"maxNodes": "lots"})
    with pytest.raises(BadLimitsHeader):
        base.tightened({"maxNodes": True})
    with pytest.raises(BadLimitsHeader):
        base.tightened([1, 2, 3])


def test_plan_is_validated_and_bounded():
    base = Settings.from_env({})
    plan = base.tightened(json.loads(_plan())).plan
    assert plan.name == "Free"
    assert plan.links == (("Upgrade", "/account"),)
    assert base.tightened(json.loads(_plan())).plan_label == "the Free plan"
    assert base.plan_label == "the public demo"
    with pytest.raises(BadLimitsHeader):
        base.tightened({"plan": {"name": ""}})
    with pytest.raises(BadLimitsHeader):
        # Rendered as a link in the banner, so only web links are allowed.
        base.tightened({"plan": {"name": "X", "links": [
            {"label": "x", "url": "javascript:alert(1)"}]}})


# --- The header is honoured only when the operator names it ----------------

def test_header_is_ignored_unless_trusted(untrusting, substation_circuit):
    res = untrusting.post("/api/validate", json=_json(substation_circuit),
                          headers={HEADER: json.dumps({"maxNodes": 2})})
    assert res.status_code == 200
    assert not [i for i in res.json()["issues"] if i["code"] == "limit-nodes"]
    assert "plan" not in untrusting.get("/api/health").json()


def test_trusted_header_tightens_and_names_the_plan(worker, substation_circuit):
    res = worker.post("/api/validate", json=_json(substation_circuit),
                      headers={HEADER: _plan(maxNodes=2)})
    codes = {i["code"]: i["message"] for i in res.json()["issues"]}
    assert "limit-nodes" in codes
    assert "the Free plan is limited to 2" in codes["limit-nodes"]
    assert "public demo" not in codes["limit-nodes"]


def test_trusted_header_cannot_loosen(worker, substation_circuit):
    """Process says 10, header says 1000, circuit has 5 nodes: fine either way.
    Process says 3 (via the header being the *only* thing that tightens), the
    real check is that 1000 does not raise the ceiling above 10."""
    reload_settings({"OPENDSS_DESIGNER_MODE": "demo",
                     "OPENDSS_DESIGNER_MAX_NODES": "3",
                     "OPENDSS_DESIGNER_TRUSTED_LIMITS_HEADER": HEADER})
    res = worker.post("/api/validate", json=_json(substation_circuit),
                      headers={HEADER: json.dumps({"maxNodes": 1000})})
    assert any(i["code"] == "limit-nodes" for i in res.json()["issues"])


def test_malformed_header_is_a_400_not_ignored(worker):
    res = worker.get("/api/health", headers={HEADER: "{not json"})
    assert res.status_code == 400
    assert "limits header" in res.json()["detail"]
    res = worker.get("/api/health", headers={HEADER: json.dumps({"maxNodes": "x"})})
    assert res.status_code == 400


def test_overlay_reaches_the_engine_thread(worker, substation_circuit):
    """`limit_issues` is called inside `engine.solve`, which runs on the
    dedicated engine thread. The overlay has to survive that hop or a solve
    would enforce different limits than validation showed."""
    res = worker.post("/api/solve", json=_json(substation_circuit),
                      headers={HEADER: _plan(maxNodes=2)})
    assert res.status_code == 200
    body = res.json()
    assert body["converged"] is False
    assert any(i["code"] == "limit-nodes" for i in body["issues"])


def test_health_reports_the_effective_limits_and_plan(worker):
    plain = worker.get("/api/health").json()
    assert plain["limits"]["maxNodes"] == 10
    assert "plan" not in plain

    scoped = worker.get("/api/health", headers={HEADER: _plan(maxNodes=4)}).json()
    assert scoped["limits"]["maxNodes"] == 4
    assert scoped["plan"] == {"name": "Free", "message": "12 of 20 min used",
                              "links": [{"label": "Upgrade", "url": "/account"}]}


def test_timeseries_cost_message_names_the_plan(worker, substation_circuit):
    res = worker.post("/api/timeseries",
                      json={"circuit": _json(substation_circuit),
                            "mode": "yearly", "stepMin": 15},
                      headers={HEADER: _plan(maxTimeseriesCost=10)})
    assert res.status_code == 413
    assert "the Free plan" in res.json()["detail"]


# --- Engine time ------------------------------------------------------------

def test_engine_seconds_header_on_engine_backed_responses(untrusting, substation_circuit):
    res = untrusting.post("/api/solve", json=_json(substation_circuit))
    assert res.status_code == 200
    assert float(res.headers["x-engine-seconds"]) > 0
    # Not on responses that never touched the engine.
    assert "x-engine-seconds" not in untrusting.get("/api/samples").headers


def test_engine_seconds_in_final_timeseries_event(untrusting, substation_circuit):
    body = {"circuit": _json(substation_circuit), "mode": "daily", "stepMin": 60}
    events = []
    with untrusting.stream("POST", "/api/timeseries", json=body) as resp:
        buffer = "".join(resp.iter_text())
    for block in buffer.split("\n\n"):
        if block.startswith("data: "):
            events.append(json.loads(block[len("data: "):]))
    final = events[-1]
    assert final["type"] == "result"
    assert final["engineSeconds"] > 0
    assert all("engineSeconds" not in e for e in events[:-1])


# --- Request id -------------------------------------------------------------

def test_request_id_is_echoed_when_well_formed(untrusting):
    res = untrusting.get("/api/health", headers={"X-Request-ID": "gw-7f3a.1"})
    assert res.headers["x-request-id"] == "gw-7f3a.1"


def test_request_id_is_dropped_when_junk(untrusting):
    res = untrusting.get("/api/health",
                         headers={"X-Request-ID": "x" * 65})
    assert "x-request-id" not in res.headers
    res = untrusting.get("/api/health", headers={"X-Request-ID": "a b\tc"})
    assert "x-request-id" not in res.headers


def test_request_id_reaches_json_logs(untrusting, substation_circuit):
    import logging

    from opendss_designer.logging_config import JsonFormatter

    formatter = JsonFormatter()
    captured: list[str] = []

    class Grab(logging.Handler):
        def emit(self, record):
            captured.append(formatter.format(record))

    log = logging.getLogger("opendss_designer.api.routes")
    handler = Grab()
    log.addHandler(handler)
    try:
        # A time-series run whose worker thread logs an exception is the one
        # place a request-scoped log line is emitted off the request thread.
        # Cheaper: emit directly from inside a request via the engine thread.
        from opendss_designer.core import engine

        @engine.on_engine_thread
        def log_from_engine():
            logging.getLogger("opendss_designer.api.routes").warning("probe")

        from opendss_designer import context
        ctx = context.RequestContext("req-42")
        tokens = context.bind(None, ctx)
        try:
            log_from_engine()
        finally:
            context.unbind(tokens)
    finally:
        log.removeHandler(handler)

    assert captured, "no log line captured"
    assert json.loads(captured[-1])["requestId"] == "req-42"
