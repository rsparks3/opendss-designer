"""What feeds what: tracing on the drawn model, no solve.

The graph is the bus graph `connectivity.synthesize` builds: buses are
vertices, and every series element that conducts -- a line edge in service, a
transformer, regulator or closed switching device in service -- is an edge
between the buses of its terminals. A shunt element (load, capacitor, DER)
hangs on one bus and carries nothing between buses.

Sources are the in-service `vsource` elements and the in-service generators
in isochronous mode (`islandMode: "isochronous"`, the loss-of-utility model
in which a generator holds an island's voltage and frequency).

- `upstream_paths`: for each source that reaches an element, the shortest
  chain of series elements and buses between them, source first.
- `downstream`: what loses every source when the element opens (a series
  element), is removed (a bus), or is the element itself (a shunt). On a loop
  that is nothing; on a radial lateral, the lateral.
- `islands`: the connected parts of the graph, each with its sources.

Every function takes the effective circuit; `resolve` applies the open
scenario first, as the compiler does.

The frontend has the same functions in `lib/trace.ts` for interactivity, and
both are tested against the same samples.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .connectivity import ConnectivityResult, synthesize
from .model import Circuit, CircuitNode, conducts, in_service
from .scenarios import apply_scenario

SERIES_NODE_TYPES = frozenset({"transformer", "regulator", "breaker", "fuse", "recloser", "relay"})
PROTECTIVE_TYPES = frozenset({"breaker", "fuse", "recloser", "relay"})
PRIORITIES = ("critical", "essential", "nonessential", "unassigned")


def priority_of(params: dict[str, Any]) -> str:
    p = str(params.get("priority") or "").strip().lower()
    return p if p in PRIORITIES else "unassigned"


def is_source(node: CircuitNode) -> bool:
    if not in_service(node.params):
        return False
    if node.type == "vsource":
        return True
    return node.type == "generator" and node.params.get("islandMode") == "isochronous"


@dataclass
class Topology:
    circuit: Circuit
    conn: ConnectivityResult
    # bus -> [(other bus, element id)] for every conducting series element
    links: dict[str, list[tuple[str, str]]] = field(default_factory=dict)
    # element id (node or line edge) -> its buses, in terminal order
    element_buses: dict[str, list[str]] = field(default_factory=dict)
    # source node id -> bus
    sources: dict[str, str] = field(default_factory=dict)
    nodes: dict[str, CircuitNode] = field(default_factory=dict)
    # element ids that pass power between buses (conducting or not)
    series: set[str] = field(default_factory=set)

    def source_buses(self, without: str | None = None) -> list[str]:
        return [b for sid, b in self.sources.items() if sid != without]


def resolve(circuit: Circuit) -> Circuit:
    """The circuit as drawn with the open scenario applied."""
    return apply_scenario(circuit, circuit.scenario)


def build(circuit: Circuit) -> Topology:
    conn = synthesize(circuit)
    topo = Topology(circuit=circuit, conn=conn, nodes={n.id: n for n in circuit.nodes})

    def link(a: str, b: str, element: str) -> None:
        if a == b:
            return
        topo.links.setdefault(a, []).append((b, element))
        topo.links.setdefault(b, []).append((a, element))

    for e in circuit.edges:
        if e.type != "line" or e.id not in conn.line_buses:
            continue
        a, b = conn.line_buses[e.id]
        topo.element_buses[e.id] = [a, b]
        topo.series.add(e.id)
        if in_service(e.params):
            link(a, b, e.id)
    for n in circuit.nodes:
        buses = conn.node_buses.get(n.id, [])
        if not buses:
            continue
        topo.element_buses[n.id] = buses
        if n.type in SERIES_NODE_TYPES and len(buses) >= 2:
            topo.series.add(n.id)
            if conducts(n):
                for b in buses[1:]:  # a tertiary winding is a third bus
                    link(buses[0], b, n.id)
        elif is_source(n):
            topo.sources[n.id] = buses[0]
    return topo


def _reach(topo: Topology, starts: list[str], cut_element: str | None = None,
           cut_bus: str | None = None) -> set[str]:
    seen: set[str] = set()
    queue = deque(b for b in starts if b != cut_bus)
    seen.update(queue)
    while queue:
        bus = queue.popleft()
        for nxt, element in topo.links.get(bus, ()):
            if element == cut_element or nxt == cut_bus or nxt in seen:
                continue
            seen.add(nxt)
            queue.append(nxt)
    return seen


def energized(topo: Topology, cut_element: str | None = None,
              cut_bus: str | None = None) -> set[str]:
    """Buses some source reaches, optionally with one element or bus removed."""
    return _reach(topo, topo.source_buses(without=cut_element), cut_element, cut_bus)


def upstream_paths(topo: Topology, element_id: str) -> list[dict[str, Any]]:
    """One path per source that reaches the element: the shortest (fewest
    series elements), listed source first. The element itself is not in its
    own path. A source asked about is its own (empty) path."""
    starts = topo.element_buses.get(element_id)
    if not starts:
        return []
    if element_id in topo.sources:
        return [{"sourceId": element_id, "elements": [], "buses": [topo.sources[element_id]]}]
    # Breadth first from the element outward, never through itself.
    parent: dict[str, tuple[str | None, str | None]] = {b: (None, None) for b in starts}
    queue = deque(starts)
    while queue:
        bus = queue.popleft()
        for nxt, element in topo.links.get(bus, ()):
            if element == element_id or nxt in parent:
                continue
            parent[nxt] = (bus, element)
            queue.append(nxt)
    paths = []
    for sid, sbus in topo.sources.items():
        if sbus not in parent:
            continue
        buses, elements = [sbus], []
        cur = sbus
        while True:
            prev, element = parent[cur]
            if prev is None:
                break
            elements.append(element)
            buses.append(prev)
            cur = prev
        paths.append({"sourceId": sid, "elements": elements, "buses": buses})
    paths.sort(key=lambda p: (len(p["elements"]), p["sourceId"]))
    return paths


def downstream(topo: Topology, element_id: str) -> dict[str, Any]:
    """Everything that would lose all its sources: buses, nodes and line edges
    (the element itself excluded), and the loads among them."""
    buses = topo.element_buses.get(element_id, [])
    node = topo.nodes.get(element_id)
    before = energized(topo)
    if node is not None and node.type == "busbar":
        after = energized(topo, cut_bus=buses[0] if buses else None)
    elif element_id in topo.series or element_id in topo.sources:
        after = energized(topo, cut_element=element_id)
    else:
        after = before  # a shunt element drops only itself
    lost = before - after
    if node is not None and node.type == "busbar" and buses:
        lost.add(buses[0])

    node_ids = [n.id for n in topo.circuit.nodes
                if n.id != element_id and (bs := topo.element_buses.get(n.id))
                and all(b in lost for b in bs)]
    edge_ids = [e.id for e in topo.circuit.edges
                if e.id != element_id and (bs := topo.element_buses.get(e.id))
                and all(b in lost for b in bs)]
    if node is not None and node.type == "load" and buses and buses[0] in before:
        node_ids = []
        load_ids = [element_id]
    else:
        load_ids = [i for i in node_ids if topo.nodes[i].type == "load"]
    return {
        "elementId": element_id,
        "buses": sorted(lost),
        "nodeIds": node_ids,
        "edgeIds": edge_ids,
        "loads": summarize_loads(topo, load_ids),
    }


def summarize_loads(topo: Topology, load_ids: list[str]) -> dict[str, Any]:
    """Loads grouped by priority (critical first) with kW and customer totals."""
    rows = []
    for lid in load_ids:
        p = topo.nodes[lid].params
        kw = _num(p.get("kw"))
        rows.append({
            "id": lid,
            "name": str(p.get("name") or lid),
            "priority": priority_of(p),
            "kw": kw if in_service(p) else 0.0,
            "numcust": int(_num(p.get("numcust"), 1.0)),
            "building": str(p.get("building") or ""),
            "tags": [str(t) for t in p.get("tags") or [] if isinstance(t, str)],
            "inService": in_service(p),
        })
    order = {k: i for i, k in enumerate(PRIORITIES)}
    rows.sort(key=lambda r: (order[r["priority"]], -r["kw"], r["name"]))
    totals = {k: {"kw": 0.0, "numcust": 0, "count": 0} for k in PRIORITIES}
    for r in rows:
        t = totals[r["priority"]]
        t["kw"] += r["kw"]
        t["numcust"] += r["numcust"]
        t["count"] += 1
    for t in totals.values():
        t["kw"] = round(t["kw"], 3)
    return {"rows": rows, "byPriority": totals,
            "totalKw": round(sum(r["kw"] for r in rows), 3)}


def _num(v: Any, default: float = 0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if f == f else default  # NaN


def islands(topo: Topology) -> list[dict[str, Any]]:
    """The connected parts of the conducting graph that hold at least one
    element: buses, the sources in each, and whether it is energized."""
    seen: set[str] = set()
    out = []
    all_buses = set(topo.conn.all_buses)
    source_at: dict[str, list[str]] = {}
    for sid, b in topo.sources.items():
        source_at.setdefault(b, []).append(sid)
    for start in sorted(all_buses):
        if start in seen:
            continue
        part = _reach(topo, [start])
        seen |= part
        sources = sorted(s for b in part for s in source_at.get(b, []))
        out.append({"buses": sorted(part), "sources": sources, "energized": bool(sources)})
    return out


def first_protective_upstream(topo: Topology, element_id: str) -> str | None:
    """The protective device nearest the element on its shortest path to a source."""
    paths = upstream_paths(topo, element_id)
    if not paths:
        return None
    for el in reversed(paths[0]["elements"]):
        n = topo.nodes.get(el)
        if n is not None and n.type in PROTECTIVE_TYPES:
            return el
    return None


def trace(circuit: Circuit, element_id: str) -> dict[str, Any]:
    """Upstream paths and the downstream set of one element, on the effective
    circuit. Unknown ids give empty answers, not errors."""
    topo = build(resolve(circuit))
    known = element_id in topo.element_buses
    return {
        "elementId": element_id,
        "found": known,
        "upstream": upstream_paths(topo, element_id) if known else [],
        "downstream": downstream(topo, element_id) if known else None,
        "firstProtective": first_protective_upstream(topo, element_id) if known else None,
    }
