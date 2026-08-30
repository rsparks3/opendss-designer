"""Pydantic schema for the circuit model exchanged with the frontend.

The frontend zustand store is the canonical model; every request carries the
full circuit. Element parameters are kept as open dicts (validated for the
fields the compiler needs) so the frontend can add fields without a lockstep
schema change.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

NodeType = Literal["vsource", "busbar", "transformer", "load", "breaker",
                   "capacitor", "generator", "pvsystem", "storage"]
EdgeType = Literal["wire", "line"]


class Position(BaseModel):
    x: float = 0.0
    y: float = 0.0


class CircuitNode(BaseModel):
    id: str
    type: NodeType
    position: Optional[Position] = None
    width: Optional[float] = None
    height: Optional[float] = None
    params: dict[str, Any] = Field(default_factory=dict)


class CircuitEdge(BaseModel):
    id: str
    type: EdgeType = "wire"
    source: str
    sourceHandle: Optional[str] = None
    target: str
    targetHandle: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)
    # User-placed routing points (diagram cosmetics only; no electrical meaning).
    waypoints: Optional[list[Position]] = None


class LoadShapeSpec(BaseModel):
    """A named multiplier curve assignable to loads/PV/storage (daily+yearly).

    All kinds compile to OpenDSS `loadshape` objects; `kind` only drives the
    UI (library tabs, per-element dropdown filtering) and validation warnings.
    """
    kind: Literal["load", "irradiance"] = "load"
    intervalMin: float = 60.0  # minutes per point (60 or 15)
    points: list[float] = Field(default_factory=list)
    # Provenance tag, e.g. "csv", "nrel:resstock/3a/single-family_detached",
    # or "nsrdb:39.74,-104.99/2018".
    source: Optional[str] = None


class Circuit(BaseModel):
    version: int = 1
    name: str = "circuit"
    nodes: list[CircuitNode] = Field(default_factory=list)
    edges: list[CircuitEdge] = Field(default_factory=list)
    # Persisted names for implicit junction buses, keyed by a stable group
    # fingerprint (lexicographically smallest terminal key in the group).
    busNames: dict[str, str] = Field(default_factory=dict)
    # Circuit-level loadshape library, keyed by shape name.
    loadShapes: dict[str, LoadShapeSpec] = Field(default_factory=dict)


class Issue(BaseModel):
    severity: Literal["error", "warning"]
    code: str
    message: str
    nodeId: Optional[str] = None
    edgeId: Optional[str] = None


# Handles each node type exposes, by convention shared with the frontend.
# Busbars have dynamic handles (b0..bN); any handle on a busbar is the same
# electrical bus, so the specific id never matters to the backend.
NODE_TERMINALS: dict[str, list[str]] = {
    "vsource": ["t1"],
    "load": ["t1"],
    "transformer": ["t1", "t2"],
    "breaker": ["t1", "t2"],
    "capacitor": ["t1"],
    "generator": ["t1"],
    "pvsystem": ["t1"],
    "storage": ["t1"],
}
