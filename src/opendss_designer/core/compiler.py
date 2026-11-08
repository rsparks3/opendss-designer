"""Compile a Circuit into an ordered list of OpenDSS Text commands.

The same command list backs both /api/solve and /api/export/dss, so what you
export is exactly what was solved.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import passthrough
from .connectivity import (
    BUSBAR_CANON_HANDLE,
    ConnectivityResult,
    sanitize_name,
    synthesize,
    terminal_key,
)
from .model import ANNOTATION_TYPES, Circuit, Issue, LineCodeSpec, LineGeometrySpec, in_service
from .phasing import nodes_for, phase_count
from .scenarios import apply_scenario

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
# CapControl types (OpenDSS `type=`) a capacitor's `control` param may name.
CAPCONTROL_TYPES = frozenset({"voltage", "current", "kvar", "pf", "time"})
# Smart-inverter functions (OpenDSS InvControl `mode=` / `combimode=`) a PV
# system's or storage unit's `invmode` param may name, with the curve params
# each one reads. "voltvar_voltwatt" is the engine's VV_VW combination.
INVCONTROL_MODES: dict[str, tuple[str, ...]] = {
    "voltvar": ("vvcurve",),
    "voltwatt": ("vwcurve",),
    "voltvar_voltwatt": ("vvcurve", "vwcurve"),
    "wattpf": ("wpcurve",),
    "wattvar": ("wvcurve",),
}
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
    # Passthrough lines: the engine runs them, but one it rejects is left
    # out with a warning instead of failing the whole circuit.
    optional_commands: set[str] = field(default_factory=set)
    # Lowercase class.name of each passthrough element that runs.
    passthrough_names: list[str] = field(default_factory=list)


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


def _reliability(p: dict) -> str:
    """` faultrate=.. pctperm=.. repair=..` for whichever of the three a
    power-delivery element carries; the engine's defaults (0.1 per year, or
    per unit length for a line; 20 % permanent; 3 h) stand otherwise."""
    out = ""
    for key in ("faultrate", "pctperm", "repair"):
        v = _num(p, key)
        if v is not None and v >= 0:
            out += f" {key}={v:g}"
    return out


def _emergency(p: dict, kind: str) -> str:
    """` emergamps=..` (lines and switches) or ` emerghkva=..` (transformers
    and regulators) when the element carries an emergency rating; the
    engine's own default (1.5 x normal) stands otherwise. The active load
    level says which rating loading is judged against."""
    key = "emerghkva" if kind in ("transformer", "regulator") else "emergamps"
    v = _num(p, key)
    return f" {key}={v:g}" if v is not None and v > 0 else ""


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


def _series_reactor(e, conn: ConnectivityResult, element_name, cmds: list[str]) -> None:
    """A line edge marked `reactor`: a series Reactor between two buses, in
    ohms. EPRI's ckt5 and the IEEE 8500-node feeder join the source to the
    substation through one; drawn as a line, the feeder stays connected on
    the drawing, and it is written back as the Reactor it was."""
    p = e.params
    name = element_name("reactor", p.get("name"), e.id, e.id)
    phases = _phases(p)
    b1, b2 = conn.line_buses[e.id]
    pinned = p.get("phasing")
    sfx1 = _bus_suffix(p.get("nodes1"), phases, pinned)
    sfx2 = _bus_suffix(p.get("nodes2"), phases, pinned)
    r = _num(p, "r", 0.0) or 0.0
    x = _num(p, "x", 0.001) or 0.0
    normamps = _num(p, "normamps")
    rating = f" normamps={normamps:g}" if normamps else ""
    cmds.append(f"new reactor.{name} bus1={b1}{sfx1} bus2={b2}{sfx2} phases={phases} "
                f"r={r:.10g} x={x:.10g}{rating}")


def _winding_resistance(windings: list, loadloss: float) -> str:
    """`%loadloss`, which the engine splits equally between the windings --
    unless every winding names its own `%r` and they differ. A centre-tapped
    service transformer has a primary at half the resistance of each 120 V
    half (the IEEE 8500-node feeder's are 0.6/1.2/1.2)."""
    rs = []
    for w in windings:
        v = w.get("pctr") if isinstance(w, dict) else None
        if not isinstance(v, (int, float)) or v < 0:
            return f"%loadloss={loadloss:g}"
        rs.append(float(v))
    return "%rs=(" + ", ".join(f"{r:g}" for r in rs) + ")"


def _split_phase_transformer(n, name: str, windings: list, buses: list[str], p: dict,
                             kv_bases: set[float], cmds: list[str]) -> None:
    """A 120/240 V centre-tapped service transformer: the engine's
    single-phase three-winding form, primary on one phase, the two
    secondary half-windings between leg 1 and the centre tap and the
    centre tap and leg 2 (`lv.1.0` and `lv.0.2`). Kersting's interlaced
    model splits the impedance as Z_H = 0.5R + j0.8X and Z_L1 = Z_L2 =
    R + j0.4X, which gives XHL = XHT = 1.2X, XLT = 0.8X and %r of
    [0.5R, R, R]. Downstream, a 120 V load pins to A (leg 1) or B (leg 2)
    and a 240 V load takes both."""
    hv = windings[0] if windings else {"kv": 7.2, "kva": 25, "conn": "wye"}
    lv = windings[1] if len(windings) > 1 else {"kv": 0.12, "kva": hv.get("kva", 25), "conn": "wye"}
    kv_hv = float(hv.get("kv", 7.2))
    kva = float(hv.get("kva", 25))
    kv_lv = float(lv.get("kv", 0.12))
    # The secondary winding is rated per half (120 V); a file that says 0.24
    # means the whole 240 V secondary.
    if kv_lv > 0.2:
        kv_lv = kv_lv / 2
    x = _num(p, "xhl", 2.0)
    r_total = _num(p, "pctloadloss", 1.2)
    hv_sfx = _bus_suffix(p.get("busNodes", [None])[0] if isinstance(p.get("busNodes"), list) and p.get("busNodes") else None,
                         1, p.get("phasing"))
    hv_conn = _enum(hv if isinstance(hv, dict) else {}, "conn", CONN_TYPES, "wye")
    kv_bases.add(kv_hv if hv_conn == "delta" else round(kv_hv * 3 ** 0.5, 6))
    kv_bases.add(0.208)  # 120 V line-to-neutral on the engine's base scale
    cmds.append(
        f"new transformer.{name} phases=1 windings=3 "
        f"buses=({buses[0]}{hv_sfx}, {buses[1]}.1.0, {buses[1]}.0.2) "
        f"conns=({hv_conn}, wye, wye) kvs=({kv_hv:g}, {kv_lv:g}, {kv_lv:g}) "
        f"kvas=({kva:g}, {kva:g}, {kva:g}) "
        f"xhl={1.2 * x:.6g} xht={1.2 * x:.6g} xlt={0.8 * x:.6g} "
        f"%rs=({0.5 * r_total:.6g}, {r_total:.6g}, {r_total:.6g})"
        f"{_core_losses(p)}{_reliability(p)}{_emergency(p, 'transformer')}")


def _regulator_reverse(p: dict) -> str:
    """How the control behaves when power flows backwards through it (a
    feeder tie closed, or DER past it exporting). Off, the engine's
    default, holds the forward settings regardless; `reversible` switches
    to the reverse setpoint and band; `cogen` holds the forward side for
    reverse flow from generation, which is what a DER-rich feeder wants."""
    out = ""
    if p.get("reversible") is True:
        out += " reversible=yes"
        for key in ("revvreg", "revband"):
            v = _num(p, key)
            if v is not None and v > 0:
                out += f" {key}={v:g}"
    if p.get("cogen") is True:
        out += " cogen=yes"
    return out


def _cap_control(n, name: str, res: "CompileResult", cmds: list[str]) -> None:
    """The CapControl of a switched bank, emitted under the capacitor's own
    name. It watches `ctrlElement` -- a line, transformer or switch on the
    drawing (by diagram id), or the capacitor itself -- and switches on the
    control type's quantity: voltage (on below, off above, volts on the PT
    secondary), current or kvar through the element (on above, off below),
    power factor, or time of day."""
    p = n.params
    ctype = str(p.get("control") or "none").strip().lower()
    if ctype not in CAPCONTROL_TYPES:
        return
    target = p.get("ctrlElement")
    element = f"capacitor.{name}"
    if target and target != "self":
        full = next((f for f, ref in res.element_map.items()
                     if ref == target and f.split(".", 1)[0] in ("line", "transformer")), None)
        if full is None:
            res.issues.append(Issue(
                severity="warning", code="capcontrol-element",
                message=f"Capacitor '{name}': the element its control watches is not "
                        "on the drawing; it watches its own terminal instead.",
                nodeId=n.id))
        else:
            element = full
    defaults = {
        "voltage": (118.0, 126.0), "current": (300.0, 200.0),
        "kvar": (600.0, 300.0), "pf": (0.95, 1.05), "time": (10.0, 18.0),
    }
    on_default, off_default = defaults[ctype]
    terminal = int(_num(p, "ctrlTerminal", 1.0) or 1)
    cmd = (f"new capcontrol.{name} capacitor={name} element={element} "
           f"terminal={min(max(terminal, 1), 2)} type={ctype} "
           f"onsetting={_num(p, 'onsetting', on_default):g} "
           f"offsetting={_num(p, 'offsetting', off_default):g} "
           f"delay={_num(p, 'delay', 15.0):g} delayoff={_num(p, 'delayoff', 15.0):g} "
           f"deadtime={_num(p, 'deadtime', 300.0):g}")
    for key, prop in (("ptratio", "ptratio"), ("ctratio", "ctratio")):
        v = _num(p, key)
        if v is not None and v > 0:
            cmd += f" {prop}={v:g}"
    cmds.append(cmd)


def _inv_controls(units: list[tuple[str, str, dict, str]], xy_names: set[str],
                  res: "CompileResult", cmds: list[str]) -> None:
    """One InvControl per distinct smart-inverter setting, listing every PV
    system and storage unit that shares it (the engine wants groups, not a
    control per unit). `units` holds (class, name, params, diagram id)."""
    groups: dict[tuple, list[str]] = {}
    for cls, name, p, ref in units:
        mode = str(p.get("invmode") or "none").strip().lower()
        curve_keys = INVCONTROL_MODES.get(mode)
        if not curve_keys:
            continue
        curves: list[str] = []
        ok = True
        for key in curve_keys:
            curve = sanitize_name(str(p.get(key) or ""))
            if curve not in xy_names:
                res.issues.append(Issue(
                    severity="warning", code="unknown-curve",
                    message=f"{cls.capitalize()} '{name}': its {mode.replace('_', ' + ')} "
                            f"control needs an XY curve for '{key}' that this circuit "
                            "does not define; the control is left out.",
                    nodeId=ref))
                ok = False
                break
            curves.append(curve)
        if ok:
            groups.setdefault((mode, *curves), []).append(f"{cls}.{name}")
    for i, ((mode, *curves), members) in enumerate(groups.items(), start=1):
        derlist = " ".join(members)
        cmd = f"new invcontrol.inv{i} derlist=[{derlist}]"
        if mode == "voltvar":
            cmd += f" mode=voltvar vvc_curve1={curves[0]} voltage_curvex_ref=rated"
        elif mode == "voltwatt":
            cmd += f" mode=voltwatt voltwatt_curve={curves[0]} voltwattyaxis=pmpppu"
        elif mode == "voltvar_voltwatt":
            cmd += (f" combimode=vv_vw vvc_curve1={curves[0]} voltwatt_curve={curves[1]} "
                    "voltage_curvex_ref=rated voltwattyaxis=pmpppu")
        elif mode == "wattpf":
            cmd += f" mode=wattpf wattpf_curve={curves[0]}"
        elif mode == "wattvar":
            cmd += f" mode=wattvar wattvar_curve={curves[0]}"
        # Damped, tolerant iteration: the engine's own recommended values
        # for a converging volt-var loop on a feeder with several units.
        cmd += " deltaq_factor=0.2 varchangetolerance=0.025 voltagechangetolerance=0.0001"
        cmds.append(cmd)


def _bus_coordinates(circuit: Circuit, conn: ConnectivityResult) -> list[str]:
    """Each bus's coordinates as `SetBusXY`, which keeps an exported file one
    file: BusCoords and LatLongCoords both need a companion. Export only --
    a solve does not use them. Written after the buses exist."""
    out: list[str] = []
    seen: set[str] = set()
    for n in circuit.nodes:
        if n.type != "busbar" or n.geo is None:
            continue
        bus = conn.terminal_bus.get(terminal_key(n.id, BUSBAR_CANON_HANDLE))
        if bus and bus not in seen:
            seen.add(bus)
            out.append(f"setbusxy bus={bus} x={n.geo.x:.10g} y={n.geo.y:.10g}")
    return out


def _core_losses(p: dict) -> str:
    """No-load loss and magnetising current, when set. Each is small, but a
    feeder has thousands of service transformers: EPRI's ckt24 draws 420
    kvar of magnetising current through its head."""
    out = ""
    for key, prop in (("pctnoloadloss", "%noloadloss"), ("pctimag", "%imag")):
        v = _num(p, key)
        if v is not None and v > 0:
            out += f" {prop}={v:g}"
    return out


def _taps(windings: list) -> str:
    """Off-nominal winding taps, when any winding has one."""
    taps = []
    for w in windings:
        try:
            taps.append(float(w.get("tap", 1.0)) if isinstance(w, dict) else 1.0)
        except (TypeError, ValueError):
            taps.append(1.0)
    if all(abs(t - 1.0) < 1e-9 for t in taps):
        return ""
    return " taps=(" + ", ".join(f"{t:g}" for t in taps) + ")"


def _load_model_extras(p: dict, model: int) -> str:
    """What the voltage-dependent load models need beyond their number: the
    CVR exponents of model 4 and the seven ZIP fractions of model 8. A real
    feeder's loads are usually CVR loads, and the engine's default exponents
    (1 and 2) put EPRI's ckt7 five per cent light at the head."""
    out = ""
    if model == 4:
        for key in ("cvrwatts", "cvrvars"):
            v = _num(p, key)
            if v is not None:
                out += f" {key}={v:g}"
    elif model == 8:
        zipv = p.get("zipv")
        if isinstance(zipv, list) and len(zipv) == 7:
            try:
                out += " zipv=[" + " ".join(f"{float(v):g}" for v in zipv) + "]"
            except (TypeError, ValueError):
                pass
    return out


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
                    shape_dir: Path | None = None,
                    export: bool = False) -> CompileResult:
    """Compile to Text commands. With `shape_dir` (the solve path), large
    loadshapes become `mult=(file=...)` references plus aux_files entries;
    without it (the .dss export path), everything stays inline so exports
    remain a single portable file. `export` writes every passthrough
    element, the ones a solve would leave out included (commented out when
    they refer to something that is gone)."""
    res = CompileResult()
    # The active scenario's deltas, so every caller -- solve, fault study,
    # time series, export -- sees the effective circuit.
    circuit = apply_scenario(circuit, circuit.scenario)
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
        # The source's X/R, when the file said: strength alone leaves the
        # engine to assume 4, and EPRI's ckt7 source is 12 -- a 115 kV
        # source three times too resistive drops the feeder 0.027 pu.
        # Written first: the short-circuit values then build the impedance.
        ratios = "".join(
            f" {key}={v:g}" for key in ("x1r1", "x0r0")
            if (v := _num(p, key)) is not None and v > 0)
        if i == 0:
            circuit_name = sanitize_name(circuit.name) or "circuit1"
            cmds.append(
                f"new circuit.{circuit_name} basekv={basekv:g} pu={pu:g} angle={angle:g} "
                f"phases={phases} bus1={bus}{ratios} mvasc3={mvasc3:g} mvasc1={mvasc1:g}")
            res.element_map["vsource.source"] = n.id
        else:
            name = element_name("vsource", p.get("name"), n.id, n.id)
            cmds.append(
                f"new vsource.{name} basekv={basekv:g} pu={pu:g} angle={angle:g} "
                f"phases={phases} bus1={bus}{ratios} mvasc3={mvasc3:g} mvasc1={mvasc1:g}")

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

    # Inverter volt-var / volt-watt curves (XYCurve), before the PV and
    # storage units whose InvControl names them. A reference to a curve not
    # emitted here is a hard engine error, so xy_names is the set a unit may
    # name.
    xy_names: set[str] = set()
    for key, spec in circuit.xyCurves.items():
        curve = sanitize_name(key)
        if not curve:
            continue
        if curve in xy_names or curve in ("pv_pt_default", "pv_eff_default"):
            res.issues.append(Issue(
                severity="error", code="duplicate-name",
                message=f"XY curve '{curve}' collides with another curve."))
            continue
        n = min(len(spec.x), len(spec.y))
        if n < 2:
            res.issues.append(Issue(
                severity="warning", code="empty-curve",
                message=f"XY curve '{curve}' has fewer than 2 points and is ignored."))
            continue
        xs = " ".join(f"{float(v):.6g}" for v in spec.x[:n])
        ys = " ".join(f"{float(v):.6g}" for v in spec.y[:n])
        xy_names.add(curve)
        cmds.append(f"new xycurve.{curve} npts={n} xarray=[{xs}] yarray=[{ys}]")

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

    # Conductors and the pole configurations that hang them. A geometry names
    # wires, a line names a geometry, so the order is wires, geometries, lines.
    wire_kind: dict[str, str] = {}
    for key, spec in circuit.wireData.items():
        wname = sanitize_name(key)
        if not wname or wname in wire_kind:
            if wname:
                res.issues.append(Issue(severity="error", code="duplicate-name",
                                        message=f"Two conductors share the name '{wname}'."))
            continue
        cls = {"wire": "wiredata", "cn": "cndata", "ts": "tsdata"}[spec.kind]
        parts = [f"new {cls}.{wname}"]
        for prop, value in (("rdc", spec.rdc), ("rac", spec.rac), ("gmrac", spec.gmr),
                            ("radius", spec.radius), ("normamps", spec.normamps),
                            ("emergamps", spec.emergamps)):
            if value is not None and value > 0:
                parts.append(f"{prop}={value:.6g}")
        if spec.rdc is None and spec.rac is None:
            res.issues.append(Issue(severity="warning", code="bad-wire",
                                    message=f"Conductor '{key}' has no resistance; the engine's default is used."))
        parts.append(f"runits={_enum({'u': spec.runits}, 'u', LINE_UNITS, 'mi')}")
        parts.append(f"gmrunits={_enum({'u': spec.gmrunits}, 'u', LINE_UNITS, 'ft')}")
        parts.append(f"radunits={_enum({'u': spec.radunits}, 'u', LINE_UNITS, 'in')}")
        for prop, value in spec.extra.items():
            if re.fullmatch(r"[a-z]+", str(prop)) and isinstance(value, (int, float)):
                parts.append(f"{prop}={float(value):.6g}")
        wire_kind[wname] = spec.kind
        cmds.append(" ".join(parts))
    geometries: set[str] = set()
    for key, spec in circuit.lineGeometries.items():
        gname = sanitize_name(key)
        if not gname or gname in geometries:
            continue
        conds = spec.conductors[: max(1, int(spec.nconds))]
        if len(conds) < int(spec.nconds) or any(sanitize_name(c.wire) not in wire_kind for c in conds):
            res.issues.append(Issue(severity="error", code="bad-geometry",
                                    message=f"Geometry '{key}' needs {spec.nconds} conductors, each naming a "
                                            "conductor the circuit defines."))
            continue
        units = _enum({'u': spec.units}, 'u', LINE_UNITS, 'ft')
        cmd = (f"new linegeometry.{gname} nconds={int(spec.nconds)} nphases={int(spec.nphases)} "
               f"reduce={'yes' if spec.reduce else 'no'}")
        for i, c in enumerate(conds, start=1):
            w = sanitize_name(c.wire)
            keyword = {"wire": "wire", "cn": "cncable", "ts": "tscable"}[wire_kind[w]]
            cmd += f" cond={i} {keyword}={w} x={c.x:.6g} h={c.h:.6g} units={units}"
        geometries.add(gname)
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
        if p.get("splitphase") is True and len(buses) >= 2:
            _split_phase_transformer(n, name, windings, buses, p, kv_bases, cmds)
            continue
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
            f"xhl={xhl:g} {_winding_resistance(windings, loadloss)}{tertiary}"
            f"{_core_losses(p)}{_taps(windings)}{_reliability(p)}{_emergency(p, 'transformer')}")

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
            f"kvas=({kva:g}, {kva:g}) xhl={xhl:g} %loadloss={loadloss:g}{_reliability(p)}"
            f"{_emergency(p, 'regulator')}")
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
            f"maxtapchange={int(_num(p, 'maxtapchange', 16.0) or 16)}"
            + _regulator_reverse(p))

    for e in line_edges:
        p = e.params
        if p.get("reactor") is True:
            _series_reactor(e, conn, element_name, cmds)
            continue
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
        geometry = sanitize_name(str(p.get("geometry") or ""))
        if geometry and geometry in geometries:
            impedance = f"geometry={geometry}"
            spec = None
        elif geometry:
            res.issues.append(Issue(
                severity="error", code="bad-geometry",
                message=f"Line '{name}' is on geometry '{geometry}', which this circuit does not define.",
                edgeId=e.id))
            impedance = f"linecode={code}" if spec is not None else "r1=0.12 x1=0.38 r0=0.4 x0=1.2"
        elif spec is not None:
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
        elif geometry and geometry in geometries:
            pass  # the geometry's conductors carry their ampacity
        elif spec is None or not spec.normamps:
            rating = f" normamps={DEFAULT_LINE_NORMAMPS:g}"
            res.issues.append(Issue(
                severity="warning", code="default-rating",
                message=f"Line '{name}' has no normamps; using default "
                        f"{DEFAULT_LINE_NORMAMPS:g} A for loading %.",
                edgeId=e.id))
        cmds.append(
            f"new line.{name} bus1={b1}{sfx1} bus2={b2}{sfx2} phases={phases} "
            f"{impedance} length={length:g} units={units}{rating}{_reliability(p)}"
            f"{_emergency(p, 'line')}")

    for n in breakers:
        p = n.params
        name = element_name("line", p.get("name"), n.id, n.id)
        phases = _phases(p)
        b1, b2 = conn.node_buses[n.id]
        sfx = _bus_suffix(p.get("busNodes"), phases, p.get("phasing"))
        normamps = _num(p, "normamps", DEFAULT_BREAKER_NORMAMPS)
        cmds.append(
            f"new line.{name} bus1={b1}{sfx} bus2={b2}{sfx} phases={phases} "
            f"switch=yes{_switch_impedance(p)} normamps={normamps:g}{_reliability(p)}"
            f"{_emergency(p, 'line')}")
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
            f"switch=yes{_switch_impedance(p)} normamps={normamps:g}{_reliability(p)}"
            f"{_emergency(p, 'line')}")
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

    level = circuit.level
    for n in loads:
        p = n.params
        name = element_name("load", p.get("name"), n.id, n.id)
        phases = _phases(p)
        bus = conn.node_buses[n.id][0] + _bus_suffix(
            p.get("busNodes"), phases, p.get("phasing"))
        kv = _num(p, "kv", 12.47) or 12.47
        kw = _num(p, "kw", 100.0)
        # A load level may scale one class of load (the load's `class`
        # param) on top of the global multiplier applied below.
        load_class = str(p.get("class") or "").strip().lower()
        class_mult = next((m for c, m in level.classMult.items()
                           if c.strip().lower() == load_class), None)
        if load_class and class_mult is not None:
            kw = kw * class_mult
        pf = _num(p, "pf", 0.95)
        load_conn = _enum(p, "conn", CONN_TYPES, "wye")
        model = int(_num(p, "model", 1) or 1)
        # A drawn load keeps the forgiving 0.85 floor so a sketch with a
        # sagging bus still converges; an imported one carries its file's.
        vminpu = _num(p, "vminpu", 0.85)
        kv_bases.add(kv)
        # Customers served, for the reliability indices; the engine's
        # default is one per load.
        numcust = _num(p, "numcust")
        customers = f" numcust={int(numcust)}" if numcust is not None and numcust >= 0 else ""
        cmds.append(
            f"new load.{name} bus1={bus} phases={phases} conn={load_conn} "
            f"kv={kv:g} kw={kw:g} pf={pf:g} model={model} vminpu={vminpu:g}"
            + customers + _load_model_extras(p, model) + shape_ref(p, n.id))

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
        _cap_control(n, name, res, cmds)

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
        # The machine's rating, which its loading is judged against. Left
        # blank the engine takes 1.2 x kW, as OpenDSS always has.
        kva = _num(p, "kva")
        if kva is not None and kva > 0:
            cmd += f" kva={kva:g}"
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
    inverter_units: list[tuple[str, str, dict, str]] = []
    for n in pvsystems:
        p = n.params
        name = element_name("pvsystem", p.get("name"), n.id, n.id)
        inverter_units.append(("pvsystem", name, p, n.id))
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
        inverter_units.append(("storage", name, p, n.id))
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

    _inv_controls(inverter_units, xy_names, res, cmds)

    # Out of service: defined, so the file still says what is there, then
    # disabled -- every object emitted under the element's name, so a fuse
    # takes its control with it. An imported open tie arrives this way.
    off = {n.id: n.type for n in circuit.nodes if not in_service(n.params)}
    off |= {e.id: "line" for e in circuit.edges if e.type == "line" and not in_service(e.params)}
    for full, ref in res.element_map.items():
        kind = off.get(ref)
        if kind is None:
            continue
        name = full.split(".", 1)[1]
        # The control first: one left watching a disabled element errors.
        control = "regcontrol" if kind == "regulator" else kind
        if control in ("regcontrol", "fuse", "recloser", "relay"):
            cmds.append(f"disable {control}.{name}")
        cmds.append(f"disable {full}")

    # What the imported file had that the diagram does not: after every
    # modelled element, so their references resolve, in the file's order.
    if circuit.passthrough:
        defined = {c.split()[1].lower() for c in cmds if c.lower().startswith("new ")}
        # `new circuit.x` makes the first source, vsource.source.
        defined.add("vsource.source")
        buses = {b.lower() for bs in conn.node_buses.values() for b in bs}
        checked, pt_issues = passthrough.check(circuit.passthrough, defined, buses)
        res.issues.extend(pt_issues)
        pt_cmds = passthrough.commands(checked, export)
        cmds.extend(pt_cmds)
        res.optional_commands.update(pt_cmds)
        res.passthrough_names = [
            f"{c.cls}.{c.entry.name.split('.', 1)[1].lower()}" for c in checked if c.solvable]

    for n in circuit.nodes:
        if n.type == "busbar":
            basekv = _num(n.params, "basekv")
            if basekv:
                kv_bases.add(basekv)

    # The file's own bases when it gave them: the ones derived from ratings
    # are a guess (a 0.24 kV single-phase rating reads as line-to-line).
    res.voltage_bases = sorted(set(circuit.voltageBases or ()) or kv_bases)
    bases = ", ".join(f"{b:g}" for b in res.voltage_bases)
    # Room to settle. The engine's defaults (15 and 10) are sized for small
    # circuits; the IEEE 8500-node feeder needs more than 15 power-flow
    # iterations, and every regulator and capacitor control in series adds
    # control rounds. A converged answer does not depend on the ceiling.
    cmds.append("set maxiterations=100 maxcontroliter=100")
    cmds.append(f"set voltagebases=[{bases}]")
    cmds.append("calcvoltagebases")
    # The load level: every load scaled together. Rated (1.0) is left
    # unsaid so a circuit drawn before levels existed compiles unchanged.
    if abs(level.loadmult - 1.0) > 1e-12:
        cmds.append(f"set loadmult={level.loadmult:g}  ! load level: {level.name}")
    if export:
        cmds.extend(_bus_coordinates(circuit, conn))
    res.commands = cmds
    return res


def export_dss(circuit: Circuit) -> tuple[str, list[Issue]]:
    """Render the .dss file text (without solve directives). Comments an
    imported file had go back above the elements they described."""
    res = compile_circuit(circuit, export=True)
    notes = {k.lower(): v for k, v in circuit.comments.items()}
    # Notes on the drawing become comments too: one pointing at an element
    # goes above that element, the rest in a block after the header.
    dss_name = {diagram_id: full for full, diagram_id in res.element_map.items()}
    pinned: dict[str, list[str]] = {}
    loose: list[str] = []
    for n in circuit.nodes:
        if n.type != "note":
            continue
        text = _note_comment(n.params.get("text"))
        target = dss_name.get(str(n.params.get("target") or ""))
        if not text:
            continue
        if target:
            pinned.setdefault(target.lower(), []).extend(text)
        else:
            loose.extend(text)
    body: list[str] = []
    for cmd in res.commands:
        m = _NEW_TARGET_RE.match(cmd)
        if m:
            cls = m.group(1).lower()
            key = "circuit" if cls == "circuit" else f"{cls}.{m.group(2).lower()}"
            if key != "circuit" and key in notes:
                body.extend(_as_comment(notes[key]))
            # The first source is the circuit's own Vsource.
            body.extend(pinned.get("vsource.source" if key == "circuit" else key, []))
        body.append(cmd)
    header = _as_comment(notes["circuit"]) + [""] if "circuit" in notes else []
    if loose:
        header += loose + [""]
    zones = _zone_comments(circuit, dss_name)
    if zones:
        header += zones + [""]
    lines = [
        f"// {circuit.name} — exported by opendss-designer",
        "// Compile this file with OpenDSS / OpenDSSDirect, then: solve",
        "",
        *header,
        *body,
        "",
        "set mode=snapshot",
        "solve",
        "",
    ]
    return "\n".join(lines), res.issues


_NEW_TARGET_RE = re.compile(r'^new\s+(?:object\s*=\s*)?"?([A-Za-z_]\w*)\.([^\s"=]+)', re.IGNORECASE)


def _zone_comments(circuit: Circuit, dss_name: dict[str, str]) -> list[str]:
    """One comment per labelled zone, naming the elements drawn inside it
    (a node by its corner, a line by both ends), so the grouping survives
    into the file: "! Zone: Substation A - transformer.t1, line.brk1"."""
    out: list[str] = []
    pos = {n.id: n.position for n in circuit.nodes if n.position is not None}
    for z in circuit.nodes:
        if z.type != "zone" or z.position is None:
            continue
        label = " ".join(str(z.params.get("label") or "").split())
        if not label:
            continue
        box = (z.position.x, z.position.y,
               z.position.x + (z.width or 0), z.position.y + (z.height or 0))

        def inside(node_id: str, box=box) -> bool:
            p = pos.get(node_id)
            return p is not None and box[0] <= p.x <= box[2] and box[1] <= p.y <= box[3]

        members = [dss_name[n.id] for n in circuit.nodes
                   if n.id in dss_name and n.type not in ANNOTATION_TYPES and inside(n.id)]
        members += [dss_name[e.id] for e in circuit.edges
                    if e.id in dss_name and inside(e.source) and inside(e.target)]
        out.append(f"! Zone: {label}" + (" - " + ", ".join(members) if members else ""))
    return out


def _note_comment(text: object) -> list[str]:
    """A note's text as comment lines headed "! Note:"."""
    lines = [ln.strip() for ln in str(text or "").splitlines() if ln.strip()]
    if not lines:
        return []
    return [f"! Note: {lines[0]}", *(f"!       {ln}" for ln in lines[1:])]


def _as_comment(text: str) -> list[str]:
    """Stored comment text as .dss comment lines. A line that lost its
    marker (typed in by hand, say) gets one, so nothing reaches the engine."""
    out = []
    for ln in text.splitlines():
        t = ln.strip()
        if t:
            out.append(t if t.startswith(("!", "//")) else f"! {t}")
    return out
