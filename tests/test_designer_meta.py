"""Priority, tags, building and island data survive a .dss round trip as
`! designer:` comments (core/designer_meta.py)."""
from __future__ import annotations

import json
from pathlib import Path

from opendss_designer.core import designer_meta, importer
from opendss_designer.core.compiler import export_dss
from opendss_designer.core.connectivity import sanitize_name
from opendss_designer.core.model import Circuit

SAMPLES = Path(__file__).parent.parent / "src" / "opendss_designer" / "samples"


def campus() -> Circuit:
    return Circuit.model_validate(
        json.loads((SAMPLES / "installation-campus.oneline.json").read_text()))


def test_round_trip_through_dss():
    c = campus()
    text, _ = export_dss(c)
    assert '! designer: priority=critical tags=medical building="Bldg 1200"' in text
    back = importer.import_dss(text)["circuit"]
    by_name = {sanitize_name(n["params"].get("name", "")): n for n in back["nodes"]}
    for n in c.nodes:
        if n.type not in ("load", "generator"):
            continue
        got = by_name[sanitize_name(n.params["name"])]["params"]
        for key in designer_meta.KEYS[n.type]:
            if key in n.params and n.params[key] not in (None, "", []):
                assert got.get(key) == n.params[key], (n.params["name"], key)
    # The lines are moved onto the elements, not kept as comments too...
    assert not any("designer:" in v for v in back.get("comments", {}).values())
    # ...so a second export writes each once.
    again, _ = export_dss(Circuit.model_validate(back))
    assert again.count("! designer:") == text.count("! designer:")


def test_other_comments_stay_and_bad_values_are_ignored():
    values, rest = designer_meta.parse_comment(
        "load", "! fed from the east bank\n! designer: priority=urgent tags=a,b kw=9e9 fixed=yes")
    assert values == {"tags": ["a", "b"], "fixed": True}
    assert rest == "! fed from the east bank"


def test_nothing_to_say_writes_nothing():
    assert designer_meta.format_line("load", {"priority": "unassigned", "kw": 5}) is None
    assert designer_meta.format_line("capacitor", {"priority": "critical"}) is None
    assert designer_meta.format_line("load", {"fixed": True}) == "! designer: fixed=yes"
