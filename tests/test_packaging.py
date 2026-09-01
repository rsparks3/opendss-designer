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
