"""Import a .dss file into a Circuit by round-tripping through the engine.

OpenDSS's own parser handles continuations, abbreviations, `like=`, redirects
and case, so we compile the file and read the model back through the API
instead of hand-parsing. Positions are left unset; the frontend auto-layouts.
Every referenced bus becomes a busbar node (users can delete/merge later).
"""
from __future__ import annotations

import tempfile
import threading
from pathlib import Path
from typing import Any

import opendssdirect as dss

from .connectivity import sanitize_name
from .model import Circuit, CircuitEdge, CircuitNode

_lock = threading.Lock()

_UNIT_CODES = {0: "none", 1: "mi", 2: "kft", 3: "km", 4: "m", 5: "ft", 6: "in", 7: "cm"}

SUPPORTED_PREFIXES = ("vsource.", "transformer.", "line.", "load.")


def _base_bus(name: str) -> str:
    """Strip node suffixes: 'bus1.1.2.3' -> 'bus1'."""
    return name.split(".", 1)[0].lower()


def import_dss(text: str) -> dict[str, Any]:
    with _lock:
        with tempfile.NamedTemporaryFile("w", suffix=".dss", delete=False,
                                         encoding="utf-8") as f:
            f.write(text)
            path = Path(f.name)
        try:
            dss.Text.Command("clear")
            dss.Text.Command(f'compile "{path}"')
        finally:
            path.unlink(missing_ok=True)

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
                nodes.append(CircuitNode(
                    id=nid, type="busbar", width=240,
                    params={"name": bus}))
            return bus_node_ids[bus]

        def wire(a_id: str, a_handle: str, b_id: str, b_handle: str) -> None:
            edges.append(CircuitEdge(
                id=edge_id(), type="wire",
                source=a_id, sourceHandle=a_handle,
                target=b_id, targetHandle=b_handle))

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
        unsupported: list[str] = []
        i = dss.Transformers.First()
        while i:
            name = dss.Transformers.Name()
            nwdg = dss.Transformers.NumWindings()
            dss.Circuit.SetActiveElement(f"transformer.{name}")
            buses = [_base_bus(b) for b in dss.CktElement.BusNames()]
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
            nid = node_id()
            nodes.append(CircuitNode(
                id=nid, type="transformer",
                params={"name": name, "phases": dss.CktElement.NumPhases(),
                        "windings": windings, "xhl": dss.Transformers.Xhl()}))
            for term, bus in enumerate(buses[:2]):
                wire(nid, f"t{term + 1}", busbar_for(bus), "b0")
            i = dss.Transformers.Next()

        # Lines: switches become breaker nodes, others become line edges.
        i = dss.Lines.First()
        while i:
            name = dss.Lines.Name()
            b1, b2 = _base_bus(dss.Lines.Bus1()), _base_bus(dss.Lines.Bus2())
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
                edges.append(CircuitEdge(
                    id=edge_id(), type="line",
                    source=busbar_for(b1), sourceHandle="b0",
                    target=busbar_for(b2), targetHandle="b0",
                    params={"name": name, "length": dss.Lines.Length(),
                            "units": _UNIT_CODES.get(dss.Lines.Units(), "none"),
                            "r1": dss.Lines.R1(), "x1": dss.Lines.X1(),
                            "r0": dss.Lines.R0(), "x0": dss.Lines.X0(),
                            "normamps": dss.Lines.NormAmps(),
                            "phases": dss.Lines.Phases()}))
            i = dss.Lines.Next()

        # Loads
        i = dss.Loads.First()
        while i:
            name = dss.Loads.Name()
            dss.Circuit.SetActiveElement(f"load.{name}")
            buses = dss.CktElement.BusNames()
            nid = node_id()
            nodes.append(CircuitNode(
                id=nid, type="load",
                params={"name": name, "kv": dss.Loads.kV(), "kw": dss.Loads.kW(),
                        "pf": dss.Loads.PF(),
                        "conn": "delta" if dss.Loads.IsDelta() else "wye",
                        "phases": dss.CktElement.NumPhases(),
                        "model": dss.Loads.Model()}))
            if buses:
                wire(nid, "t1", busbar_for(buses[0]), "b0")
            i = dss.Loads.Next()

        # Anything else in the model is out of v1 scope.
        for full in dss.Circuit.AllElementNames():
            if not full.lower().startswith(SUPPORTED_PREFIXES):
                unsupported.append(full)

        circuit_name = sanitize_name(dss.Circuit.Name()) or "imported"

    circuit = Circuit(name=circuit_name, nodes=nodes, edges=edges)
    return {"circuit": circuit.model_dump(), "unsupported": unsupported}
