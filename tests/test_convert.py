"""CYME/Synergi import through the optional converter plugin (core/convert.py).

The plugin is a separate package with a heavy dependency tree, so these
tests stand in a stub that honours its contract. The conversion runs in a
child interpreter, so the stub is a real (tiny) package on disk that both the
app and the child find through PYTHONPATH. One test runs the real converter
on its own CYME sample when it is installed."""
from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import textwrap
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import convert
from opendss_designer.server import create_app
from opendss_designer.settings import reload_settings

FEEDER = """
New Circuit.stub basekv=12.47 pu=1.0 bus1=src
New Line.l1 bus1=src bus2=b1 length=1 units=km
New Load.ld1 bus1=b1 kv=12.47 kw=100 pf=0.95
"""

HEADER = "x-opendss-limits"

STUB = '''
"""Stand-in for opendss_designer_convert, honouring the plugin contract."""
import json, time
from dataclasses import dataclass
from pathlib import Path

__version__ = "0.0-test"
SEEN = Path(__file__).with_name("seen.json")

@dataclass(frozen=True)
class Format:
    key: str
    label: str
    extensions: tuple
    help: str
    max_files: int

@dataclass
class Conversion:
    files: list
    main: str
    warnings: list

class ConversionError(Exception):
    pass

FORMATS = {"cyme": Format("cyme", "CYME", (".txt",), "Network, equipment and load.", 3)}

def convert(fmt, files):
    SEEN.write_text(json.dumps([[n, list(d)] for n, d in files]), encoding="utf-8")
    if files and files[0][1] == b"garbled":
        raise ConversionError("No network section in network.txt.")
    if files and files[0][1] == b"slow":
        time.sleep(30)
    if files and files[0][1] == b"crash":
        raise RuntimeError("secret path C:/x/y")
    return Conversion(files=[("master.dss", FEEDER)], main="master.dss",
                      warnings=["2 capacitor controls were dropped"])
'''


@pytest.fixture()
def stub_plugin(tmp_path, monkeypatch):
    """A stub plugin package on disk, importable here and in the child."""
    pkg = tmp_path / "plugin" / convert.PLUGIN
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text(
        textwrap.dedent(STUB).replace("FEEDER", repr(FEEDER)), encoding="utf-8")
    root = str(tmp_path / "plugin")
    monkeypatch.setenv("PYTHONPATH", os.pathsep.join(
        p for p in (root, os.environ.get("PYTHONPATH")) if p))
    monkeypatch.syspath_prepend(root)
    sys.modules.pop(convert.PLUGIN, None)
    importlib.invalidate_caches()
    yield pkg / "seen.json"
    sys.modules.pop(convert.PLUGIN, None)


@pytest.fixture()
def no_plugin(monkeypatch):
    real = convert.importlib.import_module

    def _import(name, *a, **k):
        if name == convert.PLUGIN:
            raise ImportError(name)
        return real(name, *a, **k)

    monkeypatch.delitem(sys.modules, convert.PLUGIN, raising=False)
    monkeypatch.setattr(convert.importlib, "import_module", _import)


@pytest.fixture()
def gated(tmp_path, monkeypatch):
    """A demo-mode worker that trusts the limits header, like one behind
    the hosted gateway."""
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("SPA", encoding="utf-8")
    monkeypatch.setattr(server, "STATIC_DIR", static)
    cfg = reload_settings({"OPENDSS_DESIGNER_MODE": "demo",
                           "OPENDSS_DESIGNER_TRUSTED_LIMITS_HEADER": HEADER})
    try:
        yield TestClient(server.create_app(cfg), base_url="http://127.0.0.1")
    finally:
        reload_settings({})


def _post(client, fmt, files, **headers):
    return client.post("/api/import/convert", json={
        "format": fmt,
        "files": [{"name": n, "data": base64.b64encode(d).decode()} for n, d in files]},
        headers=headers)


def _withheld(value) -> dict:
    return {HEADER: json.dumps({"plan": {"name": "Free"}, "features": {"convert": value}})}


def test_without_the_plugin_the_menu_says_how_to_get_it(no_plugin):
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    body = client.get("/api/convert/formats").json()
    assert body == {"available": False, "install": convert.INSTALL_HINT, "formats": []}
    r = _post(client, "cyme", [("network.txt", b"x")])
    assert r.status_code == 400 and "pip install opendss-designer-convert" in r.json()["detail"]


def test_formats_come_from_the_plugin(stub_plugin):
    body = TestClient(create_app(), base_url="http://127.0.0.1").get("/api/convert/formats").json()
    assert body["available"] and body["version"] == "0.0-test"
    assert "locked" not in body, "a local install withholds nothing"
    assert body["formats"] == [{"key": "cyme", "label": "CYME", "help": "Network, equipment and load.",
                                "extensions": [".txt"], "maxFiles": 3}]


def test_a_converted_model_goes_through_the_importer(stub_plugin):
    r = _post(TestClient(create_app(), base_url="http://127.0.0.1"), "cyme",
              [("network.txt", b"[NETWORK]\x00binary-safe")])
    assert r.status_code == 200, r.text
    body = r.json()
    # The plugin, in its own process, got the bytes exactly as sent.
    assert json.loads(stub_plugin.read_text()) == [["network.txt", list(b"[NETWORK]\x00binary-safe")]]
    types_ = {n["type"] for n in body["circuit"]["nodes"]}
    assert {"vsource", "load", "busbar"} <= types_
    assert body["warnings"][0] == "CYME: 2 capacitor controls were dropped"
    assert body["converted"] == {"format": "cyme", "files": ["master.dss"]}
    # Conversion time is worker time: reported like engine time, for metering.
    assert float(r.headers["x-engine-seconds"]) > 0


def test_converter_errors_and_bad_input_are_400s(stub_plugin):
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    r = _post(client, "cyme", [("network.txt", b"garbled")])
    assert r.status_code == 400 and r.json()["detail"] == "No network section in network.txt."
    r = _post(client, "synergi", [("m.mdb", b"x")])
    assert r.status_code == 400 and "does not read 'synergi'" in r.json()["detail"]
    r = client.post("/api/import/convert",
                    json={"format": "cyme", "files": [{"name": "n.txt", "data": "%%%"}]})
    assert r.status_code == 400 and "did not arrive intact" in r.json()["detail"]


def test_a_crash_inside_the_plugin_is_a_400_without_its_details(stub_plugin):
    r = _post(TestClient(create_app(), base_url="http://127.0.0.1"), "cyme",
              [("network.txt", b"crash")])
    assert r.status_code == 400
    assert r.json()["detail"] == "The converter could not read those files."


def test_a_conversion_that_hangs_is_stopped(stub_plugin, monkeypatch):
    reload_settings({"OPENDSS_DESIGNER_MODE": "demo", "OPENDSS_DESIGNER_CONVERT_TIMEOUT_S": "2"})
    try:
        r = _post(TestClient(create_app(), base_url="http://127.0.0.1"), "cyme",
                  [("network.txt", b"slow")])
    finally:
        reload_settings({})
    assert r.status_code == 400 and "longer than 2 s" in r.json()["detail"]


def test_a_proxy_may_withhold_the_feature(stub_plugin, gated):
    # Listed, so the menu can still show what the feature is, but locked.
    body = gated.get("/api/convert/formats", headers=_withheld(False)).json()
    assert body["available"] and body["locked"] is True
    assert body["reason"] == "CYME and Synergi import is not included in the Free plan."
    assert [f["key"] for f in body["formats"]] == ["cyme"]
    r = _post(gated, "cyme", [("network.txt", b"x")], **_withheld(False))
    assert r.status_code == 403 and r.json()["detail"] == body["reason"]
    assert not stub_plugin.exists(), "refused before the plugin ran"
    # The proxy's own wording wins when it gives any.
    body = gated.get("/api/convert/formats", headers=_withheld("Part of the Pro plan.")).json()
    assert body["locked"] and body["reason"] == "Part of the Pro plan."
    # `true` and absent mean no opinion: the install's feature stays available.
    for headers in (_withheld(True), {}):
        body = gated.get("/api/convert/formats", headers=headers).json()
        assert "locked" not in body
    r = _post(gated, "cyme", [("network.txt", b"x")], **_withheld(True))
    assert r.status_code == 200


def test_the_real_converter_on_its_own_cyme_sample():
    plugin = pytest.importorskip(convert.PLUGIN)
    repo = Path(plugin.__file__).resolve().parents[2]
    folder = next((p for p in (repo / "tests" / "data").rglob("*") if p.is_dir()
                   and any(f.name.lower().startswith("network") for f in p.iterdir())), None)
    if folder is None:
        pytest.skip("no CYME sample beside the installed converter")
    files = [(f.name, f.read_bytes()) for f in sorted(folder.iterdir()) if f.is_file()]
    result = convert.convert_and_import("cyme", files)
    assert any(n["type"] == "vsource" for n in result["circuit"]["nodes"])
    assert not result["unsupported"]
