"""The conductor preset library: config/linecodes.csv and its loader."""
from __future__ import annotations

from pathlib import Path

from opendss_designer.core import linecodes

REPO_CSV = Path(__file__).parent.parent / "config" / "linecodes.csv"


def test_shipped_csv_loads_cleanly():
    assert REPO_CSV.is_file()
    result = linecodes.load_line_codes()
    assert result["errors"] == []
    rows = result["lineCodes"]
    assert len(rows) >= 1
    codes = [r["code"] for r in rows]
    assert len(codes) == len(set(codes)), "codes must be unique"
    for r in rows:
        for k in linecodes.REQUIRED_COLUMNS:
            assert k in r
        assert r["units"] in linecodes.VALID_UNITS
        for k in ("r1", "x1", "r0", "x0", "normamps"):
            assert r[k] > 0
        # Physical sanity: zero-sequence resistance >= positive-sequence.
        assert r["r0"] >= r["r1"], f"{r['code']}: r0 < r1"


def test_bad_rows_are_skipped_with_errors(tmp_path, monkeypatch):
    (tmp_path / "linecodes.csv").write_text(
        "code,label,units,r1,x1,r0,x0,normamps\n"
        "good,Good,km,0.1,0.3,0.3,0.9,400\n"
        "good,Duplicate,km,0.1,0.3,0.3,0.9,400\n"
        "badunits,Bad,furlongs,0.1,0.3,0.3,0.9,400\n"
        "nan,Bad,km,abc,0.3,0.3,0.9,400\n"
        ",NoCode,km,0.1,0.3,0.3,0.9,400\n"
        "negative,Bad,km,-0.1,0.3,0.3,0.9,400\n",
        encoding="utf-8")
    monkeypatch.setenv("OPENDSS_DESIGNER_CONFIG", str(tmp_path))
    result = linecodes.load_line_codes()
    assert [r["code"] for r in result["lineCodes"]] == ["good"]
    assert len(result["errors"]) == 5


def test_missing_file_degrades_gracefully(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENDSS_DESIGNER_CONFIG", str(tmp_path / "nowhere"))
    monkeypatch.chdir(tmp_path)
    # Note: the repo-root fallback still resolves when running from the source
    # tree, so simulate a missing file by pointing every candidate elsewhere.
    monkeypatch.setattr(linecodes, "config_path", lambda: None)
    result = linecodes.load_line_codes()
    assert result["lineCodes"] == []
    assert result["errors"]


def test_missing_column_is_reported(tmp_path, monkeypatch):
    (tmp_path / "linecodes.csv").write_text(
        "code,label,r1\nx,X,0.1\n", encoding="utf-8")
    monkeypatch.setenv("OPENDSS_DESIGNER_CONFIG", str(tmp_path))
    result = linecodes.load_line_codes()
    assert result["lineCodes"] == []
    assert any("missing column" in e for e in result["errors"])
