"""What an imported .dss file says that the diagram cannot show.

A real feeder file carries more than the one-line draws: monitors and energy
meters, capacitor and inverter controls, XY curves, reactors, and the
engineer's own comments. Dropping them on import made a round trip lossy, so
they are kept instead:

* **Passthrough elements** -- the `New ...` statement of every element the
  editor does not model, verbatim (continuation lines joined, later `Edit`s
  of it appended), in the order the file defined them. They go back out on
  export, and into every solve when they are safe to run and still refer to
  things that exist.
* **Comments** -- the comment lines directly above an element's `New`, and
  any comment on the same line, keyed by the element's lowercase
  `class.name` and written back above it on export. The block above
  `New Circuit` is the file's header.

The text comes from the uploaded files after `importer._sanitize_dss_text`
has made them safe, and every entry is checked again (`check`) before a
solve sends it to the engine: an entry is only ever `New`/`Edit` lines
naming itself, of a class on the list below, reading no files.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePath

from .model import Issue, PassthroughSpec

# Classes a solve may run. Measurement and control objects, curves and
# shapes, and a few simple circuit elements: none reads or writes files or
# repoints the engine. Anything else is kept and exported but never solved.
SOLVABLE_CLASSES = frozenset({
    "monitor", "energymeter", "sensor",
    "capcontrol", "invcontrol", "expcontrol", "storagecontroller",
    "swtcontrol", "gendispatcher", "upfccontrol",
    "xycurve", "tshape", "spectrum", "growthshape", "priceshape",
    "reactor", "fault", "isource", "upfc", "vccs", "indmach012",
    # A transformer the editor cannot draw (four windings, say) is still a
    # transformer; the solve should see it.
    "transformer",
})

# General objects (not circuit elements) the editor has no model of. Kept
# whether or not anything refers to them; an InvControl needs its XYCurve.
GENERAL_CLASSES = frozenset({"xycurve", "tshape", "spectrum", "growthshape", "priceshape"})

# Controls and meters sit out a fault study, like the modelled ones do
# (engine.quiet_for_fault_study): nothing that operates belongs in it.
FAULT_STUDY_MUTES = frozenset({
    "monitor", "energymeter", "sensor", "capcontrol", "invcontrol", "expcontrol",
    "storagecontroller", "swtcontrol", "gendispatcher", "upfccontrol",
})

# Properties whose value names another element ("line.650632").
_ELEMENT_KEYS = frozenset({"element", "monitoredobj", "switchedobj", "capacitor", "transformer"})
# Properties whose value is a bus. Only the first terminal is checked: a
# second one may be a bus the element itself creates (a grounding reactor).
_BUS_KEYS = ("bus1", "bus")
# Anything that reads a file cannot run here, where the file is not.
_FILE_KEY_RE = re.compile(r"\b(?:file|csvfile|sngfile|dblfile|dll)\s*=", re.IGNORECASE)

_TARGET = r'\s+(?:object\s*=\s*)?"?([A-Za-z_][\w]*)\.([^\s"=]+)"?'
_NEW_RE = re.compile(r"^\s*new" + _TARGET, re.IGNORECASE)
_EDIT_RE = re.compile(r"^\s*edit" + _TARGET, re.IGNORECASE)
_CONT_RE = re.compile(r"^\s*(?:~|more\b|m\b)\s*", re.IGNORECASE)
_REDIRECT_RE = re.compile(r'^\s*(?:redirect|compile)\s+["(\[]?([^"()\[\]\s]+)', re.IGNORECASE)
_PROP_RE = re.compile(
    r'([A-Za-z_%][\w%\-]*)\s*=\s*("[^"]*"|\'[^\']*\'|\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|[^\s]+)')


def _is_comment(line: str) -> bool:
    t = line.lstrip()
    return t.startswith("!") or t.startswith("//")


def _split_inline(line: str) -> tuple[str, str]:
    """A statement and its trailing `!` comment, respecting quotes."""
    quote = ""
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
        elif ch == "!" or line.startswith("//", i):
            return line[:i].rstrip(), line[i:].strip()
    return line.rstrip(), ""


@dataclass
class _Stmt:
    text: str
    comments: list[str] = field(default_factory=list)


def _statements(files: dict[str, str], main: str) -> tuple[list[_Stmt], list[str]]:
    """Every statement in compile order, following redirects, with the
    comment block that sat directly above it; and the main file's opening
    comments, blank lines or not, which are its header."""
    out: list[_Stmt] = []
    seen: set[str] = set()
    header: list[str] = []

    def walk(name: str) -> None:
        key = name.lower()
        if key in seen or key not in files:
            return
        seen.add(key)
        pending: list[str] = []
        for raw in files[key].splitlines():
            if not raw.strip():
                pending = []  # a blank line ends a comment block
                continue
            if _is_comment(raw):
                pending.append(raw.strip())
                if key == main.lower() and not out:
                    header.append(raw.strip())
                continue
            body, inline = _split_inline(raw)
            if not body.strip():
                continue
            cont = _CONT_RE.match(body)
            if cont and out:
                out[-1].text += " " + body[cont.end():].strip()
                if inline:
                    out[-1].comments.append(inline)
                continue
            ref = _REDIRECT_RE.match(body)
            if ref:
                walk(PurePath(ref.group(1).replace("\\", "/")).name)
                pending = []
                continue
            out.append(_Stmt(body.strip(), pending + ([inline] if inline else [])))
            pending = []

    walk(main)
    return out, header


def collect(files: list[dict[str, str]], main: str,
            unsupported: set[str]) -> tuple[list[PassthroughSpec], dict[str, str]]:
    """The passthrough entries and comments of a set of (sanitized) files.

    `unsupported` is the lowercase `class.name` of every circuit element the
    importer could not model; general objects of the classes in
    GENERAL_CLASSES are kept too."""
    texts = {f["name"].lower(): f["text"] for f in files}
    entries: dict[str, list[str]] = {}
    order: list[str] = []
    names: dict[str, str] = {}
    comments: dict[str, str] = {}
    stmts, header = _statements(texts, main)
    if header:
        comments["circuit"] = "\n".join(header)
    for st in stmts:
        new = _NEW_RE.match(st.text)
        edit = _EDIT_RE.match(st.text) if not new else None
        m = new or edit
        if not m:
            continue
        cls, name = m.group(1).lower(), m.group(2)
        key = f"{cls}.{name.lower()}"
        if new and st.comments and cls != "circuit":
            comments[key] = "\n".join(st.comments)
        keep = key in unsupported or cls in GENERAL_CLASSES
        if not keep:
            continue
        if new:
            if key not in entries:
                order.append(key)
                names[key] = f"{m.group(1)}.{name}"
            entries[key] = [st.text]
        elif key in entries:
            entries[key].append(st.text)
    kept = [PassthroughSpec(name=names[k], text="\n".join(entries[k])) for k in order]
    return kept, comments


# --- checking an entry before it runs -----------------------------------------

@dataclass
class Checked:
    entry: PassthroughSpec
    cls: str
    solvable: bool
    #  Why it is left out of solves (None when it runs).
    reason: str | None = None
    # Why it is written commented out on export (a reference that is gone).
    stale: str | None = None


def _lines(entry: PassthroughSpec) -> list[str]:
    return [ln.strip() for ln in entry.text.splitlines() if ln.strip()]


def check(entries: list[PassthroughSpec], element_names: set[str],
          bus_names: set[str]) -> tuple[list[Checked], list[Issue]]:
    """Decide which entries a solve may run. `element_names` and `bus_names`
    are lowercase: every `class.name` the compiled circuit defines and every
    bus it has. Problems are warnings -- a passthrough element never stops
    the circuit from solving, it is only left out."""
    own = set()
    for e in entries:
        first = _lines(e)[:1]
        m = _NEW_RE.match(first[0]) if first else None
        if m:
            own.add(f"{m.group(1).lower()}.{m.group(2).lower()}")
    known = element_names | own

    out: list[Checked] = []
    issues: list[Issue] = []

    def warn(entry: PassthroughSpec, msg: str) -> None:
        issues.append(Issue(severity="warning", code="passthrough", message=f"{entry.name}: {msg}"))

    for e in entries:
        lines = _lines(e)
        m = _NEW_RE.match(lines[0]) if lines else None
        if not m:
            c = Checked(e, "", False, "it does not start with a New statement")
            warn(e, "left out of the solve — it does not start with 'New class.name'.")
            out.append(c)
            continue
        cls, name = m.group(1).lower(), m.group(2).lower()
        me = f"{cls}.{name}"
        c = Checked(e, cls, True)
        for ln in lines[1:]:
            em = _EDIT_RE.match(ln)
            if not em or f"{em.group(1).lower()}.{em.group(2).lower()}" != me:
                c.solvable, c.reason = False, "a line other than an Edit of itself"
        if c.solvable and cls not in SOLVABLE_CLASSES:
            c.solvable, c.reason = False, f"{m.group(1)} is kept for export only"
        if c.solvable and _FILE_KEY_RE.search(e.text):
            c.solvable, c.reason = False, "it reads a file, which a solve here does not have"
        if c.solvable:
            props = {k.lower(): v.strip("\"'") for k, v in _PROP_RE.findall(e.text)}
            for k in _ELEMENT_KEYS:
                ref = props.get(k, "").lower()
                if "." in ref and ref not in known:
                    c.stale = f"it refers to {props[k]}, which is not in the circuit"
                    break
            if not c.stale:
                buses = [props[k] for k in _BUS_KEYS if k in props]
                if buses and all(b.split(".")[0].lower() not in bus_names for b in buses):
                    c.stale = f"its bus {buses[0].split('.')[0]} is not in the circuit"
            if c.stale:
                c.solvable, c.reason = False, c.stale
        if not c.solvable:
            warn(e, f"left out of the solve — {c.reason}.")
        out.append(c)
    return out, issues


def commands(checked: list[Checked], export: bool) -> list[str]:
    """The lines to send: on the solve path only the solvable entries; on
    export everything, a stale one commented out with the reason, so the
    exported file still compiles in stock OpenDSS and nothing is lost."""
    cmds: list[str] = []
    for c in checked:
        if c.solvable:
            cmds.extend(_lines(c.entry))
        elif export:
            if c.stale:
                cmds.append(f"! Left out by OpenDSS Designer: {c.stale}")
                cmds.extend(f"! {ln}" for ln in _lines(c.entry))
            else:
                cmds.extend(_lines(c.entry))
    return cmds
