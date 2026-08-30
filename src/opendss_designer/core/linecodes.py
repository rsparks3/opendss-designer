"""Line conductor preset library, loaded from config/linecodes.csv.

The CSV is user-editable data, not code: it is re-read on every request so
edits show up on the next browser refresh. Search order for the file:

1. ``$OPENDSS_DESIGNER_CONFIG/linecodes.csv`` (explicit override)
2. ``./config/linecodes.csv`` relative to the server's working directory
3. ``<repo root>/config/linecodes.csv`` (the source checkout, for dev)

Missing file or unparseable rows degrade gracefully: valid rows still load,
problems are reported in the ``errors`` list for the UI/console.
"""
from __future__ import annotations

import csv
import os
from pathlib import Path
from typing import Any

REQUIRED_COLUMNS = ("code", "label", "units", "r1", "x1", "r0", "x0", "normamps")
_NUMERIC = ("r1", "x1", "r0", "x0", "normamps")
VALID_UNITS = {"km", "m", "mi", "kft", "ft"}


def config_path() -> Path | None:
    candidates = []
    env = os.environ.get("OPENDSS_DESIGNER_CONFIG")
    if env:
        candidates.append(Path(env) / "linecodes.csv")
    candidates.append(Path.cwd() / "config" / "linecodes.csv")
    # src/opendss_designer/core/linecodes.py -> repo root is parents[3]
    candidates.append(Path(__file__).resolve().parents[3] / "config" / "linecodes.csv")
    for p in candidates:
        if p.is_file():
            return p
    return None


def load_line_codes() -> dict[str, Any]:
    path = config_path()
    if path is None:
        return {"lineCodes": [], "path": None,
                "errors": ["config/linecodes.csv not found — no conductor presets loaded."]}

    errors: list[str] = []
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    text = path.read_text(encoding="utf-8-sig")
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    reader = csv.DictReader(lines)
    missing_cols = [c for c in REQUIRED_COLUMNS if c not in (reader.fieldnames or [])]
    if missing_cols:
        return {"lineCodes": [], "path": str(path),
                "errors": [f"linecodes.csv is missing column(s): {', '.join(missing_cols)}"]}

    for i, raw in enumerate(reader, start=2):  # 2 = first data line of the CSV body
        code = (raw.get("code") or "").strip()
        label = (raw.get("label") or "").strip() or code
        units = (raw.get("units") or "km").strip().lower()
        if not code:
            errors.append(f"row {i}: empty code — skipped")
            continue
        if code in seen:
            errors.append(f"row {i}: duplicate code '{code}' — skipped")
            continue
        if units not in VALID_UNITS:
            errors.append(f"row {i} ('{code}'): unknown units '{units}' — skipped")
            continue
        try:
            numbers = {k: float(raw[k]) for k in _NUMERIC}
        except (TypeError, ValueError):
            errors.append(f"row {i} ('{code}'): non-numeric impedance/ampacity — skipped")
            continue
        if any(v <= 0 for v in numbers.values()):
            errors.append(f"row {i} ('{code}'): impedances and normamps must be > 0 — skipped")
            continue
        seen.add(code)
        rows.append({"code": code, "label": label, "units": units, **numbers})

    return {"lineCodes": rows, "path": str(path), "errors": errors}
