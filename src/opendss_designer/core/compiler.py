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
from .model import Circuit, Issue, LineCodeSpec
from .phasing import nodes_for, phase_count

# Fallback ratings so loading % is at least defined; a warning is attached
# whenever these are used.
DEFAULT_LINE_NORMAMPS = 400.0
DEFAULT_BREAKER_NORMAMPS = 600.0
DEFAULT_FUSE_AMPS = 65.0
DEFAULT_RECLOSER_AMPS = 560.0
DEFAULT_RELAY_AMPS = 600.0

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
# Time-current curves built into the OpenDSS engine. Naming a curve it does not
# hold is a hard engine error ("TCC_Curve object not found"), which would take
# the whole solve down, so protective devices may only reference these.
FUSE_CURVES = frozenset({"tlink", "klink"})
RECLOSER_CURVES = frozenset({"a", "d", "tlink", "klink"})
RELAY_CURVES = frozenset({"mod_inv", "very_inv", "ext_inv", "definite"})
# Everything the engine defines for itself, so a user curve cannot shadow one.
ALL_BUILTIN_CURVES = frozenset(
    FUSE_CURVES | RECLOSER_CURVES | RELAY_CURVES | {"uv1547", "ov1547"})


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
    return phase_count(params, default)


def _phase_suffix(phases: int) -> str:
    if phases == 1:
        return ".1"
    if phases == 2:
        return ".1.2"
    return ""  # 3-phase implies .1.2.3


_SUFFIX_RE = re.compile(r"^(\.\d+)+$")


def _lower_triangle(matrix: list[list[float]]) -> str:
    """OpenDSS's matrix syntax: rows separated by '|', lower triangle only,
    since an impedance matrix is symmetric. `[0.35 | 0.16 0.34 | ...]`."""
    rows = []
    for i, row in enumerate(matrix):
        rows.append(" ".join(f"{float(v):.6g}" for v in row[: i + 1]))
    return "[" + " | ".join(rows) + "]"


def _square(matrix, n: int) -> bool:
    return (isinstance(matrix, list) and len(matrix) == n
            and all(isinstance(r, list) and len(r) == n for r in matrix))


def _capacitance(p: dict) -> list[str]:
    """['c1=..', 'c0=..'] when the params carry them. Left out, the engine
    assumes a few nF per unit length, which is not nothing: a jumper the file
    gave c=0 solves visibly differently with the default."""
    return [f"{k}={_num(p, k, 0.0):g}" for k in ("c1", "c0") if _num(p, k) is not None]


def _switch_impedance(p: dict) -> str:
    """' r1=.. x1=.. r0=.. x0=.. length=.. units=..' for a switch that carries
    its own impedance (an imported one), else '' and the engine's switch
    default of (1 + j1) milliohm applies. Emitted after `switch=yes`, which
    is what resets those properties."""
    if _num(p, "r1") is None:
        return ""
    parts = [f"{k}={_num(p, k, 0.0):g}" for k in ("r1", "x1", "r0", "x0")]
    parts += _capacitance(p)
    length = _num(p, "length")
    if length is not None:
        parts.append(f"length={length:g}")
        parts.append(f"units={_enum(p, 'units', LINE_UNITS, 'none')}")
    return " " + " ".join(parts)


def _bus_suffix(explicit, phases: int, phasing=None) -> str:
    """Which nodes this terminal lands on.

    A pinned phasing wins: it is the one of the three the user set in the
    editor, and it has to take effect when they change it. Next comes an
    explicit node connection (e.g. '.1.2' for a delta spot load, or a neutral
    the letters cannot spell) preserved by the .dss importer. Failing both,
    the default for the phase count, which is what every circuit did before
    pinning existed.
    """
    pinned = nodes_for(phasing)
    if pinned:
        return pinned
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
    regulators = [n for n in circuit.nodes if n.type == "regulator"]
    loads = [n for n in circuit.nodes if n.type == "load"]
    breakers = [n for n in circuit.nodes if n.type == "breaker"]
    fuses = [n for n in circuit.nodes if n.type == "fuse"]
    reclosers = [n for n in circuit.nodes if n.type == "recloser"]
    relays = [n for n in circuit.nodes if n.type == "relay"]
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
        bus = conn.node_buses[n.id][0] + _bus_suffix(
            p.get("busNodes"), phases, p.get("phasing"))
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

    # User-defined time-current curves. Emitted before any protective device
    # so a device can name one, and validated here rather than trusted: a curve
    # name the engine does not hold is a hard error that stops the whole solve.
    curve_names: set[str] = set()
    for key, spec in circuit.tccCurves.items():
        curve = sanitize_name(key)
        if not curve:
            continue
        if curve in curve_names or curve in ALL_BUILTIN_CURVES:
            res.issues.append(Issue(
                severity="error", code="duplicate-name",
                message=f"Curve '{curve}' collides with another curve "
                        "(the engine ships ten of its own)."))
            continue
        n = min(len(spec.multiples), len(spec.seconds))
        if n < 2:
            res.issues.append(Issue(
                severity="warning", code="empty-curve",
                message=f"Curve '{curve}' has fewer than 2 points and is ignored."))
            continue
        mult = " ".join(f"{float(v):.5g}" for v in spec.multiples[:n])
        secs = " ".join(f"{float(v):.5g}" for v in spec.seconds[:n])
        curve_names.add(curve)
        cmds.append(f"new tcc_curve.{curve} npts={n} "
                    f"c_array=({mult}) t_array=({secs})")

    # Conductor definitions. Emitted before any line so a line can name one;
    # a line naming a code that is not emitted would be a hard engine error,
    # so line_codes is the set a line may reference. Values are kept only when
    # they make a complete definition; a half-typed code is reported and
    # skipped rather than emitted as a conductor with default impedance.
    line_codes: dict[str, LineCodeSpec] = {}  # sanitized name -> spec
    for key, spec in circuit.lineCodes.items():
        code = sanitize_name(key)
        if not code:
            continue
        if code in line_codes:
            res.issues.append(Issue(
                severity="error", code="duplicate-name",
                message=f"Two line codes share the OpenDSS name '{code}' "
                        "after sanitization."))
            continue
        n = int(spec.nphases) if spec.nphases in (1, 2, 3) else 3
        units = spec.units if spec.units in LINE_UNITS else "km"
        cmd = f"new linecode.{code} nphases={n} units={units}"
        if spec.is_matrix:
            if not (_square(spec.rmatrix, n) and _square(spec.xmatrix, n)):
                res.issues.append(Issue(
                    severity="error", code="bad-linecode",
                    message=f"Line code '{key}' is {n}-phase but its R or X "
                            f"matrix is not {n}x{n}."))
                continue
            cmd += (f" rmatrix={_lower_triangle(spec.rmatrix)}"
                    f" xmatrix={_lower_triangle(spec.xmatrix)}")
            if spec.cmatrix is not None:
                if not _square(spec.cmatrix, n):
                    res.issues.append(Issue(
                        severity="error", code="bad-linecode",
                        message=f"Line code '{key}' has a C matrix that is not {n}x{n}."))
                    continue
                cmd += f" cmatrix={_lower_triangle(spec.cmatrix)}"
        else:
            seq = {k: getattr(spec, k) for k in ("r1", "x1", "r0", "x0")}
            if any(v is None for v in seq.values()):
                res.issues.append(Issue(
                    severity="error", code="bad-linecode",
                    message=f"Line code '{key}' needs either R and X matrices or "
                            "all of r1, x1, r0, x0."))
                continue
            cmd += " " + " ".join(f"{k}={float(v):g}" for k, v in seq.items())
            if spec.c1 is not None:
                cmd += f" c1={float(spec.c1):g}"
            if spec.c0 is not None:
                cmd += f" c0={float(spec.c0):g}"
        if spec.normamps:
            cmd += f" normamps={float(spec.normamps):g}"
        line_codes[code] = spec
        cmds.append(cmd)

    def curve_ref(p: dict, key: str, allowed: frozenset[str], default: str,
                  ref_id: str) -> str:
        """A curve name the engine will certainly hold: one of its built-ins,
        or one this circuit defines above.

        The name goes through the same sanitizing the curve itself did, or a
        curve called "lateral-k" would be emitted as `lateral_k` and every
        device pointing at it would quietly fall back to the default.
        """
        raw = str(p.get(key, default)).strip().lower()
        name = sanitize_name(raw) or default
        if name in allowed or name in curve_names:
            return name
        if raw and raw != default:
            res.issues.append(Issue(
                severity="warning", code="unknown-curve",
                message=f"Curve '{raw}' is not defined in this circuit; "
                        f"using '{default}' instead.",
                nodeId=ref_id))
        return default

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
        # A transformer is a phase boundary: the pin names the phase it taps
        # off the primary, and the secondary is a new bus whose phases start
        # at A again. Carrying the pin through to the low side would strand
        # every default-phased element hanging off it.
        bus_list = ", ".join(
            b + _bus_suffix(bus_nodes[i] if i < len(bus_nodes) else None,
                            phases, p.get("phasing") if i == 0 else None)
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
        # A third winding brings two more leakage reactances. Left blank they
        # take the H-L value, which keeps the unit symmetric rather than
        # falling back on the engine's own (much larger) defaults.
        tertiary = ""
        if len(windings) >= 3:
            tertiary = f" xht={_num(p, 'xht', xhl):g} xlt={_num(p, 'xlt', xhl):g}"
        cmds.append(
            f"new transformer.{name} phases={phases} windings={len(windings)} "
            f"buses=({bus_list}) conns=({conns}) kvs=({kvs}) kvas=({kvas}) "
            f"xhl={xhl:g} %loadloss={loadloss:g}{tertiary}")

    # Regulators: an equal-ratio 2-winding transformer plus the RegControl that
    # moves its taps. They share one name — OpenDSS keeps classes in separate
    # namespaces, and results/issues map through the transformer, which is the
    # power element.
    for n in regulators:
        p = n.params
        name = element_name("transformer", p.get("name"), n.id, n.id)
        phases = _phases(p)
        kv = _num(p, "kv", 12.47) or 12.47
        kva = _num(p, "kva", 5000.0)
        xhl = _num(p, "xhl", 0.01)
        loadloss = _num(p, "pctloadloss", 0.01)
        buses = conn.node_buses[n.id]
        bus_nodes = p.get("busNodes") or []
        # Unlike a transformer, a regulator stays inside one feeder at one
        # voltage, so the pin carries straight through it.
        bus_list = ", ".join(
            b + _bus_suffix(bus_nodes[i] if i < len(bus_nodes) else None,
                            phases, p.get("phasing"))
            for i, b in enumerate(buses[:2]))
        kv_bases.add(kv)
        # One connection for both windings: a regulator is an autotransformer
        # in one phase, wye (line-to-neutral) unless the file said delta.
        reg_conn = _enum(p, "conn", CONN_TYPES, "wye")
        cmds.append(
            f"new transformer.{name} phases={phases} windings=2 "
            f"buses=({bus_list}) conns=({reg_conn}, {reg_conn}) kvs=({kv:g}, {kv:g}) "
            f"kvas=({kva:g}, {kva:g}) xhl={xhl:g} %loadloss={loadloss:g}")
        # PT ratio defaults to whatever turns the regulated winding's nominal
        # voltage into the 120 V control base.
        ptratio = _num(p, "ptratio")
        if ptratio is None or ptratio <= 0:
            ln_volts = kv * 1000.0 / (3 ** 0.5) if phases == 3 else kv * 1000.0
            ptratio = round(ln_volts / 120.0, 2)
        cmds.append(
            f"new regcontrol.{name} transformer={name} winding=2 "
            f"vreg={_num(p, 'vreg', 122.0):g} band={_num(p, 'band', 2.0):g} "
            f"ptratio={ptratio:g} ctprim={_num(p, 'ctprim', 300.0):g} "
            f"R={_num(p, 'r', 0.0):g} X={_num(p, 'x', 0.0):g} "
            f"maxtapchange={int(_num(p, 'maxtapchange', 16.0) or 16)}")

    for e in line_edges:
        p = e.params
        name = element_name("line", p.get("name"), e.id, e.id)
        phases = _phases(p)
        b1, b2 = conn.line_buses[e.id]
        pinned = p.get("phasing")
        sfx1 = _bus_suffix(p.get("nodes1"), phases, pinned)
        sfx2 = _bus_suffix(p.get("nodes2"), phases, pinned)
        length = _num(p, "length", 1.0)
        units = _enum(p, "units", LINE_UNITS, "km")
        # A line either names one of the circuit's line codes or carries its
        # own sequence impedances. Assigning a code sets the line's phase
        # count to the code's, so validation holds the two equal rather than
        # letting the engine quietly resize a lateral.
        code = sanitize_name(str(p.get("linecode") or ""))
        spec = line_codes.get(code)
        if spec is not None:
            impedance = f"linecode={code}"
        else:
            r1 = _num(p, "r1", 0.12)
            x1 = _num(p, "x1", 0.38)
            r0 = _num(p, "r0", 0.4)
            x0 = _num(p, "x0", 1.2)
            impedance = " ".join(
                [f"r1={r1:g} x1={x1:g} r0={r0:g} x0={x0:g}", *_capacitance(p)])
        normamps = _num(p, "normamps")
        rating = ""
        if normamps is not None:
            rating = f" normamps={normamps:g}"
        elif spec is None or not spec.normamps:
            rating = f" normamps={DEFAULT_LINE_NORMAMPS:g}"
            res.issues.append(Issue(
                severity="warning", code="default-rating",
                message=f"Line '{name}' has no normamps; using default "
                        f"{DEFAULT_LINE_NORMAMPS:g} A for loading %.",
                edgeId=e.id))
        cmds.append(
            f"new line.{name} bus1={b1}{sfx1} bus2={b2}{sfx2} phases={phases} "
            f"{impedance} length={length:g} units={units}{rating}")

    for n in breakers:
        p = n.params
        name = element_name("line", p.get("name"), n.id, n.id)
        phases = _phases(p)
        b1, b2 = conn.node_buses[n.id]
        sfx = _bus_suffix(p.get("busNodes"), phases, p.get("phasing"))
        normamps = _num(p, "normamps", DEFAULT_BREAKER_NORMAMPS)
        cmds.append(
            f"new line.{name} bus1={b1}{sfx} bus2={b2}{sfx} phases={phases} "
            f"switch=yes{_switch_impedance(p)} normamps={normamps:g}")
        if not p.get("closed", True):
            cmds.append(f"open line.{name} term=1")

    # Protective devices. Each is a switch (the power element the diagram wires
    # into, and what results map to) plus the control object that watches it.
    # The control only operates in fault and time-domain studies; in a snapshot
    # these are a closed switch with a rating.
    def protective_switch(n, default_amps: float) -> tuple[str, dict]:
        p = n.params
        name = element_name("line", p.get("name"), n.id, n.id)
        phases = _phases(p)
        b1, b2 = conn.node_buses[n.id]
        # Both terminals alike: a switch sits inside one lateral, so a device
        # in a pinned lateral has to stay on that phase or it islands the tail.
        sfx = _bus_suffix(p.get("busNodes"), phases, p.get("phasing"))
        normamps = _num(p, "normamps", default_amps)
        cmds.append(
            f"new line.{name} bus1={b1}{sfx} bus2={b2}{sfx} phases={phases} "
            f"switch=yes{_switch_impedance(p)} normamps={normamps:g}")
        return name, p

    def out_of_service(kind: str, name: str, p: dict) -> None:
        """A blown fuse or an open recloser: the control stands down and its
        switch is open.

        Order matters, and only this order works. Opening the switch alone is
        undone when the solve resets the control, and disabling the control
        after opening re-closes it; disabling first and then opening holds.
        The obvious alternative -- `action=open` on the control -- does hold,
        but aborts the process on the Linux build of the engine.
        """
        if p.get("closed", True):
            return
        cmds.append(f"disable {kind}.{name}")
        cmds.append(f"open line.{name} term=1")

    def monitors(name: str) -> str:
        return (f"monitoredobj=line.{name} monitoredterm=1 "
                f"switchedobj=line.{name} switchedterm=1")

    for n in fuses:
        name, p = protective_switch(n, DEFAULT_FUSE_AMPS)
        cmds.append(
            f"new fuse.{name} {monitors(name)} "
            f"fusecurve={curve_ref(p, 'fusecurve', FUSE_CURVES, 'tlink', n.id)} "
            f"ratedcurrent={_num(p, 'ratedcurrent', DEFAULT_FUSE_AMPS):g} "
            f"delay={_num(p, 'delay', 0.0):g}")
        out_of_service("fuse", name, p)

    for n in reclosers:
        name, p = protective_switch(n, DEFAULT_RECLOSER_AMPS)
        cmd = (f"new recloser.{name} {monitors(name)} "
               f"phasefast={curve_ref(p, 'phasefast', RECLOSER_CURVES, 'a', n.id)} "
               f"phasedelayed={curve_ref(p, 'phasedelayed', RECLOSER_CURVES, 'd', n.id)} "
               f"phasetrip={_num(p, 'phasetrip', 100.0):g} "
               # Emitted whether or not a ground unit exists: it is the user's
               # setting, and losing it on a round trip would be silent.
               f"groundtrip={_num(p, 'groundtrip', 50.0):g} "
               f"numfast={int(_num(p, 'numfast', 1.0) or 1)} "
               f"shots={int(_num(p, 'shots', 4.0) or 4)} "
               f"delay={_num(p, 'delay', 0.0):g}")
        # A recloser only has a ground unit if it is given curves for one, the
        # same as a relay; the trip setting alone does nothing.
        gfast = curve_ref(p, "groundfast", RECLOSER_CURVES | {"none"}, "none", n.id)
        gdelayed = curve_ref(p, "grounddelayed", RECLOSER_CURVES | {"none"}, "none", n.id)
        if gfast != "none" or gdelayed != "none":
            cmd += (f" groundfast={gfast if gfast != 'none' else gdelayed} "
                    f"grounddelayed={gdelayed if gdelayed != 'none' else gfast}")
        cmds.append(cmd)
        out_of_service("recloser", name, p)

    for n in relays:
        name, p = protective_switch(n, DEFAULT_RELAY_AMPS)
        cmd = (f"new relay.{name} {monitors(name)} type=current "
               f"phasecurve={curve_ref(p, 'phasecurve', RELAY_CURVES, 'very_inv', n.id)} "
               f"phasetrip={_num(p, 'phasetrip', 200.0):g} "
               f"delay={_num(p, 'delay', 0.0):g}")
        # No ground curve means no ground unit at all, which is a different
        # relay from one with a ground unit picked up at some default.
        ground = curve_ref(p, "groundcurve", RELAY_CURVES | {"none"}, "none", n.id)
        if ground != "none":
            cmd += (f" groundcurve={ground} "
                    f"groundtrip={_num(p, 'groundtrip', 50.0):g}")
        cmds.append(cmd)
        out_of_service("relay", name, p)

    for n in loads:
        p = n.params
        name = element_name("load", p.get("name"), n.id, n.id)
        phases = _phases(p)
        bus = conn.node_buses[n.id][0] + _bus_suffix(
            p.get("busNodes"), phases, p.get("phasing"))
        kv = _num(p, "kv", 12.47) or 12.47
        kw = _num(p, "kw", 100.0)
        pf = _num(p, "pf", 0.95)
        load_conn = _enum(p, "conn", CONN_TYPES, "wye")
        model = int(_num(p, "model", 1) or 1)
        # A drawn load keeps the forgiving 0.85 floor so a sketch with a
        # sagging bus still converges; an imported one carries its file's.
        vminpu = _num(p, "vminpu", 0.85)
        kv_bases.add(kv)
        cmds.append(
            f"new load.{name} bus1={bus} phases={phases} conn={load_conn} "
            f"kv={kv:g} kw={kw:g} pf={pf:g} model={model} vminpu={vminpu:g}"
            + shape_ref(p, n.id))

    for n in capacitors:
        p = n.params
        name = element_name("capacitor", p.get("name"), n.id, n.id)
        phases = _phases(p)
        bus = conn.node_buses[n.id][0] + _bus_suffix(
            p.get("busNodes"), phases, p.get("phasing"))
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
        bus = conn.node_buses[n.id][0] + _bus_suffix(
            p.get("busNodes"), phases, p.get("phasing"))
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
        bus = conn.node_buses[n.id][0] + _bus_suffix(
            p.get("busNodes"), phases, p.get("phasing"))
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
        bus = conn.node_buses[n.id][0] + _bus_suffix(
            p.get("busNodes"), phases, p.get("phasing"))
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
