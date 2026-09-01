"""Compile a Circuit into an ordered list of OpenDSS Text commands.

The same command list backs both /api/solve and /api/export/dss, so what you
export is exactly what was solved.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from .connectivity import ConnectivityResult, sanitize_name, synthesize
from .model import Circuit, Issue

# Fallback ratings so loading % is at least defined; a warning is attached
# whenever these are used.
DEFAULT_LINE_NORMAMPS = 400.0
DEFAULT_BREAKER_NORMAMPS = 600.0

# Shapes above this go to CSV side files (when the caller provides a
# directory): very long inline `mult=(...)` Text commands corrupt the DSS
# parser's heap on Linux builds — they parse fine but segfault the process
# later. 288 points = a 15-minute daily shape, comfortably inline.
MAX_INLINE_SHAPE_PTS = 288

# Element property values are interpolated straight into DSS command text, so
# every free-form string is constrained to a known set. Anything else would be
# appended to the command as extra properties (conn="wye kw=9e9").
CONN_TYPES = frozenset({"wye", "delta"})
DISPATCH_MODES = frozenset({"follow", "default"})
# The full set OpenDSS accepts for Line.units. Must stay the superset the
# importer can emit (importer._UNIT_CODES) -- not linecodes.VALID_UNITS, which
# is the stricter set allowed in the conductor-preset CSV. Kept in sync with
# engine._KM_PER_UNIT by a test.
LINE_UNITS = frozenset({"none", "mi", "kft", "km", "m", "ft", "in", "cm"})


@dataclass
class CompileResult:
    commands: list[str] = field(default_factory=list)
    connectivity: ConnectivityResult | None = None
    # OpenDSS full element name (lowercase, e.g. "line.ln1") -> diagram id
    element_map: dict[str, str] = field(default_factory=dict)
    issues: list[Issue] = field(default_factory=list)
    voltage_bases: list[float] = field(default_factory=list)
    # Side files referenced by the commands (filename -> content); the engine
    # writes them into its shape directory before running the commands.
    aux_files: dict[str, str] = field(default_factory=dict)


def _num(params: dict, key: str, default: float | None = None) -> float | None:
    v = params.get(key, default)
    if v is None or v == "":
        return default
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    # json.loads turns 1e999 into inf, which would reach a command as "inf".
    return f if math.isfinite(f) else default


def _enum(params: dict, key: str, allowed: frozenset[str], default: str) -> str:
    """Allowlisted property value, falling back to the default."""
    v = str(params.get(key, default)).strip().lower()
    return v if v in allowed else default


def _phases(params: dict, default: int = 3) -> int:
    """Phase count clamped to 1-3; a huge value builds a pathological command."""
    n = _num(params, "phases", default) or default
    return min(max(int(n), 1), 3)


def _phase_suffix(phases: int) -> str:
    if phases == 1:
        return ".1"
    if phases == 2:
        return ".1.2"
    return ""  # 3-phase implies .1.2.3


_SUFFIX_RE = re.compile(r"^(\.\d+)+$")


def _bus_suffix(explicit, phases: int) -> str:
    """Explicit node connection (e.g. '.1.2' for a delta spot load, set by
    the .dss importer) when valid, else the default for the phase count."""
    if isinstance(explicit, str) and _SUFFIX_RE.match(explicit):
        return explicit
    return _phase_suffix(phases)


def compile_circuit(circuit: Circuit,
                    shape_dir: Path | None = None) -> CompileResult:
    """Compile to Text commands. With `shape_dir` (the solve path), large
    loadshapes become `mult=(file=...)` references plus aux_files entries;
    without it (the .dss export path), everything stays inline so exports
    remain a single portable file."""
    res = CompileResult()
    conn = synthesize(circuit)
    res.connectivity = conn
    res.issues.extend(conn.issues)

    used_names: dict[str, str] = {}  # "type.name" -> diagram id

    def element_name(kind: str, raw: str | None, fallback: str, ref_id: str) -> str:
        name = sanitize_name(str(raw)) if raw else ""
        if not name:
            name = sanitize_name(fallback) or "el"
        full = f"{kind}.{name}"
        if full in used_names:
            res.issues.append(Issue(
                severity="error", code="duplicate-name",
                message=f"Two elements share the OpenDSS name '{full}' after sanitization.",
                nodeId=ref_id))
        used_names[full] = ref_id
        res.element_map[full] = ref_id
        return name

    kv_bases: set[float] = set()
    cmds: list[str] = []

    vsources = [n for n in circuit.nodes if n.type == "vsource"]
    transformers = [n for n in circuit.nodes if n.type == "transformer"]
    loads = [n for n in circuit.nodes if n.type == "load"]
    breakers = [n for n in circuit.nodes if n.type == "breaker"]
    capacitors = [n for n in circuit.nodes if n.type == "capacitor"]
    generators = [n for n in circuit.nodes if n.type == "generator"]
    pvsystems = [n for n in circuit.nodes if n.type == "pvsystem"]
    storages = [n for n in circuit.nodes if n.type == "storage"]
    line_edges = [e for e in circuit.edges if e.type == "line"]

    if not vsources:
        res.issues.append(Issue(severity="error", code="no-source",
                                message="The circuit needs a source (Vsource) element."))
        return res

    cmds.append("clear")
    cmds.append("set defaultbasefrequency=60")

    # First source defines the circuit; extras become Vsource elements.
    for i, n in enumerate(vsources):
        p = n.params
        basekv = _num(p, "basekv", 12.47) or 12.47
        pu = _num(p, "pu", 1.0)
        phases = _phases(p)
        mvasc3 = _num(p, "mvasc3", 2000.0)
        mvasc1 = _num(p, "mvasc1", 2100.0)
        angle = _num(p, "angle", 0.0)
        bus = conn.node_buses[n.id][0] + _phase_suffix(phases)
        kv_bases.add(basekv)
        if i == 0:
            circuit_name = sanitize_name(circuit.name) or "circuit1"
            cmds.append(
                f"new circuit.{circuit_name} basekv={basekv:g} pu={pu:g} angle={angle:g} "
                f"phases={phases} bus1={bus} mvasc3={mvasc3:g} mvasc1={mvasc1:g}")
            res.element_map["vsource.source"] = n.id
        else:
            name = element_name("vsource", p.get("name"), n.id, n.id)
            cmds.append(
                f"new vsource.{name} basekv={basekv:g} pu={pu:g} angle={angle:g} "
                f"phases={phases} bus1={bus} mvasc3={mvasc3:g} mvasc1={mvasc1:g}")

    # Loadshape library — after `new circuit` (OpenDSS needs an active circuit)
    # and before any element that references a shape.
    shape_names: dict[str, str] = {}
    for key, spec in circuit.loadShapes.items():
        shape = sanitize_name(key) or "shape"
        if shape in shape_names.values():
            res.issues.append(Issue(
                severity="error", code="duplicate-name",
                message=f"Two loadshapes share the OpenDSS name '{shape}' "
                        "after sanitization."))
            continue
        shape_names[key] = shape
        if shape_dir is not None and len(spec.points) > MAX_INLINE_SHAPE_PTS:
            fname = f"shape_{shape}.csv"
            res.aux_files[fname] = "\n".join(f"{float(v):.5g}" for v in spec.points) + "\n"
            cmds.append(f"new loadshape.{shape} npts={len(spec.points)} "
                        f"minterval={spec.intervalMin:g} "
                        f'mult=(file="{shape_dir / fname}")')
        else:
            mult = " ".join(f"{float(v):.5g}" for v in spec.points)
            cmds.append(f"new loadshape.{shape} npts={len(spec.points)} "
                        f"minterval={spec.intervalMin:g} mult=({mult})")

    def shape_ref(p: dict, ref_id: str) -> str:
        """' daily=<n> yearly=<n>' for params.loadshape, or '' when unset.
        The same shape drives both modes; OpenDSS wraps short shapes."""
        raw = p.get("loadshape")
        if not raw:
            return ""
        shape = shape_names.get(str(raw))
        if shape is None:
            res.issues.append(Issue(
                severity="error", code="missing-loadshape",
                message=f"Loadshape '{raw}' is not defined in this circuit.",
                nodeId=ref_id))
            return ""
        return f" daily={shape} yearly={shape}"

    for n in transformers:
        p = n.params
        name = element_name("transformer", p.get("name"), n.id, n.id)
        phases = _phases(p)
        windings = p.get("windings") or [
            {"kv": 115, "kva": 10000, "conn": "delta"},
            {"kv": 12.47, "kva": 10000, "conn": "wye"},
        ]
        buses = conn.node_buses[n.id]
        bus_nodes = p.get("busNodes") or []
        bus_list = ", ".join(
            b + _bus_suffix(bus_nodes[i] if i < len(bus_nodes) else None, phases)
            for i, b in enumerate(buses[: len(windings)]))
        conns = ", ".join(
            _enum(w if isinstance(w, dict) else {}, "conn", CONN_TYPES, "wye")
            for w in windings)
        kvs = ", ".join(f"{float(w.get('kv', 12.47)):g}" for w in windings)
        kvas = ", ".join(f"{float(w.get('kva', 10000)):g}" for w in windings)
        xhl = _num(p, "xhl", 8.0)
        loadloss = _num(p, "pctloadloss", 0.5)
        for w in windings:
            kv_bases.add(float(w.get("kv", 12.47)))
        cmds.append(
            f"new transformer.{name} phases={phases} windings={len(windings)} "
            f"buses=({bus_list}) conns=({conns}) kvs=({kvs}) kvas=({kvas}) "
            f"xhl={xhl:g} %loadloss={loadloss:g}")

    for e in line_edges:
        p = e.params
        name = element_name("line", p.get("name"), e.id, e.id)
        phases = _phases(p)
        b1, b2 = conn.line_buses[e.id]
        sfx1 = _bus_suffix(p.get("nodes1"), phases)
        sfx2 = _bus_suffix(p.get("nodes2"), phases)
        length = _num(p, "length", 1.0)
        units = _enum(p, "units", LINE_UNITS, "km")
        r1 = _num(p, "r1", 0.12)
        x1 = _num(p, "x1", 0.38)
        r0 = _num(p, "r0", 0.4)
        x0 = _num(p, "x0", 1.2)
        normamps = _num(p, "normamps")
        if normamps is None:
            normamps = DEFAULT_LINE_NORMAMPS
            res.issues.append(Issue(
                severity="warning", code="default-rating",
                message=f"Line '{name}' has no normamps; using default "
                        f"{DEFAULT_LINE_NORMAMPS:g} A for loading %.",
                edgeId=e.id))
        cmds.append(
            f"new line.{name} bus1={b1}{sfx1} bus2={b2}{sfx2} phases={phases} "
            f"length={length:g} units={units} r1={r1:g} x1={x1:g} r0={r0:g} x0={x0:g} "
            f"normamps={normamps:g}")

    for n in breakers:
        p = n.params
        name = element_name("line", p.get("name"), n.id, n.id)
        phases = _phases(p)
        b1, b2 = conn.node_buses[n.id]
        sfx = _phase_suffix(phases)
        normamps = _num(p, "normamps", DEFAULT_BREAKER_NORMAMPS)
        cmds.append(
            f"new line.{name} bus1={b1}{sfx} bus2={b2}{sfx} phases={phases} "
            f"switch=yes normamps={normamps:g}")
        if not p.get("closed", True):
            cmds.append(f"open line.{name} term=1")

    for n in loads:
        p = n.params
        name = element_name("load", p.get("name"), n.id, n.id)
        phases = _phases(p)
        bus = conn.node_buses[n.id][0] + _bus_suffix(p.get("busNodes"), phases)
        kv = _num(p, "kv", 12.47) or 12.47
        kw = _num(p, "kw", 100.0)
        pf = _num(p, "pf", 0.95)
        load_conn = _enum(p, "conn", CONN_TYPES, "wye")
        model = int(_num(p, "model", 1) or 1)
        kv_bases.add(kv)
        cmds.append(
            f"new load.{name} bus1={bus} phases={phases} conn={load_conn} "
            f"kv={kv:g} kw={kw:g} pf={pf:g} model={model} vminpu=0.85"
            + shape_ref(p, n.id))

    for n in capacitors:
        p = n.params
        name = element_name("capacitor", p.get("name"), n.id, n.id)
        phases = _phases(p)
        bus = conn.node_buses[n.id][0] + _bus_suffix(p.get("busNodes"), phases)
        kv = _num(p, "kv", 12.47) or 12.47
        kvar = _num(p, "kvar", 600.0)
        cap_conn = _enum(p, "conn", CONN_TYPES, "wye")
        numsteps = min(max(int(_num(p, "numsteps", 1) or 1), 1), 100)
        kv_bases.add(kv)
        cmd = (f"new capacitor.{name} bus1={bus} phases={phases} conn={cap_conn} "
               f"kv={kv:g} kvar={kvar:g}")
        if numsteps > 1:
            cmd += f" numsteps={numsteps}"
        cmds.append(cmd)

    for n in generators:
        p = n.params
        name = element_name("generator", p.get("name"), n.id, n.id)
        phases = _phases(p)
        bus = conn.node_buses[n.id][0] + _bus_suffix(p.get("busNodes"), phases)
        kv = _num(p, "kv", 12.47) or 12.47
        kw = _num(p, "kw", 1000.0)
        pf = _num(p, "pf", 1.0)
        gen_conn = _enum(p, "conn", CONN_TYPES, "wye")
        model = int(_num(p, "model", 1) or 1)
        kv_bases.add(kv)
        cmd = (f"new generator.{name} bus1={bus} phases={phases} conn={gen_conn} "
               f"kv={kv:g} kw={kw:g} pf={pf:g} model={model}")
        if model == 3:  # constant-V (PV) mode holds this voltage setpoint
            vpu = _num(p, "vpu", 1.0)
            cmd += f" vpu={vpu:g}"
        cmds.append(cmd)

    if pvsystems:
        # Canned inverter curves shared by every PV system: power-temperature
        # derating (per °C above 25) and efficiency vs per-unit output.
        cmds.append("new xycurve.pv_pt_default npts=4 xarray=[0 25 75 100] "
                    "yarray=[1.2 1.0 0.8 0.6]")
        cmds.append("new xycurve.pv_eff_default npts=4 xarray=[0.1 0.2 0.4 1.0] "
                    "yarray=[0.86 0.9 0.93 0.97]")
    for n in pvsystems:
        p = n.params
        name = element_name("pvsystem", p.get("name"), n.id, n.id)
        phases = _phases(p)
        bus = conn.node_buses[n.id][0] + _bus_suffix(p.get("busNodes"), phases)
        kv = _num(p, "kv", 12.47) or 12.47
        kva = _num(p, "kva", 500.0)
        pmpp = _num(p, "pmpp", 500.0)
        pf = _num(p, "pf", 1.0)
        irradiance = _num(p, "irradiance", 1.0)
        pv_conn = _enum(p, "conn", CONN_TYPES, "wye")
        kv_bases.add(kv)
        cmds.append(
            f"new pvsystem.{name} bus1={bus} phases={phases} conn={pv_conn} "
            f"kv={kv:g} kva={kva:g} pmpp={pmpp:g} pf={pf:g} "
            f"irradiance={irradiance:g} temperature=25 %cutin=0.1 %cutout=0.1 "
            f"effcurve=pv_eff_default p-tcurve=pv_pt_default"
            + shape_ref(p, n.id))  # shape scales irradiance over time

    for n in storages:
        p = n.params
        name = element_name("storage", p.get("name"), n.id, n.id)
        phases = _phases(p)
        bus = conn.node_buses[n.id][0] + _bus_suffix(p.get("busNodes"), phases)
        kv = _num(p, "kv", 12.47) or 12.47
        kwrated = _num(p, "kwrated", 250.0)
        kwhrated = _num(p, "kwhrated", 1000.0)
        effcharge = _num(p, "effcharge", 95.0)
        effdischarge = _num(p, "effdischarge", 95.0)
        reserve = _num(p, "reserve", 20.0)
        soc = _num(p, "soc", 50.0)
        stg_conn = _enum(p, "conn", CONN_TYPES, "wye")
        dispatch = _enum(p, "dispatch", DISPATCH_MODES, "follow")
        kv_bases.add(kv)
        cmd = (f"new storage.{name} bus1={bus} phases={phases} conn={stg_conn} "
               f"kv={kv:g} kwrated={kwrated:g} kwhrated={kwhrated:g} "
               f"%effcharge={effcharge:g} %effdischarge={effdischarge:g} "
               f"%reserve={reserve:g} %stored={soc:g} dispmode={dispatch}")
        if dispatch == "follow":
            # Shape drives dispatch: positive mult = discharge, negative = charge.
            cmd += shape_ref(p, n.id)
        else:  # "default" mode: triggers compare against the default loadshape
            cmd += (f" %discharge={_num(p, 'pctdischarge', 100.0):g}"
                    f" %charge={_num(p, 'pctcharge', 100.0):g}"
                    f" dischargetrigger={_num(p, 'dischargetrigger', 0.0):g}"
                    f" chargetrigger={_num(p, 'chargetrigger', 0.0):g}")
        cmds.append(cmd)

    for n in circuit.nodes:
        if n.type == "busbar":
            basekv = _num(n.params, "basekv")
            if basekv:
                kv_bases.add(basekv)

    res.voltage_bases = sorted(kv_bases)
    bases = ", ".join(f"{b:g}" for b in res.voltage_bases)
    cmds.append(f"set voltagebases=[{bases}]")
    cmds.append("calcvoltagebases")
    res.commands = cmds
    return res


def export_dss(circuit: Circuit) -> tuple[str, list[Issue]]:
    """Render the .dss file text (without solve directives)."""
    res = compile_circuit(circuit)
    lines = [
        f"// {circuit.name} — exported by opendss-designer",
        "// Compile this file with OpenDSS / OpenDSSDirect, then: solve",
        "",
        *res.commands,
        "",
        "set mode=snapshot",
        "solve",
        "",
    ]
    return "\n".join(lines), res.issues
