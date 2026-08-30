"""Terminal-to-bus synthesis.

Translates the drawn graph into OpenDSS bus names:

- Every (node, handle) pair is a *terminal*.
- ``wire`` edges merge the terminals they connect (ideal connections).
- All handles of a busbar are one terminal group; the busbar's name names it.
- ``line`` edges are series elements: they do NOT merge their endpoints,
  their two endpoint groups become the Line element's bus1/bus2.

Naming precedence for a group: busbar name > persisted implicit name
(``Circuit.busNames`` keyed by group fingerprint) > fresh ``bus_<n>``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .model import NODE_TERMINALS, Circuit, Issue

BUSBAR_CANON_HANDLE = "__bus__"


def sanitize_name(name: str) -> str:
    """Make a user name safe for OpenDSS (case-insensitive, no dots/spaces)."""
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9_]+", "_", s).strip("_")
    return s


def terminal_key(node_id: str, handle: str) -> str:
    return f"{node_id}:{handle}"


class _DSU:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def add(self, x: str) -> None:
        self.parent.setdefault(x, x)

    def find(self, x: str) -> str:
        self.add(x)
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


@dataclass
class ConnectivityResult:
    # terminal key -> OpenDSS bus name
    terminal_bus: dict[str, str] = field(default_factory=dict)
    # node id -> ordered list of bus names (per its terminals t1, t2, ...)
    node_buses: dict[str, list[str]] = field(default_factory=dict)
    # line-edge id -> (bus1, bus2)
    line_buses: dict[str, tuple[str, str]] = field(default_factory=dict)
    # updated fingerprint -> name map to persist back into the project
    bus_names: dict[str, str] = field(default_factory=dict)
    issues: list[Issue] = field(default_factory=list)
    # every distinct bus name
    all_buses: list[str] = field(default_factory=list)


def synthesize(circuit: Circuit) -> ConnectivityResult:
    res = ConnectivityResult()
    dsu = _DSU()
    nodes = {n.id: n for n in circuit.nodes}

    # Register fixed terminals for symbol nodes and a canonical terminal per busbar.
    for n in circuit.nodes:
        if n.type == "busbar":
            dsu.add(terminal_key(n.id, BUSBAR_CANON_HANDLE))
        else:
            for h in NODE_TERMINALS.get(n.type, []):
                dsu.add(terminal_key(n.id, h))

    def endpoint(node_id: str, handle: str | None, default: str = "t1") -> str | None:
        n = nodes.get(node_id)
        if n is None:
            return None
        if n.type == "busbar":
            # Any handle on a busbar is the same electrical bus.
            return terminal_key(n.id, BUSBAR_CANON_HANDLE)
        h = handle or default
        key = terminal_key(n.id, h)
        dsu.add(key)
        return key

    # Wire edges merge; line edges only record endpoints.
    line_endpoints: dict[str, tuple[str, str]] = {}
    for e in circuit.edges:
        a = endpoint(e.source, e.sourceHandle)
        b = endpoint(e.target, e.targetHandle)
        if a is None or b is None:
            res.issues.append(Issue(severity="error", code="dangling-edge",
                                    message=f"Edge {e.id} references a missing node.",
                                    edgeId=e.id))
            continue
        if e.type == "wire":
            dsu.union(a, b)
        else:
            line_endpoints[e.id] = (a, b)

    # Collect groups.
    groups: dict[str, list[str]] = {}
    for t in list(dsu.parent):
        groups.setdefault(dsu.find(t), []).append(t)

    # Name each group in three passes so fresh names can never collide with
    # busbar-derived or persisted names that have not been claimed yet:
    #   1. groups containing busbars claim their busbar name,
    #   2. implicit groups claim their persisted name if it is still free,
    #   3. the rest get fresh bus_<n> names skipping anything taken.
    root_name: dict[str, str] = {}
    used_names: dict[str, str] = {}  # name -> root that claimed it
    fingerprints = {root: min(members) for root, members in groups.items()}
    ordered = sorted(groups, key=lambda r: fingerprints[r])

    implicit: list[str] = []
    for root in ordered:
        busbar_names: list[tuple[str, str]] = []  # (sanitized, node_id)
        for t in groups[root]:
            node_id, handle = t.rsplit(":", 1)
            if handle == BUSBAR_CANON_HANDLE:
                raw = str(nodes[node_id].params.get("name") or node_id)
                busbar_names.append((sanitize_name(raw) or node_id, node_id))
        if not busbar_names:
            implicit.append(root)
            continue
        distinct = sorted({n for n, _ in busbar_names})
        if len(distinct) > 1:
            res.issues.append(Issue(
                severity="error", code="busbar-name-conflict",
                message=f"Busbars named {', '.join(distinct)} are wired together; "
                        "merged busbars must share one name.",
                nodeId=busbar_names[0][1]))
        name = distinct[0]
        if name in used_names:
            res.issues.append(Issue(
                severity="error", code="duplicate-bus-name",
                message=f"Two separate buses resolve to the same name '{name}' "
                        "(names are sanitized to lowercase letters/digits/underscores).",
                nodeId=busbar_names[0][1]))
        used_names.setdefault(name, root)
        root_name[root] = name

    deferred: list[str] = []
    for root in implicit:
        name = circuit.busNames.get(fingerprints[root])
        if name and name not in used_names:
            used_names[name] = root
            root_name[root] = name
            res.bus_names[fingerprints[root]] = name
        else:
            deferred.append(root)

    counter = 1
    for root in deferred:
        while f"bus_{counter}" in used_names:
            counter += 1
        name = f"bus_{counter}"
        counter += 1
        used_names[name] = root
        root_name[root] = name
        res.bus_names[fingerprints[root]] = name

    for t in dsu.parent:
        res.terminal_bus[t] = root_name[dsu.find(t)]

    # Per-node bus lists.
    for n in circuit.nodes:
        if n.type == "busbar":
            res.node_buses[n.id] = [res.terminal_bus[terminal_key(n.id, BUSBAR_CANON_HANDLE)]]
        else:
            res.node_buses[n.id] = [res.terminal_bus[terminal_key(n.id, h)]
                                    for h in NODE_TERMINALS.get(n.type, [])]

    # Per-line-edge buses.
    for eid, (a, b) in line_endpoints.items():
        res.line_buses[eid] = (res.terminal_bus[a], res.terminal_bus[b])

    res.all_buses = sorted(set(root_name.values()))
    return res
