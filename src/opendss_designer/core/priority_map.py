"""Load priority from customer class, on import (facility plan 1.2).

Models from CYME, Synergi (through the convert plugin) or another tool carry
a customer or load class, not an ERRE priority. Where a mapping is
configured, an imported load whose class it names gets that priority;
a load that already has one (from a `! designer:` line) keeps it.

The mapping is `priority_by_class.csv` (columns `class,priority`), found as
the conductor library is: ``$OPENDSS_DESIGNER_CONFIG``, ``./config``, the
source checkout's ``config``, then the copy shipped in the package, which is
empty -- no mapping is assumed. An import request may also carry its own
mapping, which wins.
"""
from __future__ import annotations

import csv
import os
from pathlib import Path
from typing import Any

FILE = "priority_by_class.csv"
PRIORITIES = ("critical", "essential", "nonessential", "unassigned")


def config_path() -> Path | None:
    candidates = []
    env = os.environ.get("OPENDSS_DESIGNER_CONFIG")
    if env:
        candidates.append(Path(env) / FILE)
    candidates.append(Path.cwd() / "config" / FILE)
    candidates.append(Path(__file__).resolve().parents[3] / "config" / FILE)
    candidates.append(Path(__file__).resolve().parent.parent / "config" / FILE)
    return next((p for p in candidates if p.is_file()), None)


def _clean(mapping: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for cls, pr in mapping.items():
        key = str(cls).strip().lower()
        val = str(pr).strip().lower().replace("-", "").replace(" ", "")
        if key and val in PRIORITIES:
            out[key] = val
    return out


def load_mapping() -> dict[str, str]:
    """class (lowercase) -> priority, from the configured CSV; {} if none."""
    path = config_path()
    if path is None:
        return {}
    rows: dict[str, str] = {}
    try:
        with path.open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(line for line in fh if not line.lstrip().startswith("#")):
                if row.get("class") is not None and row.get("priority") is not None:
                    rows[row["class"]] = row["priority"]
    except (OSError, csv.Error):
        return {}
    return _clean(rows)


def apply(circuit: dict[str, Any], mapping: dict[str, Any] | None = None) -> int:
    """Set `priority` on the imported circuit's loads from their `class`.
    Returns how many loads gained one."""
    table = _clean(mapping) if mapping else load_mapping()
    if not table:
        return 0
    n = 0
    for node in circuit.get("nodes", []):
        if node.get("type") != "load":
            continue
        params = node.setdefault("params", {})
        if params.get("priority") not in (None, "", "unassigned"):
            continue
        pr = table.get(str(params.get("class") or "").strip().lower())
        if pr:
            params["priority"] = pr
            n += 1
    return n
