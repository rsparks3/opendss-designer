"""Packaging invariants that are easy to get wrong at release time."""
from __future__ import annotations

import json
import re
from pathlib import Path

from opendss_designer import __version__

ROOT = Path(__file__).resolve().parents[1]


def test_version_is_declared_once_per_place_and_agrees():
    """The version lives in three files; releases have to move all three."""
    pyproject = re.search(r'^version = "([^"]+)"',
                          (ROOT / "pyproject.toml").read_text(encoding="utf-8"),
                          re.MULTILINE)
    assert pyproject, "no version in pyproject.toml"
    package_json = json.loads(
        (ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    assert pyproject.group(1) == __version__
    assert package_json["version"] == __version__


def test_linecodes_csv_ships_inside_the_package():
    """It used to live at the repo root, so `pip install opendss-designer`
    got no conductor presets at all."""
    assert (ROOT / "src" / "opendss_designer" / "config" / "linecodes.csv").is_file()


def test_linecodes_resolve_without_a_repo_checkout(tmp_path, monkeypatch):
    """Resolution must not depend on the current working directory."""
    from opendss_designer.core import linecodes

    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("OPENDSS_DESIGNER_CONFIG", raising=False)
    data = linecodes.load_line_codes()
    assert data["lineCodes"], data.get("errors")
