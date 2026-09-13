"""Which phases an element actually connects to.

OpenDSS writes a connection as `bus.node.node` — `.2` is phase B, `.1.2` is
A and B, `.0` is neutral or ground. The numbers are positional and easy to get
wrong by hand, so the editor stores the engineer's own word for it: a `phasing`
param holding letters, "A", "BC", "ABC". This module is the only place the two
spellings meet.

Anything the letters cannot say — a neutral node, a centre tap, the fourth
node of a 4-wire delta — stays in the raw `busNodes`/`nodes1`/`nodes2` params
the importer already preserved. Those are rare, and the phase picker in the UI
declines to touch them rather than quietly dropping a node.
"""
from __future__ import annotations

import re

PHASE_LETTERS = "ABC"
LETTER_TO_NODE = {"A": 1, "B": 2, "C": 3}
NODE_TO_LETTER = {1: "A", 2: "B", 3: "C"}

_SUFFIX_RE = re.compile(r"^(\.\d+)+$")


def parse_phasing(raw: object) -> str | None:
    """Normalise a user-supplied phasing to unique upper-case letters, in ABC
    order. Anything unrecognisable returns None, which means "use the default
    for the phase count" — the behaviour every circuit had before pinning."""
    if not isinstance(raw, str):
        return None
    # Separators are courtesy ("A-B", "a, c"); every remaining character has
    # to be a phase. Picking the letters out of arbitrary text instead would
    # turn a typo into a confident, wrong pin.
    seen = [c for c in raw.upper() if c not in " -,._/+"]
    if not seen or len(set(seen)) != len(seen):
        return None
    if any(c not in PHASE_LETTERS for c in seen):
        return None
    # Sorted so ".2.1" and "BA" cannot produce two spellings of one connection;
    # OpenDSS cares about node order only for phase rotation, which the editor
    # does not model.
    return "".join(sorted(set(seen), key=PHASE_LETTERS.index))


def nodes_for(phasing: str | None) -> str:
    """Letters to the node suffix OpenDSS wants: "B" -> ".2"."""
    parsed = parse_phasing(phasing)
    if not parsed:
        return ""
    return "".join(f".{LETTER_TO_NODE[c]}" for c in parsed)


def phasing_from_suffix(suffix: object) -> str | None:
    """The inverse, for import: ".1.2" -> "AB". Returns None when the suffix
    says something the letters cannot — a neutral, a repeat, a node past 3 —
    so the caller keeps the raw text instead."""
    if not isinstance(suffix, str) or not _SUFFIX_RE.match(suffix):
        return None
    nodes = [int(part) for part in suffix.split(".") if part]
    if not nodes or len(set(nodes)) != len(nodes):
        return None
    if any(n not in NODE_TO_LETTER for n in nodes):
        return None
    return "".join(sorted((NODE_TO_LETTER[n] for n in nodes), key=PHASE_LETTERS.index))


def phase_count(params: dict, default: int = 3) -> int:
    """The element's declared phase count, clamped to 1-3.

    The clamp is not cosmetic: a huge value builds a pathological command, so
    this is the one place it is enforced for both the compiler and the
    validator.
    """
    raw = params.get("phases", default)
    try:
        n = int(float(raw))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return min(max(n, 1), 3)


def default_phasing(phases: int) -> str:
    """What OpenDSS assumes when no suffix is given: the first N phases."""
    return PHASE_LETTERS[: max(1, min(3, int(phases)))]


def phase_set(phasing: str | None, phases: int) -> frozenset[str]:
    """The phases an element occupies, pinned or defaulted."""
    return frozenset(parse_phasing(phasing) or default_phasing(phases))
