"""Priority from customer class on import, where a mapping is configured
(facility plan 1.2; CYME and Synergi reach the importer as .dss)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from opendss_designer import server
from opendss_designer.core import importer, priority_map

DSS = """
new circuit.c basekv=12.47 bus1=src
new line.l1 bus1=src bus2=b1 length=1
new load.hospital bus1=b1 kv=12.47 kw=500 class=3
! designer: priority=essential
new load.clinic bus1=b1 kv=12.47 kw=100 class=3
new load.house bus1=b1 kv=12.47 kw=50 class=7
new load.shop bus1=b1 kv=12.47 kw=50
"""


def loads(result: dict) -> dict[str, dict]:
    return {n["params"]["name"]: n["params"] for n in result["circuit"]["nodes"] if n["type"] == "load"}


def test_no_mapping_assumes_nothing(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENDSS_DESIGNER_CONFIG", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    got = loads(importer.import_dss(DSS))
    assert got["hospital"]["class"] == "3" and "class" not in got["shop"]
    assert "priority" not in got["hospital"]


def test_configured_mapping_sets_priority_but_keeps_a_stated_one(monkeypatch, tmp_path):
    (tmp_path / "priority_by_class.csv").write_text(
        "# comment\nclass,priority\n3,critical\n7,Non-essential\n9,bogus\n")
    monkeypatch.setenv("OPENDSS_DESIGNER_CONFIG", str(tmp_path))
    assert priority_map.load_mapping() == {"3": "critical", "7": "nonessential"}
    got = loads(importer.import_dss(DSS))
    assert got["hospital"]["priority"] == "critical"
    assert got["clinic"]["priority"] == "essential"  # the file said so
    assert got["house"]["priority"] == "nonessential"
    assert "priority" not in got["shop"]


def test_request_mapping_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENDSS_DESIGNER_CONFIG", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    client = TestClient(server.app, base_url="http://127.0.0.1")
    r = client.post("/api/import/dss", json={"text": DSS, "priorityByClass": {"7": "critical"}}).json()
    got = loads(r)
    assert got["house"]["priority"] == "critical" and "priority" not in got["hospital"]


def test_shipped_mapping_is_empty():
    from pathlib import Path
    shipped = Path(priority_map.__file__).resolve().parent.parent / "config" / priority_map.FILE
    assert shipped.is_file()
    rows = [ln for ln in shipped.read_text().splitlines() if ln and not ln.startswith("#")]
    assert rows == ["class,priority"]
