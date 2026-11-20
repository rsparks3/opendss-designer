// What feeds what, on the drawing, with no solve. The same graph and the
// same answers as the backend's core/trace.py (tested on the same samples):
// buses are the groups of terminals wires join (every handle of a busbar is
// one), and a series element that conducts -- a line in service, a
// transformer, regulator or closed switching device in service -- links the
// buses of its terminals. Sources are in-service Vsources and in-service
// generators in isochronous mode.

import type { AppEdge, AppNode } from '../store/circuitStore'
import type { Params } from '../types/circuit'

export const PRIORITIES = ['critical', 'essential', 'nonessential', 'unassigned'] as const
export type Priority = (typeof PRIORITIES)[number]

/** Overlay colours, mid-tone so they read on light and dark paper. */
export const PRIORITY_COLORS: Record<Priority, string> = {
  critical: '#d32f2f',
  essential: '#ef6c00',
  nonessential: '#1e88e5',
  unassigned: '#90a4ae',
}
export const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'Critical',
  essential: 'Essential',
  nonessential: 'Non-essential',
  unassigned: 'Unassigned',
}

const SERIES_NODE_TYPES = new Set(['transformer', 'regulator', 'breaker', 'fuse', 'recloser', 'relay'])
const SWITCH_TYPES = new Set(['breaker', 'fuse', 'recloser', 'relay'])
export const PROTECTIVE_TYPES = SWITCH_TYPES
const NO_TERMINALS = new Set(['note', 'zone'])

const inService = (p: Params | undefined) => p?.enabled !== false

export function priorityOf(p: Params | undefined): Priority {
  const v = String(p?.priority ?? '').trim().toLowerCase()
  return (PRIORITIES as readonly string[]).includes(v) ? (v as Priority) : 'unassigned'
}

export function isSource(n: AppNode): boolean {
  const p = n.data.params
  if (!inService(p)) return false
  if (n.type === 'vsource') return true
  return n.type === 'generator' && p.islandMode === 'isochronous'
}

function conducts(n: AppNode): boolean {
  const p = n.data.params
  if (!inService(p)) return false
  return !(SWITCH_TYPES.has(n.type ?? '') && p.closed === false)
}

function handlesOf(n: AppNode): string[] {
  if (n.type === 'transformer') {
    const w = n.data.params.windings
    const three = Array.isArray(w) && w.length >= 3 && n.data.params.splitphase !== true
    return three ? ['t1', 't2', 't3'] : ['t1', 't2']
  }
  return SERIES_NODE_TYPES.has(n.type ?? '') ? ['t1', 't2'] : ['t1']
}

export interface Topology {
  nodes: Map<string, AppNode>
  edges: AppEdge[]
  /** element id (node or line edge) -> its buses, in terminal order */
  elementBuses: Map<string, string[]>
  /** bus -> [other bus, element id] for every conducting series element */
  links: Map<string, [string, string][]>
  /** source node id -> bus */
  sources: Map<string, string>
  series: Set<string>
  /** wire edge id -> the bus it sits in */
  wireBus: Map<string, string>
}

export function buildTopology(nodes: AppNode[], edges: AppEdge[]): Topology {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x)
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    while (parent.get(x) !== r) {
      const next = parent.get(x)!
      parent.set(x, r)
      x = next
    }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const key = (nodeId: string, handle: string | null | undefined): string | null => {
    const n = byId.get(nodeId)
    if (!n || NO_TERMINALS.has(n.type ?? '')) return null
    if (n.type === 'busbar') return nodeId
    return `${nodeId}:${handle || 't1'}`
  }
  const lineEnds: [AppEdge, string, string][] = []
  const wires: [AppEdge, string][] = []
  for (const e of edges) {
    const a = key(e.source, e.sourceHandle)
    const b = key(e.target, e.targetHandle)
    if (!a || !b) continue
    if (e.type === 'line') lineEnds.push([e, a, b])
    else {
      union(a, b)
      wires.push([e, a])
    }
  }
  const topo: Topology = {
    nodes: byId, edges, elementBuses: new Map(), links: new Map(), sources: new Map(),
    series: new Set(), wireBus: new Map(),
  }
  const link = (a: string, b: string, el: string) => {
    if (a === b) return
    if (!topo.links.has(a)) topo.links.set(a, [])
    if (!topo.links.has(b)) topo.links.set(b, [])
    topo.links.get(a)!.push([b, el])
    topo.links.get(b)!.push([a, el])
  }
  for (const [e, a] of wires) topo.wireBus.set(e.id, find(a))
  for (const [e, a, b] of lineEnds) {
    const buses = [find(a), find(b)]
    topo.elementBuses.set(e.id, buses)
    topo.series.add(e.id)
    if (inService(e.data?.params)) link(buses[0], buses[1], e.id)
  }
  for (const n of nodes) {
    if (NO_TERMINALS.has(n.type ?? '')) continue
    const buses = n.type === 'busbar' ? [find(n.id)] : handlesOf(n).map((h) => find(`${n.id}:${h}`))
    topo.elementBuses.set(n.id, buses)
    if (SERIES_NODE_TYPES.has(n.type ?? '') && buses.length >= 2) {
      topo.series.add(n.id)
      if (conducts(n)) for (const b of buses.slice(1)) link(buses[0], b, n.id)
    } else if (isSource(n)) {
      topo.sources.set(n.id, buses[0])
    }
  }
  return topo
}

function reach(topo: Topology, starts: string[], cutElement?: string | null, cutBus?: string | null): Set<string> {
  const seen = new Set<string>()
  const queue: string[] = []
  for (const s of starts) {
    if (s === cutBus || seen.has(s)) continue
    seen.add(s)
    queue.push(s)
  }
  for (let i = 0; i < queue.length; i++) {
    for (const [next, el] of topo.links.get(queue[i]) ?? []) {
      if (el === cutElement || next === cutBus || seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/** Buses some source reaches, optionally with one element or bus removed. */
export function energized(topo: Topology, cutElement?: string | null, cutBus?: string | null): Set<string> {
  const starts = [...topo.sources].filter(([id]) => id !== cutElement).map(([, b]) => b)
  return reach(topo, starts, cutElement, cutBus)
}

export interface UpstreamPath {
  sourceId: string
  /** series elements, source first */
  elements: string[]
  /** buses, source first, ending at the element's own bus */
  buses: string[]
}

/** One path per source that reaches the element (the fewest series
 *  elements), source first; the element is not in its own path. */
export function upstreamPaths(topo: Topology, elementId: string): UpstreamPath[] {
  const starts = topo.elementBuses.get(elementId)
  if (!starts?.length) return []
  const own = topo.sources.get(elementId)
  if (own) return [{ sourceId: elementId, elements: [], buses: [own] }]
  const parent = new Map<string, [string, string] | null>()
  const queue: string[] = []
  for (const b of starts) {
    if (!parent.has(b)) {
      parent.set(b, null)
      queue.push(b)
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const bus = queue[i]
    for (const [next, el] of topo.links.get(bus) ?? []) {
      if (el === elementId || parent.has(next)) continue
      parent.set(next, [bus, el])
      queue.push(next)
    }
  }
  const paths: UpstreamPath[] = []
  for (const [sourceId, sbus] of topo.sources) {
    if (!parent.has(sbus)) continue
    const buses = [sbus]
    const elements: string[] = []
    let cur = sbus
    for (let step = parent.get(cur); step; step = parent.get(cur)) {
      elements.push(step[1])
      buses.push(step[0])
      cur = step[0]
    }
    paths.push({ sourceId, elements, buses })
  }
  paths.sort((a, b) => a.elements.length - b.elements.length || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))
  return paths
}

export interface LoadRow {
  id: string
  name: string
  priority: Priority
  kw: number
  numcust: number
  building: string
  tags: string[]
  inService: boolean
}

export interface LoadSummary {
  rows: LoadRow[]
  byPriority: Record<Priority, { kw: number; numcust: number; count: number }>
  totalKw: number
}

const num = (v: unknown, dflt = 0) => {
  const n = typeof v === 'number' ? v : Number(v)
  return v === '' || v == null || !Number.isFinite(n) ? dflt : n
}

export function summarizeLoads(topo: Topology, loadIds: string[]): LoadSummary {
  const rows: LoadRow[] = loadIds.map((id) => {
    const p = topo.nodes.get(id)!.data.params
    const on = inService(p)
    return {
      id,
      name: String(p.name ?? id),
      priority: priorityOf(p),
      kw: on ? num(p.kw) : 0,
      numcust: Math.trunc(num(p.numcust, 1)),
      building: String(p.building ?? ''),
      tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [],
      inService: on,
    }
  })
  rows.sort((a, b) =>
    PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || b.kw - a.kw || a.name.localeCompare(b.name))
  const byPriority = Object.fromEntries(PRIORITIES.map((k) => [k, { kw: 0, numcust: 0, count: 0 }])) as LoadSummary['byPriority']
  for (const r of rows) {
    const t = byPriority[r.priority]
    t.kw += r.kw
    t.numcust += r.numcust
    t.count += 1
  }
  return { rows, byPriority, totalKw: rows.reduce((s, r) => s + r.kw, 0) }
}

export interface Downstream {
  elementId: string
  buses: Set<string>
  nodeIds: string[]
  edgeIds: string[]
  loads: LoadSummary
}

/** Everything that would lose all its sources if the element opened (a
 *  series element), went (a bus) -- or the element itself (a shunt). */
export function downstream(topo: Topology, elementId: string): Downstream {
  const buses = topo.elementBuses.get(elementId) ?? []
  const node = topo.nodes.get(elementId)
  const before = energized(topo)
  let after: Set<string>
  if (node?.type === 'busbar') after = energized(topo, null, buses[0] ?? null)
  else if (topo.series.has(elementId) || topo.sources.has(elementId)) after = energized(topo, elementId)
  else after = before
  const lost = new Set([...before].filter((b) => !after.has(b)))
  if (node?.type === 'busbar' && buses[0]) lost.add(buses[0])
  const allLost = (id: string) => {
    const bs = topo.elementBuses.get(id)
    return !!bs?.length && bs.every((b) => lost.has(b))
  }
  let nodeIds = [...topo.nodes.keys()].filter((id) => id !== elementId && allLost(id))
  const edgeIds = topo.edges.filter((e) => e.id !== elementId && allLost(e.id)).map((e) => e.id)
  let loadIds: string[]
  if (node?.type === 'load' && buses[0] && before.has(buses[0])) {
    nodeIds = []
    loadIds = [elementId]
  } else {
    loadIds = nodeIds.filter((id) => topo.nodes.get(id)!.type === 'load')
  }
  return { elementId, buses: lost, nodeIds, edgeIds, loads: summarizeLoads(topo, loadIds) }
}

/** The protective device nearest the element on its shortest path. */
export function firstProtectiveUpstream(topo: Topology, elementId: string): string | null {
  const [first] = upstreamPaths(topo, elementId)
  if (!first) return null
  for (let i = first.elements.length - 1; i >= 0; i--) {
    const n = topo.nodes.get(first.elements[i])
    if (n && PROTECTIVE_TYPES.has(n.type ?? '')) return n.id
  }
  return null
}

/** What to light on the drawing for a set of buses and series elements:
 *  the elements, the busbars and wires in those buses. */
export function highlightOf(topo: Topology, buses: Iterable<string>, elements: Iterable<string>):
  { nodeIds: string[]; edgeIds: string[] } {
  const busSet = new Set(buses)
  const els = new Set(elements)
  const nodeIds = [...topo.nodes.values()]
    .filter((n) => els.has(n.id) || (n.type === 'busbar' && busSet.has(topo.elementBuses.get(n.id)?.[0] ?? '')))
    .map((n) => n.id)
  const edgeIds = topo.edges
    .filter((e) => els.has(e.id) || (e.type !== 'line' && busSet.has(topo.wireBus.get(e.id) ?? '')))
    .map((e) => e.id)
  return { nodeIds, edgeIds }
}

/** The priority of each busbar for the Priority overlay: the highest
 *  priority of any load its loss would drop -- its own loads and everything
 *  that has no other way to a source. One depth-first pass from a virtual
 *  root joined to every source (Tarjan's articulation test: a child subtree
 *  is cut off by the bus when nothing in it climbs above the bus), so it is
 *  linear on any size of feeder and exact on loops. Busbar node id ->
 *  priority; a bus no source reaches gets its own loads' priority. */
export function busPriorities(topo: Topology): Map<string, Priority> {
  const rank = (p: Priority) => PRIORITIES.indexOf(p)
  const better = (a: Priority, b: Priority): Priority => (rank(a) <= rank(b) ? a : b)
  const own = new Map<string, Priority>()
  for (const n of topo.nodes.values()) {
    if (n.type !== 'load' || !inService(n.data.params)) continue
    const b = topo.elementBuses.get(n.id)?.[0]
    if (b) own.set(b, better(own.get(b) ?? 'unassigned', priorityOf(n.data.params)))
  }
  const ROOT = '\u0000root'
  const adj = (v: string): [string, string][] =>
    v === ROOT ? [...new Set(topo.sources.values())].map((b) => [b, '\u0000src:' + b]) : [
      ...(topo.links.get(v) ?? []),
      ...([...topo.sources.values()].includes(v) ? [[ROOT, '\u0000src:' + v] as [string, string]] : []),
    ]
  const disc = new Map<string, number>()
  const low = new Map<string, number>()
  const sub = new Map<string, Priority>() // subtree max
  const drops = new Map<string, Priority>() // what removing the bus drops
  let t = 0
  disc.set(ROOT, t)
  low.set(ROOT, t++)
  const stack: { v: string; via: string | null; it: [string, string][]; i: number }[] = [
    { v: ROOT, via: null, it: adj(ROOT), i: 0 },
  ]
  while (stack.length) {
    const top = stack[stack.length - 1]
    if (top.i < top.it.length) {
      const [w, el] = top.it[top.i++]
      if (el === top.via) continue
      if (disc.has(w)) {
        low.set(top.v, Math.min(low.get(top.v)!, disc.get(w)!))
        continue
      }
      disc.set(w, t)
      low.set(w, t++)
      sub.set(w, own.get(w) ?? 'unassigned')
      drops.set(w, own.get(w) ?? 'unassigned')
      stack.push({ v: w, via: el, it: adj(w), i: 0 })
      continue
    }
    stack.pop()
    const parent = stack[stack.length - 1]
    if (!parent) break
    const v = top.v
    const p = parent.v
    low.set(p, Math.min(low.get(p)!, low.get(v)!))
    if (p === ROOT) continue
    sub.set(p, better(sub.get(p)!, sub.get(v)!))
    if (low.get(v)! >= disc.get(p)!) drops.set(p, better(drops.get(p)!, sub.get(v)!))
  }
  const out = new Map<string, Priority>()
  for (const n of topo.nodes.values()) {
    if (n.type !== 'busbar') continue
    const b = topo.elementBuses.get(n.id)?.[0] ?? ''
    out.set(n.id, drops.get(b) ?? own.get(b) ?? 'unassigned')
  }
  return out
}

// One topology per drawing: the canvas asks per busbar, and every busbar's
// selector runs on every store change, so the answer is kept for as long as
// the nodes and edges arrays are the same ones.
let memo: { nodes: AppNode[]; edges: AppEdge[]; topo: Topology; priorities?: Map<string, Priority> } | null = null

export function topologyOf(nodes: AppNode[], edges: AppEdge[]): Topology {
  if (!memo || memo.nodes !== nodes || memo.edges !== edges) memo = { nodes, edges, topo: buildTopology(nodes, edges) }
  return memo.topo
}

export function busPriorityOf(nodes: AppNode[], edges: AppEdge[], busbarId: string): Priority {
  topologyOf(nodes, edges)
  if (!memo!.priorities) memo!.priorities = busPriorities(memo!.topo)
  return memo!.priorities.get(busbarId) ?? 'unassigned'
}

export interface TraceView {
  kind: 'upstream' | 'downstream'
  elementId: string
  nodeIds: Set<string>
  edgeIds: Set<string>
  paths: UpstreamPath[]
  downstream: Downstream | null
  firstProtective: string | null
}

/** What the canvas lights for a trace: the paths to every source, or what
 *  the element would drop; the element itself and the wires joining it to
 *  its buses always. Null when the element is gone. */
export function traceView(nodes: AppNode[], edges: AppEdge[], kind: 'upstream' | 'downstream', elementId: string): TraceView | null {
  const topo = topologyOf(nodes, edges)
  const own = topo.elementBuses.get(elementId)
  if (!own) return null
  let buses: string[] = []
  let elements: string[] = []
  let paths: UpstreamPath[] = []
  let down: Downstream | null = null
  if (kind === 'upstream') {
    paths = upstreamPaths(topo, elementId)
    for (const p of paths) {
      buses.push(...p.buses)
      elements.push(p.sourceId, ...p.elements)
    }
  } else {
    down = downstream(topo, elementId)
    buses = [...down.buses]
    elements = [...down.nodeIds, ...down.edgeIds]
  }
  const lit = highlightOf(topo, buses, elements)
  const nodeIds = new Set([...lit.nodeIds, elementId])
  // Downstream, everything in a lost bus goes dark with it, wires and all;
  // upstream only the wires joining the path's own elements are the path.
  const edgeIds = new Set(kind === 'downstream'
    ? lit.edgeIds
    : lit.edgeIds.filter((id) => {
      const e = topo.edges.find((x) => x.id === id)!
      return e.type === 'line' || (nodeIds.has(e.source) && nodeIds.has(e.target))
    }))
  if (topo.edges.some((e) => e.id === elementId)) edgeIds.add(elementId)
  // The wires from the element to buses that are lit.
  const litBuses = new Set(buses)
  for (const e of topo.edges) {
    if (e.type === 'line' || (e.source !== elementId && e.target !== elementId)) continue
    const other = e.source === elementId ? e.target : e.source
    if (litBuses.has(topo.wireBus.get(e.id) ?? '') && (kind === 'downstream' || nodeIds.has(other))) edgeIds.add(e.id)
  }
  return { kind, elementId, nodeIds, edgeIds, paths, downstream: down, firstProtective: firstProtectiveUpstream(topo, elementId) }
}
