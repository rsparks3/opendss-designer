"""Security regressions: path containment, host validation, no path leakage.

These guard fixes shipped in 0.1.3; every one of them was exploitable before.
"""
from __future__ import annotations

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """App served from a throwaway static dir with a secret file just outside it."""
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html>SPA", encoding="utf-8")
    (static / "assets" / "app.js").write_text("// bundle", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("TOP SECRET", encoding="utf-8")

    monkeypatch.setattr(server, "STATIC_DIR", static)
    return TestClient(server.create_app(), base_url="http://127.0.0.1")


def test_serves_real_static_files(client):
    assert client.get("/assets/app.js").text == "// bundle"
    assert "SPA" in client.get("/").text


@pytest.mark.parametrize("path", [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2e%2e%2fsecret.txt",
    "/assets/../../secret.txt",
])
def test_traversal_falls_back_to_index(client, path):
    """`..` must never escape the static root — it used to serve the file."""
    res = client.get(path)
    assert res.status_code == 200
    assert "TOP SECRET" not in res.text
    assert "SPA" in res.text


def test_absolute_path_is_not_served(client, tmp_path):
    """pathlib drops the left operand on an absolute right operand, so
    `GET /C:/Windows/win.ini` used to read straight off the filesystem."""
    res = client.get(f"/{tmp_path.as_posix()}/secret.txt")
    assert "TOP SECRET" not in res.text
    assert "SPA" in res.text


def test_unknown_host_rejected(client):
    """DNS rebinding: a page resolving its own domain to 127.0.0.1 must not
    be able to drive a local instance."""
    res = client.get("/api/health", headers={"Host": "evil.example.com"})
    assert res.status_code == 400


def test_loopback_hosts_allowed(client):
    for host in ("127.0.0.1", "localhost"):
        assert client.get("/api/health", headers={"Host": host}).status_code == 200


def test_unknown_api_route_404s(client):
    """Used to return index.html with a 200, hiding client-side typos."""
    assert client.get("/api/nope").status_code == 404


def test_known_api_route_still_works(client):
    assert client.get("/api/health").status_code == 200


def test_engine_safety_flags_are_disabled():
    """The DSS script language can read/write files and spawn processes.
    `/api/import/dss` compiles user-supplied text, so these stay off.

    Read on the engine thread: entering the library from an ad-hoc thread
    arms FP traps on macOS (see engine._clear_fp_traps).
    """
    import opendssdirect as dss

    from opendss_designer.core import engine

    @engine.on_engine_thread
    def read_flags() -> dict[str, bool]:
        with engine.dss_guard():
            engine._ensure_init()
        return {
            "AllowForms": bool(dss.Basic.AllowForms()),
            "AllowEditor": bool(dss.Basic.AllowEditor()),
            "AllowDOScmd": bool(dss.Basic.AllowDOScmd()),
            "AllowChangeDir": bool(dss.Basic.AllowChangeDir()),
        }

    assert read_flags() == {
        "AllowForms": False,
        "AllowEditor": False,
        "AllowDOScmd": False,
        "AllowChangeDir": False,
    }


# --- .dss import: an import is data, not a program -------------------------

MAIN = """
new circuit.mini basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000
redirect helper.dss
new load.ld1 bus1=srcbus phases=3 kv=12.47 kw=100 pf=0.95
"""


def _import(files):
    from opendss_designer.core.importer import import_dss_files
    return import_dss_files(files)


def _fails(files, match):
    from opendss_designer.core.importer import ImportFailure
    with pytest.raises(ImportFailure, match=match):
        _import(files)


def test_companion_file_cannot_redirect_outside(tmp_path):
    """The old check ran only on the main file, so a companion could
    redirect anywhere it liked."""
    _fails([{"name": "main.dss", "text": MAIN},
            {"name": "helper.dss", "text": "redirect ../../../etc/passwd\n"}],
           "were not selected")


def test_companion_file_cannot_save(tmp_path):
    """Skipped with a warning, not run -- and nothing is written."""
    res = _import([{"name": "main.dss", "text": MAIN},
                   {"name": "helper.dss",
                    "text": f"save circuit dir={tmp_path}\n"}])
    assert any("save" in w for w in res["warnings"])
    assert not any(tmp_path.iterdir()), "save must not have run"


def test_export_is_skipped_but_the_file_still_imports():
    """Real feeders end with solve/export/show; those must not break import."""
    res = _import([{"name": "main.dss",
                    "text": MAIN + "solve\nexport voltages\nshow voltages\n"},
                   {"name": "helper.dss", "text": "! nothing\n"}])
    assert res["circuit"]["nodes"]
    assert any("export" in w for w in res["warnings"])


def test_loadshape_file_reference_must_be_uploaded():
    """`mult=(file=...)` bypassed the old regex entirely."""
    _fails([{"name": "main.dss", "text": MAIN},
            {"name": "helper.dss",
             "text": "new loadshape.s npts=3 mult=(file=/etc/passwd)\n"}],
           "were not selected")


# An empty name legitimately falls back to "file.dss"; these do not.
@pytest.mark.parametrize("name", ["..", ".", "a/../..", "  ", "x	y"])
def test_unusable_filenames_are_rejected_not_crashed(name):
    """`Path('..').name` is '..', which named a directory -> write crash."""
    _fails([{"name": name, "text": MAIN}], "not a usable file name")


def test_subdirectory_reference_resolves_to_the_uploaded_file():
    """Rewriting to the basename also fixes a real bug: `redirect sub/x.dss`
    used to pass the check and then fail to resolve in the flat temp dir."""
    res = _import([
        {"name": "main.dss", "text": MAIN.replace("redirect helper.dss",
                                                  "redirect sub/helper.dss")},
        {"name": "helper.dss",
         "text": "new linecode.lc1 nphases=3 r1=0.1 x1=0.3 "
                 "r0=0.3 x0=0.9 normamps=400 units=km\n"},
    ])
    assert res["circuit"]["nodes"]


def test_normal_import_still_works():
    res = _import([{"name": "main.dss", "text": MAIN},
                   {"name": "helper.dss", "text": "! nothing here\n"}])
    assert res["circuit"]["nodes"]


# --- compiler: property values are allowlisted, not passed through ---------

def _compile(node_type, params, extra_nodes=()):
    from opendss_designer.core.compiler import compile_circuit
    from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode
    nodes = [
        CircuitNode(id="src", type="vsource", params={"name": "S", "basekv": 12.47}),
        CircuitNode(id="n1", type=node_type, params=params),
        *extra_nodes,
    ]
    edges = [CircuitEdge(id="e1", type="wire", source="src", sourceHandle="t1",
                         target="n1", targetHandle="t1")]
    return "\n".join(compile_circuit(Circuit(nodes=nodes, edges=edges)).commands)


def test_conn_injection_is_neutralized():
    """`conn` was interpolated raw, so it could append DSS properties."""
    text = _compile("load", {"name": "L", "kv": 12.47, "kw": 10,
                             "conn": "wye kw=999999 enabled=no"})
    assert "conn=wye " in text
    assert "999999" not in text


def test_units_injection_is_neutralized():
    from opendss_designer.core.compiler import compile_circuit
    from opendss_designer.core.model import Circuit, CircuitEdge, CircuitNode
    nodes = [CircuitNode(id="src", type="vsource", params={"basekv": 12.47}),
             CircuitNode(id="b", type="busbar", params={"basekv": 12.47})]
    edges = [CircuitEdge(id="e1", type="line", source="src", sourceHandle="t1",
                         target="b", targetHandle="b0",
                         params={"name": "LN", "units": "km r1=0 x1=0"})]
    text = "\n".join(compile_circuit(Circuit(nodes=nodes, edges=edges)).commands)
    assert "units=km " in text


def test_dispatch_is_allowlisted():
    text = _compile("storage", {"name": "B", "kv": 12.47,
                                "dispatch": "follow bogus=1"})
    assert "dispmode=follow" in text
    assert "bogus" not in text


def test_valid_values_are_preserved():
    assert "conn=delta" in _compile("load", {"name": "L", "kv": 12.47,
                                             "kw": 10, "conn": "delta"})


def test_non_finite_numbers_fall_back_to_default():
    """json.loads parses 1e999 as inf, which reached commands as 'inf'."""
    import json
    kw = json.loads('{"kw": 1e999}')["kw"]
    assert kw == float("inf")
    text = _compile("load", {"name": "L", "kv": 12.47, "kw": kw})
    assert "inf" not in text and "nan" not in text.lower()


def test_phase_count_is_clamped():
    text = _compile("load", {"name": "L", "kv": 12.47, "kw": 10, "phases": 1e9})
    assert "phases=3" in text


def test_line_units_match_the_engine_conversion_table():
    """Drift guard: the allowlist and the km-conversion map must agree, or a
    legal unit silently converts as if it were km."""
    from opendss_designer.core import engine
    from opendss_designer.core.compiler import LINE_UNITS
    assert set(engine._KM_PER_UNIT) == set(LINE_UNITS)


def test_importer_units_are_all_accepted():
    """importer._UNIT_CODES emits none/in/cm, which the stricter
    linecodes.VALID_UNITS would have silently rewritten to km."""
    from opendss_designer.core.compiler import LINE_UNITS
    from opendss_designer.core.importer import _UNIT_CODES
    assert set(_UNIT_CODES.values()) <= set(LINE_UNITS)


# --- no server-side detail in responses ------------------------------------

def test_linecodes_response_has_no_server_path():
    from opendss_designer.core.linecodes import load_line_codes
    assert "path" not in load_line_codes()


def test_linecodes_endpoint_has_no_server_path(client):
    assert "path" not in client.get("/api/linecodes").json()


def test_solve_error_does_not_dump_the_command_list(substation_circuit):
    """A compile error used to return every generated DSS command."""
    from opendss_designer.core import engine
    substation_circuit.nodes = [n for n in substation_circuit.nodes
                                if n.type != "vsource"]
    res = engine.solve(substation_circuit)
    assert not res["converged"]
    assert "commands" not in res


def test_dss_error_messages_hide_the_workdir(substation_circuit):
    """Big loadshapes compile to `mult=(file="<abs path>")`; a failing command
    used to echo that path straight to the browser."""
    import tempfile

    from opendss_designer.core import engine
    from opendss_designer.core.model import LoadShapeSpec

    # Over MAX_INLINE_SHAPE_PTS, so the shape becomes a file reference.
    substation_circuit.loadShapes["big"] = LoadShapeSpec(
        points=[1.0] * 500, intervalMin=60.0)
    load = next(n for n in substation_circuit.nodes if n.type == "load")
    load.params["loadshape"] = "big"
    load.params["kv"] = "not-a-number"

    res = engine.solve(substation_circuit)
    blob = json.dumps(res)
    assert str(engine.SHAPE_DIR) not in blob
    assert tempfile.gettempdir() not in blob


def test_redact_replaces_workdir_paths():
    from opendss_designer.core import engine
    msg = f'OpenDSS rejected: mult=(file="{engine.SHAPE_DIR / "s.csv"}")'
    assert str(engine.SHAPE_DIR) not in engine._redact(msg)
    assert "<workdir>" in engine._redact(msg)


def test_health_does_not_enter_the_engine_thread(client):
    """/api/health must answer while the engine is busy, or a liveness probe
    reports a container dead whenever someone is running a long solve."""
    from opendss_designer.core import engine

    engine.opendss_version()  # prime the cache

    started, release = threading.Event(), threading.Event()

    @engine.on_engine_thread
    def hog():
        started.set()
        release.wait(timeout=10)

    t = threading.Thread(target=hog, daemon=True)
    t.start()
    try:
        assert started.wait(timeout=10)
        start = time.monotonic()
        assert client.get("/api/health").status_code == 200
        assert time.monotonic() - start < 2.0
    finally:
        release.set()
        t.join(timeout=10)


# --- time series: flat memory, bounded cost --------------------------------

def test_envelope_matches_the_batch_downsampler():
    """The run now buckets as it goes instead of keeping every sample and
    reducing at the end; the output must be byte-identical to the old path."""
    import random

    from opendss_designer.core.engine import _downsample_minmax, _Envelope

    random.seed(7)
    for _ in range(200):
        n, k = random.randint(1, 60), random.randint(1, 9)
        series = [None if random.random() < 0.15 else round(random.uniform(-5, 5), 3)
                  for _ in range(n)]
        env = _Envelope(k)
        for v in series:
            env.add(v)
        expected = series if k == 1 else _downsample_minmax(series, k)
        assert env.finish() == expected, (n, k)


def test_timeseries_axes_stay_aligned(substation_circuit):
    """Time axis and every per-bus series must have the same length, including
    on a downsampled yearly run."""
    from opendss_designer.core import engine

    res = engine.solve_timeseries(substation_circuit, "yearly", 60)
    assert res["downsampled"]
    n = len(res["time"])
    assert n > 0
    for bus in res["buses"].values():
        assert len(bus["vmin"]) == n
        assert len(bus["vmax"]) == n
    for elem in res["elements"].values():
        assert len(elem["kw"]) == n


# --- demo mode: off by default, limits on when asked for -------------------

@pytest.fixture()
def demo(tmp_path, monkeypatch):
    """Turn on demo mode for one test, then restore local defaults."""
    from opendss_designer import server
    from opendss_designer.settings import reload_settings

    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("SPA", encoding="utf-8")
    monkeypatch.setattr(server, "STATIC_DIR", static)

    cfg = reload_settings({
        "OPENDSS_DESIGNER_MODE": "demo",
        "OPENDSS_DESIGNER_MAX_NODES": "5",
        "OPENDSS_DESIGNER_MAX_BODY_BYTES": str(4096),
        "OPENDSS_DESIGNER_MAX_IMPORT_FILES": "2",
    })
    try:
        yield TestClient(server.create_app(cfg), base_url="http://127.0.0.1")
    finally:
        reload_settings({})


def test_local_mode_is_the_default_and_has_no_limits():
    from opendss_designer.settings import Settings
    cfg = Settings.from_env({})
    assert not cfg.demo
    assert cfg.max_nodes is None and cfg.max_body_bytes is None


def test_demo_reports_its_mode_and_limits(demo):
    body = demo.get("/api/health").json()
    assert body["mode"] == "demo"
    assert body["limits"]["maxNodes"] == 5


def test_local_health_reports_no_limits(client):
    body = client.get("/api/health").json()
    assert body["mode"] == "local"
    assert "limits" not in body


def test_oversized_body_is_rejected(demo):
    res = demo.post("/api/solve", content=b'{"nodes":[' + b"0" * 8192 + b"]}",
                    headers={"content-type": "application/json"})
    assert res.status_code == 413
    assert "demo" in res.json()["detail"].lower()


def test_too_many_elements_is_a_validation_error(demo):
    circuit = {"nodes": [{"id": f"n{i}", "type": "load"} for i in range(9)],
               "edges": []}
    issues = demo.post("/api/validate", json=circuit).json()["issues"]
    codes = [i["code"] for i in issues]
    assert "limit-nodes" in codes
    assert any(i["severity"] == "error" for i in issues if i["code"] == "limit-nodes")


def test_over_limit_circuit_refuses_to_solve(demo):
    circuit = {"nodes": [{"id": f"n{i}", "type": "load"} for i in range(9)],
               "edges": []}
    res = demo.post("/api/solve", json=circuit).json()
    assert not res["converged"]
    assert any(i["code"] == "limit-nodes" for i in res["issues"])


def test_too_many_import_files(demo):
    files = [{"name": f"f{i}.dss", "text": "! x"} for i in range(5)]
    res = demo.post("/api/import/dss", json={"files": files})
    assert res.status_code == 413
    assert "at most 2" in res.json()["detail"]


def test_docs_are_hidden_in_demo_mode(demo):
    """The schema route is not registered at all, so the SPA fallback answers
    instead of publishing the API surface."""
    assert "SPA" in demo.get("/openapi.json").text
    assert "openapi" not in demo.get("/openapi.json").text
    assert "SPA" in demo.get("/docs").text


def test_docs_stay_available_locally(client):
    """A local install keeps the interactive API docs."""
    res = client.get("/openapi.json")
    assert res.status_code == 200
    assert res.json()["info"]["title"] == "OpenDSS Designer"


def test_security_headers_are_present(client):
    headers = client.get("/api/health").headers
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in headers["content-security-policy"]


def test_engine_does_not_move_the_process_working_directory(substation_circuit):
    """Setting DataPath chdirs the whole process unless AllowChangeDir is
    already off, so the flag order in _ensure_init matters. A moved CWD
    silently changes how every relative path in the process resolves --
    including the conductor-preset lookup."""
    import os

    from opendss_designer.core import engine

    before = os.getcwd()
    engine.solve(substation_circuit)
    assert os.getcwd() == before
    engine.fault_study(substation_circuit)
    assert os.getcwd() == before


def test_import_does_not_move_the_process_working_directory():
    import os

    before = os.getcwd()
    _import([{"name": "main.dss", "text": MAIN},
             {"name": "helper.dss", "text": "! nothing\n"}])
    assert os.getcwd() == before


# --- curated samples -------------------------------------------------------

def test_samples_are_listed(client):
    body = client.get("/api/samples").json()["samples"]
    ids = {s["id"] for s in body}
    assert {"demo-substation", "radial-feeder-der"} <= ids
    assert all(s["nodes"] > 0 for s in body)


@pytest.mark.parametrize("bad", [
    "../../../pyproject", "..", ".", "Demo Substation", "demo/substation",
    "demo-substation.oneline", "a" * 100, "", "C:/Windows/win.ini",
])
def test_sample_ids_cannot_address_the_filesystem(bad):
    """Tested at the function, not over HTTP: the client normalizes `..` out
    of a URL before it is sent, so only this level sees the hostile value."""
    from opendss_designer.core import samples
    assert samples.get_sample(bad) is None


@pytest.mark.parametrize("bad", ["nope", "demo-substation-x"])
def test_unknown_sample_is_a_404(client, bad):
    assert client.get(f"/api/samples/{bad}").status_code == 404


def test_every_sample_validates_and_solves():
    """Doubles as the demo's smoke test: if a sample stops solving, the first
    thing a visitor clicks is broken."""
    from opendss_designer.core import engine, samples
    from opendss_designer.core.model import Circuit
    from opendss_designer.core.validate import validate

    listed = samples.list_samples()
    assert listed
    for meta in listed:
        circuit = Circuit(**samples.get_sample(meta["id"]))
        errors = [i for i in validate(circuit) if i.severity == "error"]
        assert not errors, (meta["id"], [i.message for i in errors])
        result = engine.solve(circuit)
        assert result["converged"], meta["id"]


def test_samples_fit_within_the_demo_limits():
    from opendss_designer.core import samples
    from opendss_designer.core.model import Circuit
    from opendss_designer.core.validate import limit_issues
    from opendss_designer.settings import Settings

    demo_cfg = Settings.from_env({"OPENDSS_DESIGNER_MODE": "demo"})
    for meta in samples.list_samples():
        circuit = Circuit(**samples.get_sample(meta["id"]))
        assert not limit_issues(circuit, demo_cfg), meta["id"]
