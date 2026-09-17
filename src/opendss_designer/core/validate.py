"""Structural validation of a Circuit, shared by /api/validate and the UI."""
from __future__ import annotations

from .. import context
from ..settings import Settings
from .compiler import compile_circuit
from .connectivity import BUSBAR_CANON_HANDLE, synthesize, terminal_key
from .model import Circuit, Issue, node_terminals
from .phasing import PHASE_LETTERS, default_phasing, parse_phasing, phase_count, phase_set

# 2-terminal devices that carry power between their two buses. Protective
# devices are switches, so they conduct unless their `closed` flag says
# otherwise -- the same rule as a breaker.
SERIES_TYPES = ("transformer", "regulator", "breaker", "fuse", "recloser", "relay")
SWITCH_TYPES = ("breaker", "fuse", "recloser", "relay")

# Series types that keep phase identity end to end. A transformer does not: its
# secondary is a new voltage level whose phases start at A again, which is what
# the compiler emits and what makes a 1-phase pole-top transformer work.
CARRY_TYPES = ("regulator", *SWITCH_TYPES)


def _phases_of(params: dict) -> frozenset[str]:
    return phase_set(params.get("phasing"), phase_count(params))


def phases_available(circuit: Circuit, conn, sources: list) -> dict[str, frozenset[str]]:
    """Which phases reach each bus, by bus name.

    Relaxes outward from the sources: a bus gets whatever phases its feeders
    carry, a series element passes on only the phases it has itself, and a
    transformer hands its secondary a fresh set starting at A. Buses the walk
    never reaches get no entry -- being unconnected is already reported as an
    island, and saying it twice in different words helps nobody.
    """
    if not sources:
        return {}
    phases_of = _phases_of

    # Every series path as (bus_in, bus_out, phases it delivers).
    links: list[tuple[str, str, frozenset[str]]] = []
    for e in circuit.edges:
        if e.type == "line" and e.id in conn.line_buses:
            b1, b2 = conn.line_buses[e.id]
            carried = phases_of(e.params)
            links.append((b1, b2, carried))
            links.append((b2, b1, carried))
    for n in circuit.nodes:
        buses = conn.node_buses.get(n.id, [])
        if n.type not in SERIES_TYPES or len(buses) < 2:
            continue
        if n.type in SWITCH_TYPES and not n.params.get("closed", True):
            continue
        if n.type in CARRY_TYPES:
            carried = phases_of(n.params)
            links.append((buses[0], buses[1], carried))
            links.append((buses[1], buses[0], carried))
        else:
            # A transformer re-establishes phases on every winding it feeds,
            # and power can enter it by any winding, so each pair of its
            # buses is a two-way path -- three pairs for a three-winding unit.
            fresh = frozenset(default_phasing(phase_count(n.params)))
            for i, a in enumerate(buses):
                for b in buses[i + 1:]:
                    links.append((a, b, fresh))
                    links.append((b, a, fresh))

    available: dict[str, frozenset[str]] = {}
    for s in sources:
        bus = (conn.node_buses.get(s.id) or [None])[0]
        if bus:
            available[bus] = available.get(bus, frozenset()) | phases_of(s.params)

    # Relax until nothing grows. Bounded by buses x 3 phases, and a feeder
    # settles in a handful of passes; the loop guard is for meshed networks.
    for _ in range(len(links) + 1):
        changed = False
        for src, dst, carried in links:
            upstream = available.get(src)
            if not upstream:
                continue
            delivered = upstream & carried
            if delivered and not delivered <= available.get(dst, frozenset()):
                available[dst] = available.get(dst, frozenset()) | delivered
                changed = True
        if not changed:
            break
    return available


def bus_phases(circuit: Circuit, conn, sources: list) -> dict[str, dict[str, object]]:
    """The phase walk keyed by diagram id, for the one-line to colour by.

    `nodes` maps a node id to the letters reaching each of its terminals, in
    terminal order (a busbar has one); `wires` maps a wire id to the letters
    on the bus it belongs to. A bus the walk never reached reads as "", so a
    dead lateral looks dead rather than defaulting to A.
    """
    available = phases_available(circuit, conn, sources)

    def letters(bus: str | None) -> str:
        return "".join(sorted(available.get(bus or "", frozenset()), key=PHASE_LETTERS.index))

    nodes = {n.id: [letters(b) for b in conn.node_buses.get(n.id, [])]
             for n in circuit.nodes}
    kinds = {n.id: n.type for n in circuit.nodes}
    wires: dict[str, str] = {}
    for e in circuit.edges:
        if e.type != "wire":
            continue
        busbar = kinds.get(e.source) == "busbar"
        handle = BUSBAR_CANON_HANDLE if busbar else (e.sourceHandle or "t1")
        wires[e.id] = letters(conn.terminal_bus.get(terminal_key(e.source, handle)))
    return {"nodes": nodes, "wires": wires}


def _phase_issues(circuit: Circuit, conn, sources: list) -> list[Issue]:
    """Flag elements pinned to a phase their bus never receives. Buses the
    walk never reaches are skipped: see phases_available."""
    issues: list[Issue] = []
    available = phases_available(circuit, conn, sources)
    if not available:
        return issues
    phases_of = _phases_of

    for n in circuit.nodes:
        if n.type == "busbar":
            continue
        params = n.params
        label = str(params.get("name") or n.id)
        pinned = parse_phasing(params.get("phasing"))
        count = phase_count(params)
        if pinned and len(pinned) < count:
            issues.append(Issue(
                severity="error", code="phase-count-mismatch",
                message=f"'{label}' is set to {count} phases but pinned to "
                        f"only {len(pinned)} ({'-'.join(pinned)}).",
                nodeId=n.id))
            continue
        # A source defines its phases rather than receiving them. Everything
        # else is judged against every bus it touches, since a two-terminal
        # device may be fed from either end.
        if n.type == "vsource":
            continue
        reached = [b for b in conn.node_buses.get(n.id, []) if b in available]
        if not reached:
            continue
        here = frozenset().union(*(available[b] for b in reached))
        missing = sorted(phases_of(params) - here)
        if missing:
            issues.append(Issue(
                severity="warning", code="phase-mismatch",
                message=f"'{label}' connects to phase{'s' if len(missing) > 1 else ''} "
                        f"{', '.join(missing)}, which bus '{reached[0]}' does not carry "
                        f"(it has {', '.join(sorted(here))}).",
                nodeId=n.id))

    for e in circuit.edges:
        if e.type != "line" or e.id not in conn.line_buses:
            continue
        label = str(e.params.get("name") or e.id)
        pinned = parse_phasing(e.params.get("phasing"))
        count = phase_count(e.params)
        if pinned and len(pinned) < count:
            issues.append(Issue(
                severity="error", code="phase-count-mismatch",
                message=f"Line '{label}' is set to {count} phases but pinned to "
                        f"only {len(pinned)} ({'-'.join(pinned)}).",
                edgeId=e.id))
            continue
        ends = [b for b in conn.line_buses[e.id] if b in available]
        if not ends:
            continue
        here = frozenset().union(*(available[b] for b in ends))
        missing = sorted(phases_of(e.params) - here)
        if missing:
            issues.append(Issue(
                severity="warning", code="phase-mismatch",
                message=f"Line '{label}' takes phase{'s' if len(missing) > 1 else ''} "
                        f"{', '.join(missing)} from bus '{ends[0]}', which does not "
                        f"carry {'them' if len(missing) > 1 else 'it'}.",
                edgeId=e.id))

    return issues


def limit_issues(circuit: Circuit, cfg: Settings | None = None) -> list[Issue]:
    """Demo-mode size caps, expressed as ordinary validation issues.

    Riding the existing `Issue` pipeline means the Problems list renders them,
    the offending element is haloed, and `engine.solve` already refuses to run
    when any issue is an error -- no new plumbing, and the message appears
    while the user is drawing rather than only when they hit Solve.

    Returns nothing at all in local mode, so a pip-installed user is unaffected.
    Behind a gateway the per-request overlay (``context.current_settings``)
    is what applies, and the messages name the caller's plan.
    """
    cfg = cfg or context.current_settings()
    who = cfg.plan_label
    issues: list[Issue] = []

    def over(limit: int | None, actual: int) -> bool:
        return limit is not None and actual > limit

    if over(cfg.max_nodes, len(circuit.nodes)):
        issues.append(Issue(
            severity="error", code="limit-nodes",
            message=f"This circuit has {len(circuit.nodes)} elements; {who} "
                    f"is limited to {cfg.max_nodes}. Run OpenDSS Designer "
                    "locally (pip install opendss-designer) for full-size models."))
    if over(cfg.max_edges, len(circuit.edges)):
        issues.append(Issue(
            severity="error", code="limit-edges",
            message=f"This circuit has {len(circuit.edges)} connections; "
                    f"{who} is limited to {cfg.max_edges}."))
    if over(cfg.max_shapes, len(circuit.loadShapes)):
        issues.append(Issue(
            severity="error", code="limit-shapes",
            message=f"This circuit defines {len(circuit.loadShapes)} shapes; "
                    f"{who} is limited to {cfg.max_shapes}."))

    total_points = 0
    for key, spec in circuit.loadShapes.items():
        total_points += len(spec.points)
        if over(cfg.max_shape_points, len(spec.points)):
            issues.append(Issue(
                severity="error", code="limit-shape-points",
                message=f"Loadshape '{key}' has {len(spec.points)} points; "
                        f"{who} is limited to {cfg.max_shape_points} "
                        "(a 15-minute year)."))
    if over(cfg.max_total_shape_points, total_points):
        issues.append(Issue(
            severity="error", code="limit-total-shape-points",
            message=f"The shapes in this circuit total {total_points} points; "
                    f"{who} is limited to {cfg.max_total_shape_points}."))
    return issues


#: Errors only the compiler detects. Validation used to stop short of the
#: compiler, so two elements sanitising to one OpenDSS name passed
#: validation, Solve stayed enabled, and the engine refused every run with
#: no visible reason. Compiling is pure string building (no engine), so it
#: is cheap enough to run on the validation debounce. Missing load shapes
#: are reported further down with a friendlier message, so only the name
#: clash is taken from the compiler.
COMPILER_CHECKS = frozenset({"duplicate-name"})


def phase_map(circuit: Circuit) -> dict[str, dict[str, object]]:
    """bus_phases() for a circuit on its own, for /api/validate to ship
    alongside the issues so the one-line can colour by phase without a
    solve."""
    conn = synthesize(circuit)
    sources = [n for n in circuit.nodes if n.type == "vsource"]
    return bus_phases(circuit, conn, sources)


def validate(circuit: Circuit) -> list[Issue]:
    issues: list[Issue] = limit_issues(circuit)
    conn = synthesize(circuit)
    issues.extend(conn.issues)
    seen = {(i.code, i.nodeId) for i in issues}
    for i in compile_circuit(circuit).issues:
        if i.code in COMPILER_CHECKS and (i.code, i.nodeId) not in seen:
            issues.append(i)
            seen.add((i.code, i.nodeId))

    sources = [n for n in circuit.nodes if n.type == "vsource"]
    if not sources:
        issues.append(Issue(severity="error", code="no-source",
                            message="Add a source (Vsource) to solve the circuit."))

    # A terminal is "connected" if it appears in at least one edge, or belongs
    # to a busbar (busbars may legitimately sit with spare handles).
    connected: set[str] = set()
    nodes = {n.id: n for n in circuit.nodes}
    for e in circuit.edges:
        for nid, h in ((e.source, e.sourceHandle), (e.target, e.targetHandle)):
            n = nodes.get(nid)
            if n is None:
                continue
            if n.type == "busbar":
                connected.add(nid)
            else:
                connected.add(terminal_key(nid, h or "t1"))

    for n in circuit.nodes:
        if n.type == "busbar":
            continue
        for h in node_terminals(n):
            if terminal_key(n.id, h) not in connected:
                label = n.params.get("name") or n.id
                issues.append(Issue(
                    severity="error", code="unconnected-terminal",
                    message=f"{n.type.capitalize()} '{label}' terminal {h} is not connected.",
                    nodeId=n.id))

    # Reachability from the source over wires, lines, and 2-terminal devices.
    if sources:
        adjacency: dict[str, set[str]] = {}

        def link(a: str, b: str) -> None:
            adjacency.setdefault(a, set()).add(b)
            adjacency.setdefault(b, set()).add(a)

        for e in circuit.edges:
            if e.type == "line" and e.id in conn.line_buses:
                b1, b2 = conn.line_buses[e.id]
                link(b1, b2)
        for n in circuit.nodes:
            buses = conn.node_buses.get(n.id, [])
            if n.type in SERIES_TYPES and len(buses) >= 2:
                if n.type in SWITCH_TYPES and not n.params.get("closed", True):
                    continue
                for b in buses[1:]:  # a tertiary winding is a third bus
                    link(buses[0], b)

        reachable: set[str] = set()
        stack = [conn.node_buses[s.id][0] for s in sources if s.id in conn.node_buses]
        while stack:
            b = stack.pop()
            if b in reachable:
                continue
            reachable.add(b)
            stack.extend(adjacency.get(b, ()))

        for n in circuit.nodes:
            buses = conn.node_buses.get(n.id, [])
            if buses and not any(b in reachable for b in buses):
                label = n.params.get("name") or n.id
                issues.append(Issue(
                    severity="warning", code="island",
                    message=f"'{label}' is not electrically connected to the source.",
                    nodeId=n.id))

    # Loadshape references and sanity. Loads should follow load shapes and PV
    # irradiance shapes (storage dispatch may follow either kind).
    _EXPECTED_KIND = {"load": "load", "pvsystem": "irradiance"}
    for n in circuit.nodes:
        shape = n.params.get("loadshape")
        if not shape:
            continue
        label = n.params.get("name") or n.id
        spec = circuit.loadShapes.get(str(shape))
        if spec is None:
            issues.append(Issue(
                severity="error", code="missing-loadshape",
                message=f"'{label}' references loadshape '{shape}', "
                        "which is not defined in this circuit.",
                nodeId=n.id))
        else:
            expected = _EXPECTED_KIND.get(n.type)
            if expected and spec.kind != expected:
                issues.append(Issue(
                    severity="warning", code="shape-kind-mismatch",
                    message=f"'{label}' ({n.type}) follows '{shape}', which is "
                            f"a {spec.kind} shape, not {'an' if expected == 'irradiance' else 'a'} "
                            f"{expected} shape.",
                    nodeId=n.id))
    for key, spec in circuit.loadShapes.items():
        if len(spec.points) < 2:
            issues.append(Issue(
                severity="warning", code="empty-loadshape",
                message=f"Loadshape '{key}' has fewer than 2 points."))

    # Phases, per bus. A pin is only useful if something says when it points at
    # a phase that never gets there -- a lateral pinned to C hanging off a bus
    # fed only by A is a dead element, and the solve reports it as a voltage of
    # zero rather than as a mistake.
    issues.extend(_phase_issues(circuit, conn, sources))

    # kV consistency per bus (rough sanity check on declared voltages).
    bus_kvs: dict[str, dict[str, str]] = {}
    for n in circuit.nodes:
        buses = conn.node_buses.get(n.id, [])
        declared: list[tuple[str, float]] = []
        if n.type in ("vsource", "busbar"):
            kv = n.params.get("basekv")
            if kv and buses:
                declared.append((buses[0], float(kv)))
        elif n.type in ("load", "capacitor", "generator", "pvsystem", "storage"):
            kv = n.params.get("kv")
            if kv and buses:
                declared.append((buses[0], float(kv)))
        elif n.type == "regulator":
            # Equal ratio, so both sides declare the same kV.
            kv = n.params.get("kv")
            if kv:
                declared.extend((b, float(kv)) for b in buses[:2])
        elif n.type == "transformer":
            windings = n.params.get("windings") or []
            for b, w in zip(buses, windings, strict=False):
                if w.get("kv"):
                    declared.append((b, float(w["kv"])))
        label = str(n.params.get("name") or n.id)
        for bus, kv in declared:
            others = bus_kvs.setdefault(bus, {})
            for other_label, other_kv in list(others.items()):
                if abs(float(other_kv) - kv) > 0.01 * max(kv, float(other_kv)):
                    issues.append(Issue(
                        severity="warning", code="kv-mismatch",
                        message=f"Bus '{bus}': '{label}' declares {kv:g} kV but "
                                f"'{other_label}' declares {float(other_kv):g} kV.",
                        nodeId=n.id))
            others[label] = str(kv)

    return issues
