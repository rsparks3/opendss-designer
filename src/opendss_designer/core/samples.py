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
    # The IEEE PES test feeders, exactly as the Import button reads EPRI's
    # files (scripts/make_ieee_samples.py regenerates them). The engine's
    # answers on these are compared with the published solutions on the
    # docs' validation page.
    "ieee-13-bus": (
        "IEEE 13-bus test feeder",
        "The small unbalanced 4.16 kV benchmark: single-phase regulators, a "
        "distributed load, matrix line codes, a delta load and a switch."),
    "ieee-34-bus": (
        "IEEE 34-bus test feeder",
        "A long rural 24.9 kV feeder with two three-phase regulator banks, "
        "single-phase laterals and an in-line transformer."),
    "ieee-37-bus": (
        "IEEE 37-bus test feeder",
        "A three-wire delta 4.8 kV underground feeder with an open-delta "
        "regulator and delta-connected loads."),
    "ieee-123-bus": (
        "IEEE 123-bus test feeder",
        "The full-size benchmark: four regulators, switches, capacitors and "
        "single-phase laterals on every phase."),
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
    """Curated ones first, in the order the titles table gives them (the
    IEEE feeders read 13, 34, 37, 123, not 123, 13, ...); anything else that
    is dropped into the folder follows, by file name."""
    loaded = _load()
    ordered = [i for i in _TITLES if i in loaded] + sorted(i for i in loaded if i not in _TITLES)
    items = []
    for sample_id in ordered:
        circuit = loaded[sample_id]
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
