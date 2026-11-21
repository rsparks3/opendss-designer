"""Pydantic schema for the circuit model exchanged with the frontend.

The frontend zustand store is the canonical model; every request carries the
full circuit. Element parameters are kept as open dicts (validated for the
fields the compiler needs) so the frontend can add fields without a lockstep
schema change.
"""

from __future__ import annotations

import json
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator

# Structural ceilings that apply in every mode. These are not the demo limits
# (see settings.Settings / validate.py, which sit far below these); they exist
# so a malformed or hostile payload fails as a clean 422 instead of an OOM.
MAX_NODES = 100_000
MAX_EDGES = 200_000
MAX_SHAPES = 1_000
MAX_SHAPE_POINTS = 1_000_000
MAX_CURVES = 200
MAX_CURVE_POINTS = 200
MAX_LINE_CODES = 2_000
MAX_PASSTHROUGH = 20_000
MAX_PASSTHROUGH_TEXT = 20_000
MAX_COMMENT_TEXT = 4_000
MAX_GEOMETRY_POINTS = 10_000
MAX_CRS_TEXT = 4_000

NodeType = Literal[
    "vsource",
    "busbar",
    "transformer",
    "load",
    "breaker",
    "capacitor",
    "generator",
    "pvsystem",
    "storage",
    "regulator",
    "fuse",
    "recloser",
    "relay",
    "note",
    "zone",
]
# Drawing, not circuit: no terminals, never compiled, never counted.
ANNOTATION_TYPES = frozenset({"note", "zone"})
EdgeType = Literal["wire", "line"]


class Position(BaseModel):
    x: float = 0.0
    y: float = 0.0


class CircuitNode(BaseModel):
    id: str
    type: NodeType
    position: Position | None = None
    width: float | None = None
    height: float | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    # Where it is on the ground, in the circuit's `crs` (a bus's BusCoords,
    # or a GIS point feature). Drawing-independent: the schematic `position`
    # is where it sits on the one-line, this is where it sits on the map.
    geo: Position | None = None


class CircuitEdge(BaseModel):
    id: str
    type: EdgeType = "wire"
    source: str
    sourceHandle: str | None = None
    target: str
    targetHandle: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    # User-placed routing points (diagram cosmetics only; no electrical meaning).
    waypoints: list[Position] | None = None
    # A line's route on the ground between its two buses, in the circuit's
    # `crs`: the interior vertices of a GIS polyline (the ends are the buses').
    geometry: Annotated[list[Position], Field(max_length=MAX_GEOMETRY_POINTS)] | None = None


class LoadShapeSpec(BaseModel):
    """A named multiplier curve assignable to loads/PV/storage (daily+yearly).

    All kinds compile to OpenDSS `loadshape` objects; `kind` only drives the
    UI (library tabs, per-element dropdown filtering) and validation warnings.
    """

    kind: Literal["load", "irradiance"] = "load"
    intervalMin: float = 60.0  # minutes per point (60 or 15)
    points: Annotated[list[float], Field(max_length=MAX_SHAPE_POINTS)] = Field(default_factory=list)
    # Provenance tag, e.g. "csv", "nrel:resstock/3a/single-family_detached",
    # or "nsrdb:39.74,-104.99/2018".
    source: str | None = None


class TccCurveSpec(BaseModel):
    """A user-defined time-current curve: multiples of the device's pickup
    against seconds to operate, the same shape the engine's built-in curves
    have. Points are plotted and interpolated in the order given."""

    multiples: Annotated[list[float], Field(max_length=MAX_CURVE_POINTS)] = Field(
        default_factory=list
    )
    seconds: Annotated[list[float], Field(max_length=MAX_CURVE_POINTS)] = Field(
        default_factory=list
    )
    # Where it came from, e.g. a manufacturer and link size.
    source: str | None = None


Matrix = list[list[float]]


class LineCodeSpec(BaseModel):
    """A conductor definition lines refer to by name: OpenDSS's `LineCode`.

    Either a full phase impedance matrix (`rmatrix`/`xmatrix`, optionally
    `cmatrix`, each `nphases` square, ohms and nF per `units`) or the
    sequence values `r1 x1 r0 x0` (with optional `c1 c0`) that the engine
    expands to a matrix itself. A real feeder is almost always the first
    kind, and the matrix is the whole point: it carries the mutual coupling
    between phases that four sequence numbers cannot.
    """

    nphases: int = 3
    units: str = "km"
    rmatrix: Matrix | None = None
    xmatrix: Matrix | None = None
    cmatrix: Matrix | None = None
    r1: float | None = None
    x1: float | None = None
    r0: float | None = None
    x0: float | None = None
    c1: float | None = None
    c0: float | None = None
    normamps: float | None = None
    # Where it came from: "imported", "typed in", "geometry:<name>" (built by
    # the engine from a LineGeometry the file defined), "preset:<code>".
    source: str | None = None

    @property
    def is_matrix(self) -> bool:
        return self.rmatrix is not None and self.xmatrix is not None


class WireDataSpec(BaseModel):
    """A conductor (OpenDSS `WireData`, or `CNData` / `TSData` for a
    concentric-neutral or tape-shield cable): resistance, GMR, radius and
    ampacity, in the units named. `extra` holds the cable classes' own
    properties (k, diastrand, gmrstrand, rstrand, epsr, inslayer, diains,
    diacable; or diashield, tapelayer, tapelap) by their engine names."""

    kind: Literal["wire", "cn", "ts"] = "wire"
    rdc: float | None = None
    rac: float | None = None
    runits: str = "mi"
    gmr: float | None = None
    gmrunits: str = "ft"
    radius: float | None = None
    radunits: str = "in"
    normamps: float | None = None
    emergamps: float | None = None
    extra: dict[str, float] = Field(default_factory=dict)
    # "library:<code>", "imported", "typed in".
    source: str | None = None


class GeometryConductor(BaseModel):
    wire: str
    x: float = 0.0
    h: float = 0.0


class LineGeometrySpec(BaseModel):
    """A pole or trench configuration (OpenDSS `LineGeometry`): which
    conductor hangs where. The engine builds the impedance matrix from it,
    with Carson's equations, so a line on a geometry needs no line code."""

    nconds: int = 4
    nphases: int = 3
    reduce: bool = True
    units: str = "ft"
    rhoEarth: float | None = None
    conductors: Annotated[list[GeometryConductor], Field(max_length=16)] = Field(
        default_factory=list
    )
    source: str | None = None


class HistoryEntry(BaseModel):
    """One change to the model, for the audit trail: when, who (the study's
    engineer), what element, which parameter, from what to what."""

    t: float
    who: str = ""
    id: str
    param: str
    old: Any = None
    new: Any = None
    # The scenario the change was made in, or None for the base case.
    scenario: str | None = None


class PassthroughSpec(BaseModel):
    """An element from an imported .dss file the editor does not model,
    kept verbatim: its `New` line, then any `Edit`s of it. See
    core/passthrough.py for what is kept and when it runs."""

    # "Monitor.m1", as the file spelled it.
    name: Annotated[str, Field(max_length=256)]
    text: Annotated[str, Field(max_length=MAX_PASSTHROUGH_TEXT)]


class XYCurveSpec(BaseModel):
    """A general x-y curve (OpenDSS `XYCurve`): the volt-var and volt-watt
    characteristics of a smart inverter, in per-unit voltage against
    per-unit reactive or active power. Points are in x order."""

    x: Annotated[list[float], Field(max_length=MAX_CURVE_POINTS)] = Field(default_factory=list)
    y: Annotated[list[float], Field(max_length=MAX_CURVE_POINTS)] = Field(default_factory=list)
    # "ieee1547:catB:voltvar", "imported", "typed in".
    source: str | None = None


class LoadLevel(BaseModel):
    """A load condition a study is run at: a multiplier on every load
    (`set loadmult`), optional multipliers by load class on top, and which
    rating -- normal or emergency -- loading is judged against. "Peak" at
    1.0 on the normal rating is what every circuit solved before levels
    existed; "Minimum daytime load" at 0.3 is what a hosting-capacity
    study binds on."""

    name: Annotated[str, Field(min_length=1, max_length=80)]
    loadmult: Annotated[float, Field(gt=0, le=100)] = 1.0
    rating: Literal["normal", "emergency"] = "normal"
    # Multiplier per load class (the load's `class` param), applied to the
    # load's kW on top of `loadmult`. A class not listed is 1.
    classMult: Annotated[dict[str, Annotated[float, Field(ge=0, le=100)]], Field(max_length=50)] = (
        Field(default_factory=dict)
    )


class Scenario(BaseModel):
    """An alternative to the base circuit, stored as element-level deltas so
    a project with ten alternatives is still one drawing: parameter
    overrides on existing elements (a changed setting, an opened tie, a
    unit taken out of service), elements added (a new DER, a new tie), and
    elements removed. `studies.scenarios.apply_scenario` builds the
    effective circuit."""

    id: Annotated[str, Field(min_length=1, max_length=64)]
    name: Annotated[str, Field(min_length=1, max_length=120)]
    description: Annotated[str, Field(max_length=MAX_COMMENT_TEXT)] = ""
    # element id -> {param: value}; a value of None deletes the param.
    overrides: Annotated[dict[str, dict[str, Any]], Field(max_length=MAX_NODES)] = Field(
        default_factory=dict
    )
    addedNodes: Annotated[list[CircuitNode], Field(max_length=MAX_NODES)] = Field(
        default_factory=list
    )
    addedEdges: Annotated[list[CircuitEdge], Field(max_length=MAX_EDGES)] = Field(
        default_factory=list
    )
    removed: Annotated[list[str], Field(max_length=MAX_NODES)] = Field(default_factory=list)

    @field_validator("overrides")
    @classmethod
    def _overrides_are_parameters(cls, v: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """An override is a parameter patch, nothing else: identifier-like
        keys, JSON values of bounded size. What a value may be is checked
        where the compiler reads it (every property is allowlisted or
        clamped there), exactly as for the base circuit's own parameters;
        this keeps a scenario from smuggling anything that is not a
        parameter, or one too large to be one."""
        for element_id, patch in v.items():
            if not element_id or len(element_id) > 200:
                raise ValueError("an override names an element id that is empty or too long")
            for key, value in patch.items():
                if not _PARAM_KEY_RE.fullmatch(key):
                    raise ValueError(f"'{key[:40]}' is not a parameter name")
                if not _plain_json(value, depth=0):
                    raise ValueError(f"the override of '{key}' is not a plain value")
            if len(json.dumps(patch, default=str)) > MAX_OVERRIDE_BYTES:
                raise ValueError(f"the override of element '{element_id[:40]}' is too large")
        return v


# A parameter name: what the editor and importer write ("kw", "windings",
# "w0.kv" in the spreadsheet's flattened form never reaches the server).
_PARAM_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
MAX_OVERRIDE_BYTES = 64_000


def _plain_json(value: Any, depth: int) -> bool:
    """None, a bool, a finite number, a string, or lists/dicts of them (a
    transformer's windings), nested at most three deep."""
    if value is None or isinstance(value, (bool, str)):
        return True
    if isinstance(value, (int, float)):
        return value == value and value not in (float("inf"), float("-inf"))
    if depth >= 3:
        return False
    if isinstance(value, list):
        return all(_plain_json(x, depth + 1) for x in value)
    if isinstance(value, dict):
        return all(isinstance(k, str) and _plain_json(x, depth + 1) for k, x in value.items())
    return False


class TccSet(BaseModel):
    """A saved selection of protective devices for the time-current plot
    (facility plan 2.5): one plot per set in the report."""

    id: Annotated[str, Field(min_length=1, max_length=64)]
    name: Annotated[str, Field(min_length=1, max_length=120)]
    deviceIds: Annotated[list[Annotated[str, Field(max_length=200)]], Field(max_length=50)] = Field(
        default_factory=list
    )


class Allocation(BaseModel):
    """Scale the loads below a meter point (`meterElementId`: a series element
    or a source) so a solve agrees with a measured value. The factor a run
    finds is stored here and applied when the circuit compiles, so the
    loads keep the values entered; baking writes it into them instead."""

    id: Annotated[str, Field(min_length=1, max_length=64)]
    meterElementId: Annotated[str, Field(min_length=1, max_length=200)]
    targetKW: Annotated[float, Field(gt=0, le=1e7)]
    targetKvar: Annotated[float, Field(ge=-1e7, le=1e7)] | None = None
    targetPF: Annotated[float, Field(gt=0, le=1)] | None = None
    # Multiplier by load priority or tag, applied before the scaling.
    demandFactors: (
        Annotated[dict[str, Annotated[float, Field(ge=0, le=100)]], Field(max_length=50)] | None
    ) = None
    source: Annotated[str, Field(max_length=500)] = ""
    lastFactor: Annotated[float, Field(gt=0, le=1000)] | None = None
    lastKvarFactor: Annotated[float, Field(gt=0, le=1000)] | None = None
    lastAchievedKW: float | None = None
    lastIterations: int | None = None
    lastConverged: bool | None = None


class Limits(BaseModel):
    """What counts as an abnormal condition: the planning criteria the
    overlays, the solve's violation flags and the study report all apply.
    The defaults are ANSI C84.1 Range A and a line at its rating."""

    vminPu: Annotated[float, Field(gt=0, lt=2)] = 0.95
    vmaxPu: Annotated[float, Field(gt=0, lt=2)] = 1.05
    # Loading at or above this is an overload...
    overloadPct: Annotated[float, Field(gt=0, le=1000)] = 100.0
    # ...and at or above this, a warning.
    warnPct: Annotated[float, Field(gt=0, le=1000)] = 80.0
    # Equipment duty screening: a device passes when its rating is at least
    # the fault current x asymmetryFactor x dutyMargin. The asymmetry factor
    # is a flat multiplier the user enters; no X/R correction is computed.
    dutyMargin: Annotated[float, Field(ge=0.5, le=3)] = 1.0
    asymmetryFactor: Annotated[float, Field(ge=1, le=3)] = 1.0


class StudyInfo(BaseModel):
    """The title block of a study report, and of the drawing when `sheet`
    asks for one. Nothing reads it but the report and the image export."""

    title: Annotated[str, Field(max_length=200)] = ""
    caseName: Annotated[str, Field(max_length=200)] = ""
    engineer: Annotated[str, Field(max_length=200)] = ""
    company: Annotated[str, Field(max_length=200)] = ""
    description: Annotated[str, Field(max_length=MAX_COMMENT_TEXT)] = ""
    # Draw exported images on a sheet: a border, and this block in the
    # bottom-right corner, the way a drawing is plotted.
    sheet: bool = False
    # How the report prints lengths: km and m, or miles and feet.
    units: Literal["metric", "imperial"] = "metric"


class Circuit(BaseModel):
    version: int = 1
    name: str = "circuit"
    nodes: Annotated[list[CircuitNode], Field(max_length=MAX_NODES)] = Field(default_factory=list)
    edges: Annotated[list[CircuitEdge], Field(max_length=MAX_EDGES)] = Field(default_factory=list)
    # Persisted names for implicit junction buses, keyed by a stable group
    # fingerprint (lexicographically smallest terminal key in the group).
    busNames: dict[str, str] = Field(default_factory=dict)
    # Circuit-level loadshape library, keyed by shape name.
    loadShapes: Annotated[dict[str, LoadShapeSpec], Field(max_length=MAX_SHAPES)] = Field(
        default_factory=dict
    )
    # Circuit-level time-current curve library, keyed by curve name. The engine
    # ships ten curves of its own; these are the ones a user adds.
    tccCurves: Annotated[dict[str, TccCurveSpec], Field(max_length=MAX_CURVES)] = Field(
        default_factory=dict
    )
    # Circuit-level conductor library, keyed by line-code name. Lines with a
    # `linecode` param naming an entry take their impedance from it.
    lineCodes: Annotated[dict[str, LineCodeSpec], Field(max_length=MAX_LINE_CODES)] = Field(
        default_factory=dict
    )
    # What an imported file said that the diagram does not show: elements
    # of classes the editor does not model, and comments. Written back on
    # export; passthrough elements also run in solves when safe.
    passthrough: Annotated[list[PassthroughSpec], Field(max_length=MAX_PASSTHROUGH)] = Field(
        default_factory=list
    )
    # Comment lines, keyed by lowercase "class.name" ("circuit" for the
    # file's header), written above that element on export.
    comments: Annotated[
        dict[str, Annotated[str, Field(max_length=MAX_COMMENT_TEXT)]], Field(max_length=MAX_NODES)
    ] = Field(default_factory=dict)
    # The line-to-line kV bases bus voltages are reported against, as an
    # imported file's `set voltagebases=[...]` gave them. Absent means the
    # compiler derives them from the elements' ratings, which misreads a
    # 240 V single-phase secondary as 240 V line-to-line (1.73 pu).
    voltageBases: Annotated[list[Annotated[float, Field(gt=0)]], Field(max_length=50)] | None = None
    # The coordinate system `geo` and `geometry` are in: "EPSG:4326" (what
    # an imported LatLongCoords file means), another EPSG code, or a
    # proj4/WKT definition. Absent: coordinates with no known place on Earth,
    # drawn on a plain grid.
    crs: Annotated[str, Field(max_length=MAX_CRS_TEXT)] | None = None
    # Absent means the defaults; see Limits.
    limits: Limits | None = None
    study: StudyInfo | None = None
    # Conductors and pole configurations, keyed by name (OpenDSS WireData,
    # CNData, TSData and LineGeometry). A line with a `geometry` param
    # takes its impedance from the geometry instead of a line code.
    wireData: Annotated[dict[str, WireDataSpec], Field(max_length=MAX_LINE_CODES)] = Field(
        default_factory=dict
    )
    lineGeometries: Annotated[dict[str, LineGeometrySpec], Field(max_length=MAX_LINE_CODES)] = (
        Field(default_factory=dict)
    )
    # The audit trail: parameter changes, newest last, capped by the client.
    history: Annotated[list[HistoryEntry], Field(max_length=5000)] = Field(default_factory=list)
    # Inverter volt-var / volt-watt curves, keyed by name (OpenDSS XYCurve).
    xyCurves: Annotated[dict[str, XYCurveSpec], Field(max_length=MAX_CURVES)] = Field(
        default_factory=dict
    )
    # The load conditions studies are run at. Absent means the one implicit
    # level: every load at rated kW on the normal rating.
    loadLevels: Annotated[list[LoadLevel], Field(max_length=50)] | None = None
    # The level the next solve uses (a LoadLevel name); None is rated.
    activeLevel: Annotated[str, Field(max_length=80)] | None = None
    # Alternatives to this base circuit, and which one is being edited and
    # solved. None means the base case.
    scenarios: Annotated[list[Scenario], Field(max_length=200)] | None = None
    activeScenario: Annotated[str, Field(max_length=64)] | None = None
    # Tag names offered on loads (suggestions; a load may carry any tag).
    tagVocabulary: Annotated[
        list[Annotated[str, Field(max_length=80)]], Field(max_length=500)
    ] | None = None
    # Metered-zone load allocations; their factors apply at compile time.
    allocations: Annotated[list[Allocation], Field(max_length=100)] | None = None
    # Saved device sets for the time-current plot.
    tccSets: Annotated[list[TccSet], Field(max_length=100)] | None = None

    @property
    def criteria(self) -> Limits:
        return self.limits or Limits()

    @property
    def elements(self) -> list[CircuitNode]:
        """The nodes that are part of the circuit: everything but the
        annotations (notes and zones)."""
        return [n for n in self.nodes if n.type not in ANNOTATION_TYPES]

    @property
    def level(self) -> LoadLevel:
        """The active load level, or the implicit rated one."""
        if self.activeLevel and self.loadLevels:
            for lvl in self.loadLevels:
                if lvl.name == self.activeLevel:
                    return lvl
        return RATED_LEVEL

    @property
    def scenario(self) -> Scenario | None:
        if self.activeScenario and self.scenarios:
            for sc in self.scenarios:
                if sc.id == self.activeScenario:
                    return sc
        return None


# What every circuit solved before load levels existed.
RATED_LEVEL = LoadLevel(name="Rated", loadmult=1.0, rating="normal")

# The levels a new project is offered. Minimum daytime load at 30 % of
# rated is the usual planning assumption when no measurements exist.
DEFAULT_LOAD_LEVELS: list[LoadLevel] = [
    LoadLevel(name="Peak", loadmult=1.0, rating="normal"),
    LoadLevel(name="Minimum daytime", loadmult=0.3, rating="normal"),
    LoadLevel(name="Emergency peak", loadmult=1.0, rating="emergency"),
]


class Issue(BaseModel):
    severity: Literal["error", "warning"]
    code: str
    message: str
    nodeId: str | None = None
    edgeId: str | None = None


# Handles each node type exposes, by convention shared with the frontend.
# Busbars have dynamic handles (b0..bN); any handle on a busbar is the same
# electrical bus, so the specific id never matters to the backend.
NODE_TERMINALS: dict[str, list[str]] = {
    "vsource": ["t1"],
    "load": ["t1"],
    "transformer": ["t1", "t2"],
    "regulator": ["t1", "t2"],
    "breaker": ["t1", "t2"],
    "fuse": ["t1", "t2"],
    "recloser": ["t1", "t2"],
    "relay": ["t1", "t2"],
    "capacitor": ["t1"],
    "generator": ["t1"],
    "pvsystem": ["t1"],
    "storage": ["t1"],
    # Annotations on the drawing: no terminals, so they join no bus and
    # the compiler, connectivity and validation never see them.
    "note": [],
    # A labelled rectangle behind a group of elements (a substation, a
    # feeder, a service area).
    "zone": [],
}


SWITCH_TYPES = frozenset({"breaker", "fuse", "recloser", "relay"})


def in_service(params: dict) -> bool:
    """False for an element taken out of service (`enabled: false`, an
    imported file's `enabled=no`): it stays on the drawing, but the engine
    never sees it, so nothing flows through it."""
    return params.get("enabled", True) is not False


def conducts(node: CircuitNode) -> bool:
    """Whether a node passes current between its terminals: in service,
    and closed if it is a switch."""
    if not in_service(node.params):
        return False
    return not (node.type in SWITCH_TYPES and not node.params.get("closed", True))


def winding_count(params: dict) -> int:
    """How many windings a transformer's params describe (2 unless a third
    is listed). Anything that is not a list of windings counts as two."""
    windings = params.get("windings")
    if not isinstance(windings, list):
        return 2
    return 3 if len(windings) >= 3 else 2


def node_terminals(node: CircuitNode) -> list[str]:
    """The handles a node exposes. Fixed per type, except a transformer,
    which grows a third terminal (t3) for a tertiary winding. Busbars are
    dynamic and return an empty list, as in NODE_TERMINALS."""
    base = NODE_TERMINALS.get(node.type, [])
    if (
        node.type == "transformer"
        and winding_count(node.params) == 3
        and node.params.get("splitphase") is not True
    ):
        return [*base, "t3"]
    return base
