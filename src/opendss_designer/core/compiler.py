"""Compile a Circuit into an ordered list of OpenDSS Text commands.

The same command list backs both /api/solve and /api/export/dss, so what you
export is exactly what was solved.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .connectivity import ConnectivityResult, sanitize_name, synthesize
from .model import Circuit, Issue

# Fallback ratings so loading % is at least defined; a warning is attached
# whenever these are used.
DEFAULT_LINE_NORMAMPS = 400.0
DEFAULT_BREAKER_NORMAMPS = 600.0


@dataclass
class CompileResult:
    commands: list[str] = field(default_factory=list)
    connectivity: ConnectivityResult | None = None
    # OpenDSS full element name (lowercase, e.g. "line.ln1") -> diagram id
    element_map: dict[str, str] = field(default_factory=dict)
    issues: list[Issue] = field(default_factory=list)
    voltage_bases: list[float] = field(default_factory=list)


def _num(params: dict, key: str, default: float | None = None) -> float | None:
    v = params.get(key, default)
    if v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


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


def compile_circuit(circuit: Circuit) -> CompileResult:
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
        phases = int(_num(p, "phases", 3) or 3)
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

    for n in transformers:
        p = n.params
        name = element_name("transformer", p.get("name"), n.id, n.id)
        phases = int(_num(p, "phases", 3) or 3)
        windings = p.get("windings") or [
            {"kv": 115, "kva": 10000, "conn": "delta"},
            {"kv": 12.47, "kva": 10000, "conn": "wye"},
        ]
        buses = conn.node_buses[n.id]
        bus_nodes = p.get("busNodes") or []
        bus_list = ", ".join(
            b + _bus_suffix(bus_nodes[i] if i < len(bus_nodes) else None, phases)
            for i, b in enumerate(buses[: len(windings)]))
        conns = ", ".join(str(w.get("conn", "wye")) for w in windings)
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
        phases = int(_num(p, "phases", 3) or 3)
        b1, b2 = conn.line_buses[e.id]
        sfx1 = _bus_suffix(p.get("nodes1"), phases)
        sfx2 = _bus_suffix(p.get("nodes2"), phases)
        length = _num(p, "length", 1.0)
        units = str(p.get("units", "km"))
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
        phases = int(_num(p, "phases", 3) or 3)
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
        phases = int(_num(p, "phases", 3) or 3)
        bus = conn.node_buses[n.id][0] + _bus_suffix(p.get("busNodes"), phases)
        kv = _num(p, "kv", 12.47) or 12.47
        kw = _num(p, "kw", 100.0)
        pf = _num(p, "pf", 0.95)
        load_conn = str(p.get("conn", "wye"))
        model = int(_num(p, "model", 1) or 1)
        kv_bases.add(kv)
        cmds.append(
            f"new load.{name} bus1={bus} phases={phases} conn={load_conn} "
            f"kv={kv:g} kw={kw:g} pf={pf:g} model={model} vminpu=0.85")

    for n in capacitors:
        p = n.params
        name = element_name("capacitor", p.get("name"), n.id, n.id)
        phases = int(_num(p, "phases", 3) or 3)
        bus = conn.node_buses[n.id][0] + _bus_suffix(p.get("busNodes"), phases)
        kv = _num(p, "kv", 12.47) or 12.47
        kvar = _num(p, "kvar", 600.0)
        cap_conn = str(p.get("conn", "wye"))
        numsteps = int(_num(p, "numsteps", 1) or 1)
        kv_bases.add(kv)
        cmd = (f"new capacitor.{name} bus1={bus} phases={phases} conn={cap_conn} "
               f"kv={kv:g} kvar={kvar:g}")
        if numsteps > 1:
            cmd += f" numsteps={numsteps}"
        cmds.append(cmd)

    for n in generators:
        p = n.params
        name = element_name("generator", p.get("name"), n.id, n.id)
        phases = int(_num(p, "phases", 3) or 3)
        bus = conn.node_buses[n.id][0] + _bus_suffix(p.get("busNodes"), phases)
        kv = _num(p, "kv", 12.47) or 12.47
        kw = _num(p, "kw", 1000.0)
        pf = _num(p, "pf", 1.0)
        gen_conn = str(p.get("conn", "wye"))
        model = int(_num(p, "model", 1) or 1)
        kv_bases.add(kv)
        cmd = (f"new generator.{name} bus1={bus} phases={phases} conn={gen_conn} "
               f"kv={kv:g} kw={kw:g} pf={pf:g} model={model}")
        if model == 3:  # constant-V (PV) mode holds this voltage setpoint
            vpu = _num(p, "vpu", 1.0)
            cmd += f" vpu={vpu:g}"
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
