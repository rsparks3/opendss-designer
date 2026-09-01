"""Import .dss files into a Circuit by round-tripping through the engine.

OpenDSS's own parser handles continuations, abbreviations, `like=`, redirects
and case, so we compile the file(s) and read the model back through the API
instead of hand-parsing. Multiple files may be supplied so `Redirect`ed
companions (line codes, bus coordinates) resolve; they are all written into
one temp directory and the file that defines the circuit is compiled.

Layout: if the model carries bus coordinates (BusCoords), busbars get real
positions (normalized to a drawing-sized canvas); otherwise positions are
left unset and the frontend auto-layouts.
"""
from __future__ import annotations

import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

import opendssdirect as dss

from . import engine
from .connectivity import sanitize_name
from .model import Circuit, CircuitEdge, CircuitNode, LoadShapeSpec, Position

_UNIT_CODES = {0: "none", 1: "mi", 2: "kft", 3: "km", 4: "m", 5: "ft", 6: "in", 7: "cm"}

SUPPORTED_PREFIXES = ("vsource.", "transformer.", "line.", "load.",
                      "capacitor.", "generator.", "pvsystem.", "storage.")

# Drawing-canvas size that geographic bus coordinates are normalized into.
_LAYOUT_W, _LAYOUT_H = 1800.0, 1200.0

_NODE_SUFFIX_RE = re.compile(r"^(\.\d+)+$")


class ImportFailure(Exception):
    """Import could not proceed; message is safe to show the user."""


def _base_bus(name: str) -> str:
    """Strip node suffixes: 'bus1.1.2.3' -> 'bus1'."""
    return name.split(".", 1)[0].lower()


def _node_suffix(name: str) -> str | None:
    """Extract '.1.2' from 'bus.1.2' (None when no explicit nodes given)."""
    base, dot, rest = name.partition(".")
    suffix = dot + rest if dot else ""
    return suffix if suffix and _NODE_SUFFIX_RE.match(suffix) else None


def _find_main(files: list[dict[str, str]]) -> dict[str, str]:
    circuit_re = re.compile(r"new\s+(object\s*=\s*)?circuit", re.IGNORECASE)
    for f in files:
        if circuit_re.search(f.get("text", "")):
            return f
    raise ImportFailure(
        "None of the selected files defines a circuit (no 'New Circuit.' statement). "
        "Select the feeder's main .dss file (plus any files it references).")


# Commands that write files, spawn processes, or repoint the engine. An import
# describes a circuit; it is data, not a program, so none of these are needed.
_FORBIDDEN = {
    "save", "export", "dump", "show", "plot", "visualize", "fileedit",
    "docmd", "dosimplecmd", "doscmd", "cd",
}

# Leading commands that name a companion file. buscoords/latloncoords are
# cosmetic (bus positions), so a missing one is a warning, not a failure.
_COSMETIC_REFS = {"buscoords", "latloncoords"}
_REF_LINE_RE = re.compile(
    r'^(\s*)(redirect|compile|buscoords|latloncoords)(\s+)"?([^"\s]+)"?(.*)$',
    re.IGNORECASE)

# Property forms that name a data file: `mult=(file=shape.csv)`, `(file=x)`,
# `csvfile=x`, `sngfile=`, `dblfile=`. `\bfile` does not match inside
# "csvfile" (the preceding 'v' is a word character), so both are needed.
_FILE_PARAM_RE = re.compile(r'\bfile\s*=\s*"?([^"\s,\)\]]+)', re.IGNORECASE)
_CSVFILE_PARAM_RE = re.compile(
    r'\b(?:csvfile|sngfile|dblfile)\s*=\s*"?([^"\s,\)\]]+)', re.IGNORECASE)

_LEADING_RE = re.compile(r'^\s*([A-Za-z_]+)')
_SET_BAD_RE = re.compile(r'^\s*set\b.*\b(datapath|editor)\s*=', re.IGNORECASE)
_DLL_RE = re.compile(r'\bdll\s*=', re.IGNORECASE)

# Uploaded filenames land in a temp dir; keep them boring.
_SAFE_NAME_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}')


def _is_comment(line: str) -> bool:
    t = line.lstrip()
    return not t or t.startswith("!") or t.startswith("//")


def _basename(ref: str) -> str:
    return Path(ref.replace("\\", "/")).name


def _sanitize_dss_text(text: str, provided: set[str]) -> tuple[str, list[str]]:
    """Make one uploaded .dss file safe to hand to the OpenDSS compiler.

    Every file reference is rewritten to its *basename*, so a path trying to
    leave the import temp directory ("../../etc/passwd") simply resolves to a
    name inside it. That is a normalization, not a blocklist, which is why it
    holds: there is no traversal spelling that survives it. A basename that was
    not uploaded is then reported as a missing companion file.

    Applied to every uploaded file, not just the one defining the circuit --
    otherwise a second file can redirect wherever it likes.
    """
    warnings: list[str] = []
    missing: list[str] = []
    out_lines: list[str] = []

    def rewrite(match: re.Match[str]) -> str:
        ref = match.group(1)
        base = _basename(ref)
        if base.lower() not in provided:
            missing.append(ref)
            return match.group(0)
        return match.group(0).replace(ref, base)

    for line in text.splitlines():
        if _is_comment(line):
            out_lines.append(line)
            continue

        lead = _LEADING_RE.match(line)
        verb = lead.group(1).lower() if lead else ""
        if verb in _FORBIDDEN:
            # Commented out rather than refused: real feeders routinely end
            # with `solve`/`export`/`show`, and none of it contributes to the
            # diagram. Skipping keeps those files importable; the line never
            # reaches the engine either way.
            warnings.append(
                f"Ignored '{verb}' — an import reads the circuit "
                "definition only, it does not run scripts.")
            out_lines.append("! " + line)
            continue
        if _SET_BAD_RE.match(line) or _DLL_RE.search(line):
            warnings.append(f"Ignored an unsupported directive: {line.strip()[:80]}")
            out_lines.append("! " + line)
            continue

        # Leading `redirect foo/bar.dss` -> `redirect bar.dss`
        m = _REF_LINE_RE.match(line)
        if m:
            indent, kind, gap, ref, rest = m.groups()
            base = _basename(ref)
            if base.lower() in provided:
                out_lines.append(f"{indent}{kind}{gap}{base}{rest}")
            elif kind.lower() in _COSMETIC_REFS:
                label = "BusCoords" if kind.lower() == "buscoords" else kind
                warnings.append(
                    f"Skipped '{label} {ref}' — file not provided, "
                    "so no geographic layout.")
                out_lines.append("! " + line)
            else:
                missing.append(ref)
                out_lines.append(line)
            continue

        line = _FILE_PARAM_RE.sub(rewrite, line)
        line = _CSVFILE_PARAM_RE.sub(rewrite, line)
        out_lines.append(line)

    if missing:
        raise ImportFailure(
            "This file references other files that were not selected: "
            + ", ".join(sorted(set(missing)))
            + ". Select the main .dss file AND those files together "
            "(Ctrl+click in the file dialog).")
    return "\n".join(out_lines), warnings


def import_dss(text: str) -> dict[str, Any]:
    """Single-file convenience wrapper (kept for API back-compat and tests)."""
    return import_dss_files([{"name": "main.dss", "text": text}])


@engine.on_engine_thread
def import_dss_files(files: list[dict[str, Any]]) -> dict[str, Any]:
    cleaned: list[dict[str, str]] = []
    for f in files:
        raw = str(f.get("name") or "file.dss")
        name = _basename(raw)
        # ".." survives basename stripping and "." collapses to "", both of
        # which name a directory -- writing to one crashes the import.
        if not _SAFE_NAME_RE.fullmatch(name):
            raise ImportFailure(
                f"'{raw}' is not a usable file name. Rename the file to plain "
                "letters, digits, dots, dashes or underscores and try again.")
        cleaned.append({"name": name, "text": str(f.get("text", ""))})
    files = cleaned
    if not files:
        raise ImportFailure("No files were provided.")
    main = _find_main(files)
    provided = {f["name"].lower() for f in files}

    # Sanitize *every* file: a companion file gets compiled too, via the main
    # file's redirect, so checking only the main one leaves the door open.
    warnings: list[str] = []
    for f in files:
        f["text"], warns = _sanitize_dss_text(f["text"], provided)
        warnings.extend(warns)

    with engine.dss_guard():
        engine._ensure_init()
        tmpdir = Path(tempfile.mkdtemp(prefix="opendss_import_"))
        try:
            for f in files:
                (tmpdir / f["name"]).write_text(f["text"], encoding="utf-8")
            dss.Text.Command("clear")
            try:
                dss.Text.Command(f'compile "{tmpdir / main["name"]}"')
            except Exception as exc:
                raise ImportFailure(f"OpenDSS could not compile the file: {exc}") from exc
            result = _read_model_back(warnings)
        finally:
            # Compiling moved OpenDSS's working dir into tmpdir; move it back
            # so the directory can be removed (best-effort — it's in temp).
            try:
                dss.Basic.DataPath(str(engine.WORKDIR))
            except Exception:
                pass
            shutil.rmtree(tmpdir, ignore_errors=True)
    return result


def _read_model_back(warnings: list[str]) -> dict[str, Any]:
    nodes: list[CircuitNode] = []
    edges: list[CircuitEdge] = []
    bus_node_ids: dict[str, str] = {}
    counter = {"n": 0, "e": 0}

    def node_id() -> str:
        counter["n"] += 1
        return f"imp_n{counter['n']}"

    def edge_id() -> str:
        counter["e"] += 1
        return f"imp_e{counter['e']}"

    def busbar_for(bus: str) -> str:
        bus = _base_bus(bus)
        if bus not in bus_node_ids:
            nid = node_id()
            bus_node_ids[bus] = nid
            nodes.append(CircuitNode(id=nid, type="busbar", width=200,
                                     params={"name": bus}))
        return bus_node_ids[bus]

    def wire(a_id: str, a_handle: str, b_id: str, b_handle: str) -> None:
        edges.append(CircuitEdge(
            id=edge_id(), type="wire",
            source=a_id, sourceHandle=a_handle,
            target=b_id, targetHandle=b_handle))

    unsupported: list[str] = []

    # Loadshapes (general DSS objects, not circuit elements — read first so
    # element `daily=` references can be matched case-insensitively).
    load_shapes: dict[str, LoadShapeSpec] = {}
    i = dss.LoadShape.First()
    while i:
        shape_name = dss.LoadShape.Name()
        if shape_name.lower() != "default":  # built-in shape, always present
            interval = dss.LoadShape.MinInterval() or dss.LoadShape.HrInterval() * 60
            load_shapes[shape_name] = LoadShapeSpec(
                intervalMin=round(interval or 60.0, 4),
                points=[round(v, 6) for v in dss.LoadShape.PMult()])
        i = dss.LoadShape.Next()
    shapes_lower = {k.lower(): k for k in load_shapes}

    def daily_shape() -> str | None:
        """The active element's daily shape, as a loadShapes key (or None)."""
        raw = dss.Properties.Value("daily").strip()
        return shapes_lower.get(raw.lower()) if raw else None

    # Vsources
    i = dss.Vsources.First()
    while i:
        name = dss.Vsources.Name()
        dss.Circuit.SetActiveElement(f"vsource.{name}")
        buses = dss.CktElement.BusNames()
        nid = node_id()
        nodes.append(CircuitNode(
            id=nid, type="vsource",
            params={"name": name, "basekv": dss.Vsources.BasekV(),
                    "pu": dss.Vsources.PU(), "phases": dss.Vsources.Phases(),
                    "angle": dss.Vsources.AngleDeg()}))
        if buses:
            wire(nid, "t1", busbar_for(buses[0]), "b0")
        i = dss.Vsources.Next()

    # Transformers (2-winding supported; others reported)
    i = dss.Transformers.First()
    while i:
        name = dss.Transformers.Name()
        nwdg = dss.Transformers.NumWindings()
        dss.Circuit.SetActiveElement(f"transformer.{name}")
        raw_buses = dss.CktElement.BusNames()
        if nwdg != 2:
            unsupported.append(f"Transformer.{name} ({nwdg} windings)")
            i = dss.Transformers.Next()
            continue
        windings = []
        for w in range(1, nwdg + 1):
            dss.Transformers.Wdg(w)
            windings.append({"kv": dss.Transformers.kV(),
                             "kva": dss.Transformers.kVA(),
                             "conn": "delta" if dss.Transformers.IsDelta() else "wye"})
        bus_nodes = [_node_suffix(b) for b in raw_buses[:2]]
        nid = node_id()
        params: dict[str, Any] = {
            "name": name, "phases": dss.CktElement.NumPhases(),
            "windings": windings, "xhl": dss.Transformers.Xhl()}
        if any(bus_nodes):
            params["busNodes"] = bus_nodes
        nodes.append(CircuitNode(id=nid, type="transformer", params=params))
        for term, bus in enumerate(raw_buses[:2]):
            wire(nid, f"t{term + 1}", busbar_for(bus), "b0")
        i = dss.Transformers.Next()

    # Lines: switches become breaker nodes, others become line edges.
    i = dss.Lines.First()
    while i:
        name = dss.Lines.Name()
        raw1, raw2 = dss.Lines.Bus1(), dss.Lines.Bus2()
        b1, b2 = _base_bus(raw1), _base_bus(raw2)
        is_switch = bool(getattr(dss.Lines, "IsSwitch", lambda: False)())
        if is_switch:
            dss.Circuit.SetActiveElement(f"line.{name}")
            closed = not dss.CktElement.IsOpen(1, 0)
            nid = node_id()
            nodes.append(CircuitNode(
                id=nid, type="breaker",
                params={"name": name, "closed": closed,
                        "normamps": dss.Lines.NormAmps(),
                        "phases": dss.Lines.Phases()}))
            wire(nid, "t1", busbar_for(b1), "b0")
            wire(nid, "t2", busbar_for(b2), "b0")
        else:
            params = {"name": name, "length": dss.Lines.Length(),
                      "units": _UNIT_CODES.get(dss.Lines.Units(), "none"),
                      "r1": dss.Lines.R1(), "x1": dss.Lines.X1(),
                      "r0": dss.Lines.R0(), "x0": dss.Lines.X0(),
                      "normamps": dss.Lines.NormAmps(),
                      "phases": dss.Lines.Phases()}
            # Impedances above are already resolved from the linecode; keep
            # the code name as a reference tag.
            linecode = dss.Lines.LineCode()
            if linecode:
                params["linecode"] = linecode
            n1, n2 = _node_suffix(raw1), _node_suffix(raw2)
            if n1:
                params["nodes1"] = n1
            if n2:
                params["nodes2"] = n2
            edges.append(CircuitEdge(
                id=edge_id(), type="line",
                source=busbar_for(b1), sourceHandle="b0",
                target=busbar_for(b2), targetHandle="b0",
                params=params))
        i = dss.Lines.Next()

    # Loads (exact node connections like '.1.2' preserved via busNodes)
    i = dss.Loads.First()
    while i:
        name = dss.Loads.Name()
        dss.Circuit.SetActiveElement(f"load.{name}")
        buses = dss.CktElement.BusNames()
        nid = node_id()
        params = {"name": name, "kv": dss.Loads.kV(), "kw": dss.Loads.kW(),
                  "pf": dss.Loads.PF(),
                  "conn": "delta" if dss.Loads.IsDelta() else "wye",
                  "phases": dss.CktElement.NumPhases(),
                  "model": dss.Loads.Model()}
        shape = daily_shape()
        if shape:
            params["loadshape"] = shape
        if buses:
            suffix = _node_suffix(buses[0])
            if suffix:
                params["busNodes"] = suffix
        nodes.append(CircuitNode(id=nid, type="load", params=params))
        if buses:
            wire(nid, "t1", busbar_for(buses[0]), "b0")
        i = dss.Loads.Next()

    # Capacitors (shunt only; series caps are exotic enough to report)
    i = dss.Capacitors.First()
    while i:
        name = dss.Capacitors.Name()
        dss.Circuit.SetActiveElement(f"capacitor.{name}")
        buses = dss.CktElement.BusNames()
        nid = node_id()
        params = {"name": name, "kv": dss.Capacitors.kV(),
                  "kvar": dss.Capacitors.kvar(),
                  "conn": "delta" if dss.Capacitors.IsDelta() else "wye",
                  "phases": dss.CktElement.NumPhases(),
                  "numsteps": dss.Capacitors.NumSteps()}
        if buses:
            suffix = _node_suffix(buses[0])
            if suffix:
                params["busNodes"] = suffix
        nodes.append(CircuitNode(id=nid, type="capacitor", params=params))
        if buses:
            wire(nid, "t1", busbar_for(buses[0]), "b0")
        i = dss.Capacitors.Next()

    # Generators
    i = dss.Generators.First()
    while i:
        name = dss.Generators.Name()
        dss.Circuit.SetActiveElement(f"generator.{name}")
        buses = dss.CktElement.BusNames()
        nid = node_id()
        params = {"name": name, "kv": dss.Generators.kV(),
                  "kw": dss.Generators.kW(), "pf": dss.Generators.PF(),
                  "phases": dss.CktElement.NumPhases(),
                  "model": dss.Generators.Model()}
        if buses:
            suffix = _node_suffix(buses[0])
            if suffix:
                params["busNodes"] = suffix
        nodes.append(CircuitNode(id=nid, type="generator", params=params))
        if buses:
            wire(nid, "t1", busbar_for(buses[0]), "b0")
        i = dss.Generators.Next()

    # PV systems (kv/conn have no iterator getters; Properties is the path)
    i = dss.PVsystems.First()
    while i:
        name = dss.PVsystems.Name()
        dss.Circuit.SetActiveElement(f"pvsystem.{name}")
        buses = dss.CktElement.BusNames()
        nid = node_id()
        params: dict[str, Any] = {
            "name": name, "kv": float(dss.Properties.Value("kv") or 12.47),
            "kva": dss.PVsystems.kVARated(), "pmpp": dss.PVsystems.Pmpp(),
            "pf": dss.PVsystems.pf(), "irradiance": dss.PVsystems.Irradiance(),
            "conn": "delta" if dss.Properties.Value("conn").lower().startswith("d") else "wye",
            "phases": dss.CktElement.NumPhases()}
        shape = daily_shape()
        if shape:
            params["loadshape"] = shape
            # A shape driving a PV system is its irradiance profile.
            load_shapes[shape].kind = "irradiance"
        if buses:
            suffix = _node_suffix(buses[0])
            if suffix:
                params["busNodes"] = suffix
        nodes.append(CircuitNode(id=nid, type="pvsystem", params=params))
        if buses:
            wire(nid, "t1", busbar_for(buses[0]), "b0")
        i = dss.PVsystems.Next()

    # Storage (the Storages iterator has no rating getters at all)
    i = dss.Storages.First()
    while i:
        name = dss.Storages.Name()
        dss.Circuit.SetActiveElement(f"storage.{name}")
        buses = dss.CktElement.BusNames()
        nid = node_id()
        dispatch = dss.Properties.Value("dispmode").lower()
        params = {
            "name": name, "kv": float(dss.Properties.Value("kv") or 12.47),
            "kwrated": float(dss.Properties.Value("kwrated") or 0),
            "kwhrated": float(dss.Properties.Value("kwhrated") or 0),
            "effcharge": float(dss.Properties.Value("%effcharge") or 0),
            "effdischarge": float(dss.Properties.Value("%effdischarge") or 0),
            "reserve": float(dss.Properties.Value("%reserve") or 0),
            "soc": float(dss.Properties.Value("%stored") or 0),
            "conn": "delta" if dss.Properties.Value("conn").lower().startswith("d") else "wye",
            "phases": dss.CktElement.NumPhases(),
            "dispatch": "follow" if dispatch == "follow" else "default"}
        if params["dispatch"] == "default":
            params.update({
                "pctdischarge": float(dss.Properties.Value("%discharge") or 100),
                "pctcharge": float(dss.Properties.Value("%charge") or 100),
                "dischargetrigger": float(dss.Properties.Value("dischargetrigger") or 0),
                "chargetrigger": float(dss.Properties.Value("chargetrigger") or 0)})
        shape = daily_shape()
        if shape:
            params["loadshape"] = shape
        if buses:
            suffix = _node_suffix(buses[0])
            if suffix:
                params["busNodes"] = suffix
        nodes.append(CircuitNode(id=nid, type="storage", params=params))
        if buses:
            wire(nid, "t1", busbar_for(buses[0]), "b0")
        i = dss.Storages.Next()

    # Anything else in the model is out of v1 scope.
    for full in dss.Circuit.AllElementNames():
        if not full.lower().startswith(SUPPORTED_PREFIXES):
            unsupported.append(full)

    _apply_bus_coords(nodes, bus_node_ids)

    circuit_name = sanitize_name(dss.Circuit.Name()) or "imported"
    circuit = Circuit(name=circuit_name, nodes=nodes, edges=edges,
                      loadShapes=load_shapes)
    return {"circuit": circuit.model_dump(), "unsupported": unsupported,
            "warnings": warnings}


def _apply_bus_coords(nodes: list[CircuitNode], bus_node_ids: dict[str, str]) -> None:
    """Position busbars from BusCoords when the model has them (normalized
    into a drawing-sized canvas, y flipped from map to screen)."""
    coords: dict[str, tuple[float, float]] = {}
    for bus in dss.Circuit.AllBusNames():
        dss.Circuit.SetActiveBus(bus)
        if dss.Bus.Coorddefined():
            coords[bus.lower()] = (dss.Bus.X(), dss.Bus.Y())
    placed = {b: xy for b, xy in coords.items() if b in bus_node_ids}
    if len(placed) < 2:
        return
    xs = [x for x, _ in placed.values()]
    ys = [y for _, y in placed.values()]
    dx = max(xs) - min(xs) or 1.0
    dy = max(ys) - min(ys) or 1.0
    scale = min(_LAYOUT_W / dx, _LAYOUT_H / dy)
    by_id = {n.id: n for n in nodes}
    for bus, (x, y) in placed.items():
        node = by_id[bus_node_ids[bus]]
        node.position = Position(
            x=round((x - min(xs)) * scale / 10) * 10,
            y=round((max(ys) - y) * scale / 10) * 10)
