"""Structural validation of a Circuit, shared by /api/validate and the UI."""
from __future__ import annotations

from .connectivity import synthesize, terminal_key
from .model import NODE_TERMINALS, Circuit, Issue


def validate(circuit: Circuit) -> list[Issue]:
    issues: list[Issue] = []
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

    # kV consistency per bus (rough sanity check on declared voltages).
    bus_kvs: dict[str, dict[str, str]] = {}
    for n in circuit.nodes:
        buses = conn.node_buses.get(n.id, [])
        declared: list[tuple[str, float]] = []
        if n.type in ("vsource", "busbar"):
            kv = n.params.get("basekv")
            if kv and buses:
                declared.append((buses[0], float(kv)))
        elif n.type in ("load", "capacitor", "generator"):
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
