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
from .model import Circuit, CircuitNode, CircuitEdge, Position

_UNIT_CODES = {0: "none", 1: "mi", 2: "kft", 3: "km", 4: "m", 5: "ft", 6: "in", 7: "cm"}

SUPPORTED_PREFIXES = ("vsource.", "transformer.", "line.", "load.")

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


def _check_references(main_text: str, provided: set[str]) -> tuple[str, list[str]]:
    """Verify Redirect/Compile targets were uploaded; comment out BusCoords
    lines whose file is missing (coordinates are cosmetic)."""
    warnings: list[str] = []
    missing: list[str] = []
    out_lines: list[str] = []
    ref_re = re.compile(r'^\s*(redirect|compile|buscoords)\s+"?([^"\s]+)"?', re.IGNORECASE)
    for line in main_text.splitlines():
        m = ref_re.match(line)
        if m:
            kind, ref = m.group(1).lower(), m.group(2)
            if Path(ref).name.lower() not in provided:
                if kind == "buscoords":
                    warnings.append(
                        f"Skipped 'BusCoords {ref}' — file not provided, "
                        "so no geographic layout.")
                    out_lines.append("! " + line)
                    continue
                missing.append(ref)
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


def import_dss_files(files: list[dict[str, Any]]) -> dict[str, Any]:
    files = [{"name": Path(str(f.get("name") or "file.dss")).name,
              "text": str(f.get("text", ""))} for f in files]
    if not files:
        raise ImportFailure("No files were provided.")
    main = _find_main(files)
    provided = {f["name"].lower() for f in files}
    main_text, warnings = _check_references(main["text"], provided)

    with engine._lock:
        engine._ensure_init()
        tmpdir = Path(tempfile.mkdtemp(prefix="opendss_import_"))
        try:
            for f in files:
                text = main_text if f is main else f["text"]
                (tmpdir / f["name"]).write_text(text, encoding="utf-8")
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
        if buses:
            suffix = _node_suffix(buses[0])
            if suffix:
                params["busNodes"] = suffix
        nodes.append(CircuitNode(id=nid, type="load", params=params))
        if buses:
            wire(nid, "t1", busbar_for(buses[0]), "b0")
        i = dss.Loads.Next()

    # Anything else in the model is out of v1 scope.
    for full in dss.Circuit.AllElementNames():
        if not full.lower().startswith(SUPPORTED_PREFIXES):
            unsupported.append(full)

    _apply_bus_coords(nodes, bus_node_ids)

    circuit_name = sanitize_name(dss.Circuit.Name()) or "imported"
    circuit = Circuit(name=circuit_name, nodes=nodes, edges=edges)
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
