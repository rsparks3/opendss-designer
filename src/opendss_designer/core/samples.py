"""Curated example circuits, served to the UI.

Shipped in the native project format rather than as `.dss` so that opening one
does not run the importer: no engine round-trip, no layout guessing, and the
hand-placed positions survive. On a public demo this is also the path that
involves no user-supplied input at all.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

SAMPLES_DIR = Path(__file__).parent.parent / "samples"

# Ids are matched against this and then looked up in a preloaded dict. A
# request value must never be turned into a filesystem path -- that is exactly
# the bug the static-file handler had.
_ID_RE = re.compile(r"[a-z0-9-]{1,64}")

_TITLES: dict[str, tuple[str, str]] = {
    "demo-substation": (
        "Demo substation",
        "115 kV source, delta-wye transformer, 12.47 kV busbar and two feeders."),
    "radial-feeder-der": (
        "Radial feeder with DER",
        "A four-bus feeder with rooftop PV, a battery and a daily load shape — "
        "the one to open for a time-series run."),
}


@lru_cache(maxsize=1)
def _load() -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not SAMPLES_DIR.is_dir():
        return out
    for path in sorted(SAMPLES_DIR.glob("*.oneline.json")):
        sample_id = path.name.removesuffix(".oneline.json")
        if not _ID_RE.fullmatch(sample_id):
            continue
        try:
            out[sample_id] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return out


def list_samples() -> list[dict]:
    items = []
    for sample_id, circuit in _load().items():
        title, description = _TITLES.get(sample_id, (sample_id, ""))
        items.append({
            "id": sample_id,
            "name": title,
            "description": description,
            "nodes": len(circuit.get("nodes", [])),
            "edges": len(circuit.get("edges", [])),
        })
    return items


def get_sample(sample_id: str) -> dict | None:
    if not _ID_RE.fullmatch(sample_id or ""):
        return None
    return _load().get(sample_id)
