"""Structural validation of a Circuit, shared by /api/validate and the UI."""
from __future__ import annotations

from ..settings import Settings, settings
from .connectivity import synthesize, terminal_key
from .model import NODE_TERMINALS, Circuit, Issue


def limit_issues(circuit: Circuit, cfg: "Settings | None" = None) -> list[Issue]:
    """Demo-mode size caps, expressed as ordinary validation issues.

    Riding the existing `Issue` pipeline means the Problems list renders them,
    the offending element is haloed, and `engine.solve` already refuses to run
    when any issue is an error -- no new plumbing, and the message appears
    while the user is drawing rather than only when they hit Solve.

    Returns nothing at all in local mode, so a pip-installed user is unaffected.
    """
    cfg = cfg or settings
    issues: list[Issue] = []

    def over(limit: int | None, actual: int) -> bool:
        return limit is not None and actual > limit

    if over(cfg.max_nodes, len(circuit.nodes)):
        issues.append(Issue(
            severity="error", code="limit-nodes",
            message=f"This circuit has {len(circuit.nodes)} elements; the public "
                    f"demo is limited to {cfg.max_nodes}. Run OpenDSS Designer "
                    "locally (pip install opendss-designer) for full-size models."))
    if over(cfg.max_edges, len(circuit.edges)):
        issues.append(Issue(
            severity="error", code="limit-edges",
            message=f"This circuit has {len(circuit.edges)} connections; the "
                    f"public demo is limited to {cfg.max_edges}."))
    if over(cfg.max_shapes, len(circuit.loadShapes)):
        issues.append(Issue(
            severity="error", code="limit-shapes",
            message=f"This circuit defines {len(circuit.loadShapes)} shapes; the "
                    f"public demo is limited to {cfg.max_shapes}."))

    total_points = 0
    for key, spec in circuit.loadShapes.items():
        total_points += len(spec.points)
        if over(cfg.max_shape_points, len(spec.points)):
            issues.append(Issue(
                severity="error", code="limit-shape-points",
                message=f"Loadshape '{key}' has {len(spec.points)} points; the "
                        f"public demo is limited to {cfg.max_shape_points} "
                        "(a 15-minute year)."))
    if over(cfg.max_total_shape_points, total_points):
        issues.append(Issue(
            severity="error", code="limit-total-shape-points",
            message=f"The shapes in this circuit total {total_points} points; "
                    f"the public demo is limited to {cfg.max_total_shape_points}."))
    return issues


def validate(circuit: Circuit) -> list[Issue]:
    issues: list[Issue] = limit_issues(circuit)
    conn = synthesize(circuit)
    issues.extend(conn.issues)

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
        for h in NODE_TERMINALS.get(n.type, []):
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
            if n.type in ("transformer", "breaker") and len(buses) >= 2:
                if n.type == "breaker" and not n.params.get("closed", True):
                    continue
                link(buses[0], buses[1])

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
        elif n.type == "transformer":
            windings = n.params.get("windings") or []
            for b, w in zip(buses, windings):
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
