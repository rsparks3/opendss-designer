"""Designer-only element data carried through a `.dss` file as a comment.

OpenDSS has no property for a load's priority or a generator's island mode,
so the export writes them on a comment line directly above the element::

    ! designer: priority=critical tags=medical,c2 building="Bldg 1200"
    New Load.hospital bus1=... kw=900 ...

and the importer reads the line back onto the element (removing it from the
element's stored comment, so a second export does not write it twice). Any
other tool reading the file sees a comment.

Only the keys in `KEYS` travel, each with its own parser, so a hand-edited
line can set nothing else.
"""
from __future__ import annotations

import re
import shlex
from collections.abc import Callable
from typing import Any

PREFIX = "! designer:"
_LINE_RE = re.compile(r"^\s*(?:!|//)\s*designer:\s*(.*)$", re.IGNORECASE)

_PRIORITIES = ("critical", "essential", "nonessential", "unassigned")
_ISLAND_MODES = ("grid", "isochronous")


def _choice(options: tuple[str, ...]) -> Callable[[str], Any]:
    def parse(v: str) -> Any:
        v = v.strip().lower()
        return v if v in options else None
    return parse


def _text(v: str) -> Any:
    v = v.strip()[:200]
    return v or None


def _tags(v: str) -> Any:
    tags = [t.strip()[:80] for t in v.split(",") if t.strip()]
    return tags[:50] or None


def _bool(v: str) -> Any:
    v = v.strip().lower()
    if v in ("yes", "true", "1"):
        return True
    if v in ("no", "false", "0"):
        return False
    return None


def _positive(v: str) -> Any:
    try:
        f = float(v)
    except ValueError:
        return None
    return f if 0 < f < 1e6 else None


# node type -> key -> parser
KEYS: dict[str, dict[str, Callable[[str], Any]]] = {
    "load": {"priority": _choice(_PRIORITIES), "tags": _tags, "building": _text, "fixed": _bool},
    "generator": {"islandMode": _choice(_ISLAND_MODES), "xdpp": _positive, "fuelHours": _positive},
}


def _fmt(value: Any) -> str | None:
    if value is None or value == "" or value == []:
        return None
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, list):
        text = ",".join(str(v).replace(",", " ") for v in value if str(v).strip())
    elif isinstance(value, float):
        text = f"{value:g}"
    else:
        text = str(value)
    text = text.replace('"', "'").replace("\n", " ")
    return f'"{text}"' if re.search(r"\s", text) or not text else text


def format_line(node_type: str, params: dict[str, Any]) -> str | None:
    """The comment line for an element, or None when it has nothing to say."""
    parts = []
    for key in KEYS.get(node_type, {}):
        if key == "priority" and params.get(key) == "unassigned":
            continue
        if key == "fixed" and params.get(key) is not True:
            continue
        text = _fmt(params.get(key))
        if text is not None:
            parts.append(f"{key}={text}")
    return f"{PREFIX} {' '.join(parts)}" if parts else None


def parse_comment(node_type: str, comment: str) -> tuple[dict[str, Any], str]:
    """The designer values in a stored comment, and the comment without
    those lines."""
    allowed = {k.lower(): (k, p) for k, p in KEYS.get(node_type, {}).items()}
    found: dict[str, Any] = {}
    kept: list[str] = []
    for line in comment.splitlines():
        m = _LINE_RE.match(line)
        if not m:
            kept.append(line)
            continue
        try:
            tokens = shlex.split(m.group(1))
        except ValueError:
            tokens = m.group(1).split()
        for tok in tokens:
            key, sep, value = tok.partition("=")
            if not sep or key.lower() not in allowed:
                continue
            name, parse = allowed[key.lower()]
            parsed = parse(value)
            if parsed is not None:
                found[name] = parsed
    return found, "\n".join(kept)


def apply_to_import(circuit: dict[str, Any]) -> int:
    """Move `! designer:` lines from an imported circuit's comments onto its
    elements. Returns how many elements gained values."""
    comments: dict[str, str] = circuit.get("comments") or {}
    if not comments:
        return 0
    touched = 0
    for node in circuit.get("nodes", []):
        ntype = node.get("type")
        if ntype not in KEYS:
            continue
        name = str((node.get("params") or {}).get("name") or "").lower()
        key = f"{ntype}.{name}"
        if not name or key not in comments:
            continue
        values, rest = parse_comment(ntype, comments[key])
        if values:
            node.setdefault("params", {}).update(values)
            touched += 1
        if rest.strip():
            comments[key] = rest
        else:
            comments.pop(key)
    return touched
