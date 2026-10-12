"""CYME/Synergi import through the optional converter plugin (core/convert.py).

The plugin is a separate package with a heavy dependency tree, so these
tests stand in a stub that honours its contract. One test runs the real
converter on its own CYME sample when it is installed."""
from __future__ import annotations

import base64
import sys
import types
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from opendss_designer.core import convert
from opendss_designer.server import create_app

FEEDER = """
New Circuit.stub basekv=12.47 pu=1.0 bus1=src
New Line.l1 bus1=src bus2=b1 length=1 units=km
New Load.ld1 bus1=b1 kv=12.47 kw=100 pf=0.95
"""


@dataclass(frozen=True)
class _Format:
    key: str
    label: str
    extensions: tuple[str, ...]
    help: str
    max_files: int


@dataclass
class _Conversion:
    files: list[tuple[str, str]]
    main: str
    warnings: list[str]


class _ConversionError(Exception):
    pass


@pytest.fixture()
def stub_plugin(monkeypatch):
    mod = types.ModuleType(convert.PLUGIN)
    mod.__version__ = "0.0-test"
    mod.FORMATS = {"cyme": _Format("cyme", "CYME", (".txt",), "Network, equipment and load.", 3)}
    mod.ConversionError = _ConversionError
    seen: dict = {}

    def _convert(fmt, files):
        seen["files"] = files
        if files and files[0][1] == b"garbled":
            raise _ConversionError("No network section in network.txt.")
        return _Conversion(files=[("master.dss", FEEDER)], main="master.dss",
                           warnings=["2 capacitor controls were dropped"])

    mod.convert = _convert
    monkeypatch.setitem(sys.modules, convert.PLUGIN, mod)
    return seen


@pytest.fixture()
def no_plugin(monkeypatch):
    real = convert.importlib.import_module

    def _import(name, *a, **k):
        if name == convert.PLUGIN:
            raise ImportError(name)
        return real(name, *a, **k)

    monkeypatch.delitem(sys.modules, convert.PLUGIN, raising=False)
    monkeypatch.setattr(convert.importlib, "import_module", _import)


def _post(client, fmt, files):
    return client.post("/api/import/convert", json={
        "format": fmt,
        "files": [{"name": n, "data": base64.b64encode(d).decode()} for n, d in files]})


def test_without_the_plugin_the_menu_says_how_to_get_it(no_plugin):
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    body = client.get("/api/convert/formats").json()
    assert body == {"available": False, "install": convert.INSTALL_HINT, "formats": []}
    r = _post(client, "cyme", [("network.txt", b"x")])
    assert r.status_code == 400 and "pip install opendss-designer-convert" in r.json()["detail"]


def test_formats_come_from_the_plugin(stub_plugin):
    body = TestClient(create_app(), base_url="http://127.0.0.1").get("/api/convert/formats").json()
    assert body["available"] and body["version"] == "0.0-test"
    assert body["formats"] == [{"key": "cyme", "label": "CYME", "help": "Network, equipment and load.",
                                "extensions": [".txt"], "maxFiles": 3}]


def test_a_converted_model_goes_through_the_importer(stub_plugin):
    r = _post(TestClient(create_app(), base_url="http://127.0.0.1"), "cyme", [("network.txt", b"[NETWORK]\x00binary-safe")])
    assert r.status_code == 200, r.text
    body = r.json()
    # The plugin got the bytes exactly as sent.
    assert stub_plugin["files"] == [("network.txt", b"[NETWORK]\x00binary-safe")]
    types_ = {n["type"] for n in body["circuit"]["nodes"]}
    assert {"vsource", "load", "busbar"} <= types_
    assert body["warnings"][0] == "CYME: 2 capacitor controls were dropped"
    assert body["converted"] == {"format": "cyme", "files": ["master.dss"]}


def test_converter_errors_and_bad_input_are_400s(stub_plugin):
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    r = _post(client, "cyme", [("network.txt", b"garbled")])
    assert r.status_code == 400 and r.json()["detail"] == "No network section in network.txt."
    r = _post(client, "synergi", [("m.mdb", b"x")])
    assert r.status_code == 400 and "does not read 'synergi'" in r.json()["detail"]
    r = client.post("/api/import/convert",
                    json={"format": "cyme", "files": [{"name": "n.txt", "data": "%%%"}]})
    assert r.status_code == 400 and "did not arrive intact" in r.json()["detail"]


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
