"""Equipment catalogues shipped as editable CSV: conductors (wireData.csv)
and transformers (transformers.csv), beside the line-code presets in
linecodes.csv. Re-read on every request, like the line codes, so an
operator can add their utility's standard units without a rebuild."""
from __future__ import annotations

import csv
import json
import os
from pathlib import Path
from typing import Any

from . import linecodes


def _path(name: str) -> Path | None:
    candidates = []
    env = os.environ.get("OPENDSS_DESIGNER_CONFIG")
    if env:
        candidates.append(Path(env) / name)
    candidates.append(Path.cwd() / "config" / name)
    candidates.append(Path(__file__).resolve().parents[3] / "config" / name)
    candidates.append(Path(__file__).resolve().parent.parent / "config" / name)
    for p in candidates:
        if p.is_file():
            return p
    return None


def _rows(name: str, required: tuple[str, ...]) -> tuple[list[dict[str, str]], list[str]]:
    path = _path(name)
    if path is None:
        return [], [f"{name} not found"]
    errors: list[str] = []
    rows: list[dict[str, str]] = []
    with path.open(encoding="utf-8", newline="") as fh:
        lines = [ln for ln in fh if not ln.lstrip().startswith("#")]
    reader = csv.DictReader(lines)
    missing = [c for c in required if c not in (reader.fieldnames or [])]
    if missing:
        return [], [f"{name}: missing columns {', '.join(missing)}"]
    for i, row in enumerate(reader, start=2):
        if not (row.get("code") or "").strip():
            continue
        rows.append({k: (v or "").strip() for k, v in row.items() if k})
    return rows, errors


def _num(raw: str) -> float | None:
    try:
        return float(raw) if raw not in ("", None) else None
    except ValueError:
        return None


def load_wires() -> dict[str, Any]:
    rows, errors = _rows("wiredata.csv", ("code", "label", "kind", "rac", "gmr", "radius"))
    out = []
    for r in rows:
        extra: dict[str, float] = {}
        if r.get("extra"):
            try:
                extra = {k: float(v) for k, v in json.loads(r["extra"]).items()}
            except (ValueError, AttributeError):
                errors.append(f"wiredata.csv: bad extra for {r['code']}")
        kind = r.get("kind", "wire") if r.get("kind") in ("wire", "cn", "ts") else "wire"
        out.append({
            "code": r["code"], "label": r["label"], "kind": kind,
            "spec": {"kind": kind, "rdc": _num(r.get("rdc", "")), "rac": _num(r.get("rac", "")),
                     "runits": r.get("runits") or "mi", "gmr": _num(r.get("gmr", "")),
                     "gmrunits": r.get("gmrunits") or "ft", "radius": _num(r.get("radius", "")),
                     "radunits": r.get("radunits") or "in", "normamps": _num(r.get("normamps", "")),
                     "emergamps": _num(r.get("emergamps", "")), "extra": extra,
                     "source": f"library:{r['code']}"},
        })
    return {"wires": out, "errors": errors}


def load_transformers() -> dict[str, Any]:
    rows, errors = _rows("transformers.csv", ("code", "label", "phases", "kva", "kvh", "kvl", "xhl"))
    out = []
    for r in rows:
        out.append({
            "code": r["code"], "label": r["label"],
            "phases": int(_num(r.get("phases", "3")) or 3),
            "kva": _num(r.get("kva", "")), "kvh": _num(r.get("kvh", "")), "kvl": _num(r.get("kvl", "")),
            "connh": r.get("connh") or "wye", "connl": r.get("connl") or "wye",
            "xhl": _num(r.get("xhl", "")), "pctloadloss": _num(r.get("pctloadloss", "")),
            "pctnoloadloss": _num(r.get("pctnoloadloss", "")),
            "splitphase": (r.get("splitphase") or "").lower() in ("yes", "true", "1"),
        })
    return {"transformers": out, "errors": errors}


__all__ = ["load_wires", "load_transformers", "linecodes"]
