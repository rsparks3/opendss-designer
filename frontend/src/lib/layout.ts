import dagre from '@dagrejs/dagre'
import { NODE_SIZE, SYMBOL_PITCH } from './defaults'
import type { CircuitEdgeJSON, CircuitJSON, CircuitNodeJSON } from '../types/circuit'

const snap = (v: number) => Math.round(v / 10) * 10

/** 1-terminal shunt devices that hang beneath their busbar. */
export const SHUNT_TYPES = new Set(['load', 'capacitor', 'generator', 'pvsystem', 'storage'])

/** 2-terminal series devices that sit between the buses they join, t1 upstream. */
const SERIES_TYPES = new Set([
  'transformer', 'regulator', 'breaker', 'fuse', 'recloser', 'relay',
])

/** Horizontal pitch of things hung beneath a bar or spread between two
 *  buses: a symbol is 40 wide, its name wider, and 80 keeps the names apart
 *  while landing every drop on the bar's 20 px handle pitch. */
const SLOT = 80
/** Bar left/right margin beyond the outermost slot. */
const BUS_MARGIN = 20
const MIN_BUS_W = 120
/** Vertical gap between the bar and the row of shunts beneath it. */
const HANG_GAP = 40
/** Room a hanging row needs below the bar: the gap, the symbol, its label. */
const HANG_ROW_H = HANG_GAP + NODE_SIZE.load.h + 30

function busbarHandleCount(width: number): number {
  return Math.max(2, Math.floor(width / SYMBOL_PITCH))
}

const snapBusbarWidth = (w: number) => Math.max(60, Math.round(w / SYMBOL_PITCH) * SYMBOL_PITCH)

function sizeOf(n: CircuitNodeJSON): { w: number; h: number } {
  const size = NODE_SIZE[n.type]
  return { w: n.type === 'busbar' ? (n.width ?? size.w) : size.w, h: size.h }
}

function center(n: CircuitNodeJSON): { x: number; y: number } {
  const { w, h } = sizeOf(n)
  return { x: (n.position?.x ?? 0) + w / 2, y: (n.position?.y ?? 0) + h / 2 }
}

/** The one busbar a shunt device is wired to, if that is how it connects.
 *  A load wired straight onto a transformer terminal stays in the ranked
 *  graph instead of hanging. */
function hangingBus(n: CircuitNodeJSON, circuit: CircuitJSON, byId: Map<string, CircuitNodeJSON>) {
  if (!SHUNT_TYPES.has(n.type)) return null
  const attached = circuit.edges.filter((e) => e.source === n.id || e.target === n.id)
  if (attached.length !== 1) return null
  const e = attached[0]
  const other = byId.get(e.source === n.id ? e.target : e.source)
  return other?.type === 'busbar' ? other : null
}

/** Hop distance from the nearest source over every connection, so edges
 *  can be pointed the way power flows regardless of how they were drawn. */
function distancesFromSources(circuit: CircuitJSON): Map<string, number> {
  const adj = new Map<string, string[]>()
  for (const e of circuit.edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
    adj.set(e.target, [...(adj.get(e.target) ?? []), e.source])
  }
  const dist = new Map<string, number>()
  const queue: string[] = []
  for (const n of circuit.nodes) {
    if (n.type === 'vsource') {
      dist.set(n.id, 0)
      queue.push(n.id)
    }
  }
  while (queue.length) {
    const id = queue.shift()!
    for (const next of adj.get(id) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(id)! + 1)
        queue.push(next)
      }
    }
  }
  return dist
}

/** Edges oriented in the direction power flows, so dagre's ranks read
 *  top-down: sources above buses, loads below, and the t1 (primary) side of
 *  a transformer/breaker upstream of its t2 side. Distance from the source
 *  decides; the terminal roles break ties and cover islands. */
function orientedEdges(circuit: CircuitJSON, dist: Map<string, number>): [string, string][] {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  return circuit.edges.map((e): [string, string] => {
    const ds = dist.get(e.source)
    const dt = dist.get(e.target)
    if (ds !== undefined && dt !== undefined && ds !== dt) {
      return ds < dt ? [e.source, e.target] : [e.target, e.source]
    }
    const s = byId.get(e.source)
    const t = byId.get(e.target)
    if (s && SHUNT_TYPES.has(s.type)) return [e.target, e.source]
    if (t && SHUNT_TYPES.has(t.type)) return [e.source, e.target]
    if (s?.type === 'vsource') return [e.source, e.target]
    if (t?.type === 'vsource') return [e.target, e.source]
    if (s && SERIES_TYPES.has(s.type)) {
      return e.sourceHandle === 't1' ? [e.target, e.source] : [e.source, e.target]
    }
    if (t && SERIES_TYPES.has(t.type)) {
      return e.targetHandle === 't1' ? [e.source, e.target] : [e.target, e.source]
    }
    return [e.source, e.target]
  })
}

/**
 * Lay out a circuit as a top-down tree (mutates in place): the source at
 * the top, power flowing downward, every shunt device in one evenly spaced
 * row directly beneath its busbar, each bar wide enough for everything that
 * leaves it, series devices centred between the buses they join and spread
 * apart when several share the same pair, nothing overlapping. Positions,
 * busbar widths and busbar handles are all rewritten; rotations are reset
 * and routing points dropped, since the whole drawing is being redone.
 *
 * Two dagre passes: the first only to learn which neighbours of a bar end up
 * above and below it, which sets the bar's width; the second with the real
 * widths, and with each bar tall enough to hold its hanging row so the next
 * rank starts beneath the loads.
 */
export function autoLayout(circuit: CircuitJSON): void {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  const dist = distancesFromSources(circuit)
  const oriented = orientedEdges(circuit, dist)

  // Shunts that hang beneath a bar are placed by hand after ranking; the
  // ranked graph holds everything else.
  const hung = new Map<string, CircuitNodeJSON[]>()
  const hungIds = new Set<string>()
  for (const n of circuit.nodes) {
    const bus = hangingBus(n, circuit, byId)
    if (bus) {
      hung.set(bus.id, [...(hung.get(bus.id) ?? []), n])
      hungIds.add(n.id)
    }
  }
  for (const n of circuit.nodes) {
    n.params = { ...n.params }
    delete n.params.rotation
  }
  for (const e of circuit.edges) e.waypoints = null

  const ranked = circuit.nodes.filter((n) => !hungIds.has(n.id))
  const rankedEdges = oriented.filter(([a, b]) => !hungIds.has(a) && !hungIds.has(b))

  const run = () => {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const n of ranked) {
      const { w, h } = sizeOf(n)
      const row = hung.has(n.id) ? HANG_ROW_H : 0
      g.setNode(n.id, { width: w + 20, height: h + 30 + row })
    }
    for (const [a, b] of rankedEdges) g.setEdge(a, b)
    dagre.layout(g)
    for (const n of ranked) {
      const pos = g.node(n.id)
      if (!pos) continue
      const { w, h } = sizeOf(n)
      const row = hung.has(n.id) ? HANG_ROW_H : 0
      // A bar sits at the top of its box; the hanging row fills the rest.
      const top = pos.y - (h + 30 + row) / 2 + 15
      n.position = { x: snap(pos.x - w / 2), y: snap(top) }
    }
  }

  run()
  sizeBusbars(circuit, hung)
  run()
  spreadDevicesBetweenBuses(circuit, hungIds)
  centerSourcesAboveBuses(circuit)
  separateOverlaps(circuit, hungIds)
  arrangeBelowBusbars(circuit, hung)
  assignUpwardHandles(circuit)
}

/** A bar is as wide as the busier of its two sides needs: one slot for
 *  every hanging device and every connection leaving downward, one for every
 *  connection arriving from above. */
function sizeBusbars(circuit: CircuitJSON, hung: Map<string, CircuitNodeJSON[]>): void {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  for (const bus of circuit.nodes) {
    if (bus.type !== 'busbar') continue
    const busY = bus.position?.y ?? 0
    let above = 0
    let below = hung.get(bus.id)?.length ?? 0
    for (const e of circuit.edges) {
      if (e.source !== bus.id && e.target !== bus.id) continue
      const other = byId.get(e.source === bus.id ? e.target : e.source)
      if (!other || (hung.get(bus.id) ?? []).includes(other)) continue
      if ((other.position?.y ?? 0) < busY) above += 1
      else below += 1
    }
    const slots = Math.max(above, below, 1)
    bus.width = snapBusbarWidth(Math.max(MIN_BUS_W, slots * SLOT + 2 * BUS_MARGIN))
  }
}

/** Two-terminal devices sit midway between the buses they connect. Several
 *  joining the same pair (a bank of single-phase regulators) fan out around
 *  that midpoint instead of landing on top of each other. */
function spreadDevicesBetweenBuses(circuit: CircuitJSON, hungIds: Set<string>): void {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  const groups = new Map<string, CircuitNodeJSON[]>()
  const neighbours = new Map<string, CircuitNodeJSON[]>()
  for (const n of circuit.nodes) {
    if (!SERIES_TYPES.has(n.type) || hungIds.has(n.id)) continue
    const buses: CircuitNodeJSON[] = []
    for (const e of circuit.edges) {
      const other =
        e.source === n.id ? byId.get(e.target) : e.target === n.id ? byId.get(e.source) : null
      if (other && other.type === 'busbar') buses.push(other)
    }
    if (!buses.length) continue
    neighbours.set(n.id, buses)
    const key = buses.map((b) => b.id).sort().join('|')
    groups.set(key, [...(groups.get(key) ?? []), n])
  }
  for (const group of groups.values()) {
    const buses = neighbours.get(group[0].id)!
    const mid = buses.reduce((sum, b) => sum + center(b).x, 0) / buses.length
    group.sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0))
    const w = NODE_SIZE[group[0].type].w
    group.forEach((n, i) => {
      const offset = (i - (group.length - 1) / 2) * SLOT
      n.position = { x: snap(mid + offset - w / 2), y: n.position?.y ?? 0 }
    })
  }
}

/** Everything that leaves a bar downward gets a slot of its own in one
 *  evenly spaced row centred on the bar: a shunt device sits in its slot so
 *  its drop is a straight vertical wire, and a line or device heading to a
 *  bus further down drops from its slot to a routing point just below the
 *  hanging row before turning towards its target, so it never runs through
 *  a load. Slots are ordered by where the other end is, shunts in the
 *  middle. */
function arrangeBelowBusbars(circuit: CircuitJSON, hung: Map<string, CircuitNodeJSON[]>): void {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  for (const bus of circuit.nodes) {
    if (bus.type !== 'busbar') continue
    const width = bus.width ?? NODE_SIZE.busbar.w
    const count = busbarHandleCount(width)
    const bx = bus.position?.x ?? 0
    const by = bus.position?.y ?? 0
    const mid = bx + width / 2
    const row = hung.get(bus.id) ?? []
    type Below = { e: CircuitEdgeJSON; node: CircuitNodeJSON | undefined; x: number; shunt: boolean }
    const below: Below[] = []
    for (const e of circuit.edges) {
      if (e.source !== bus.id && e.target !== bus.id) continue
      const other = byId.get(e.source === bus.id ? e.target : e.source)
      if (!other) continue
      if (row.includes(other)) {
        below.push({ e, node: other, x: mid, shunt: true })
      } else if ((other.position?.y ?? 0) > by) {
        below.push({ e, node: other, x: center(other).x, shunt: false })
      }
    }
    if (!below.length) continue
    below.sort((a, b) => a.x - b.x)
    const n = below.length
    const bend = by + NODE_SIZE.busbar.h + HANG_ROW_H - 10
    below.forEach((item, i) => {
      // Slots land on the handle grid (10, 30, 50 … from the bar's left
      // edge) so every drop leaves the bar dead vertical.
      const wanted = mid + (i - (n - 1) / 2) * SLOT
      const idx = Math.min(count - 1, Math.max(0, Math.round((wanted - bx) / SYMBOL_PITCH - 0.5)))
      const slotX = bx + (idx + 0.5) * SYMBOL_PITCH
      const handle = `c${idx}`
      if (item.e.source === bus.id) item.e.sourceHandle = handle
      else item.e.targetHandle = handle
      if (item.shunt && item.node) {
        const w = NODE_SIZE[item.node.type].w
        item.node.position = { x: snap(slotX - w / 2), y: snap(by + NODE_SIZE.busbar.h + HANG_GAP) }
      } else if (row.length && item.node) {
        // Down from the slot, across beneath the hanging row, down into the
        // target: the last point sits over the target's own terminal so the
        // final leg is vertical too.
        const tx = terminalX(item.node)
        const y = snap(bend)
        item.e.waypoints = tx === slotX ? [{ x: slotX, y }] : [{ x: slotX, y }, { x: tx, y }]
        if (item.e.target === bus.id) item.e.waypoints.reverse()
      }
    })
  }
}

/** Where a wire arriving from above meets a node: a symbol's terminal is at
 *  its centre; a bar's is the top-row handle nearest its centre. */
function terminalX(n: CircuitNodeJSON): number {
  const c = center(n).x
  if (n.type !== 'busbar') return snap(c)
  const x = n.position?.x ?? 0
  const width = n.width ?? NODE_SIZE.busbar.w
  const idx = Math.min(busbarHandleCount(width) - 1, Math.max(0, Math.round((c - x) / SYMBOL_PITCH - 0.5)))
  return x + (idx + 0.5) * SYMBOL_PITCH
}

/** Anything still overlapping something else in its row is pushed right.
 *  Dagre keeps ranked nodes apart; this catches what the centring steps
 *  above may have moved together. Hanging rows move with their bar. */
function separateOverlaps(circuit: CircuitJSON, hungIds: Set<string>): void {
  const boxes = circuit.nodes
    .filter((n) => !hungIds.has(n.id))
    .map((n) => {
      const { w, h } = sizeOf(n)
      return { n, x: n.position?.x ?? 0, y: n.position?.y ?? 0, w, h }
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const GAP = 20
  for (let i = 0; i < boxes.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = boxes[j]
      const b = boxes[i]
      const overlapY = a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP
      const overlapX = a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP
      if (overlapY && overlapX) {
        const dx = snap(a.x + a.w + GAP - b.x)
        b.x += dx
        b.n.position = { x: b.x, y: b.y }
        shiftHangingRow(circuit, b.n, dx)
      }
    }
  }
}

function shiftHangingRow(circuit: CircuitJSON, bus: CircuitNodeJSON, dx: number): void {
  if (bus.type !== 'busbar') return
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  for (const e of circuit.edges) {
    const other = e.source === bus.id ? byId.get(e.target) : e.target === bus.id ? byId.get(e.source) : null
    if (other && SHUNT_TYPES.has(other.type) && other.position) {
      other.position = { x: other.position.x + dx, y: other.position.y }
    }
  }
}

/** Sources sit directly above the bus they feed. */
function centerSourcesAboveBuses(circuit: CircuitJSON): void {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  for (const n of circuit.nodes) {
    if (n.type !== 'vsource') continue
    for (const e of circuit.edges) {
      const other =
        e.source === n.id ? byId.get(e.target) : e.target === n.id ? byId.get(e.source) : null
      if (other?.type === 'busbar') {
        n.position = {
          x: snap(center(other).x - NODE_SIZE.vsource.w / 2),
          y: snap((other.position?.y ?? 0) - 120),
        }
        break
      }
    }
  }
}

/** Connections arriving at a bar from above take the top-row handle nearest
 *  the other end's x, two wanting the same handle taking neighbouring ones. */
function assignUpwardHandles(circuit: CircuitJSON): void {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  for (const bus of circuit.nodes.filter((n) => n.type === 'busbar')) {
    const width = bus.width ?? NODE_SIZE.busbar.w
    const count = busbarHandleCount(width)
    const busX = bus.position?.x ?? 0
    const busY = bus.position?.y ?? 0
    const want: { e: CircuitEdgeJSON; idx: number }[] = []
    for (const e of circuit.edges) {
      if (e.source !== bus.id && e.target !== bus.id) continue
      const other = byId.get(e.source === bus.id ? e.target : e.source)
      const c = other ? center(other) : { x: busX, y: busY + 1 }
      if (c.y > busY) continue
      // A routed line arrives from its last bend, not from the far bus.
      const wp = e.waypoints?.length
        ? e.target === bus.id ? e.waypoints[e.waypoints.length - 1] : e.waypoints[0]
        : null
      const idx = Math.round(((wp?.x ?? c.x) - busX) / SYMBOL_PITCH - 0.5)
      want.push({ e, idx: Math.min(count - 1, Math.max(0, idx)) })
    }
    const taken = new Set<number>()
    for (const w of want.sort((a, b) => a.idx - b.idx)) {
      let idx = w.idx
      for (let step = 1; taken.has(idx) && step <= count; step++) {
        const right = w.idx + step
        const left = w.idx - step
        if (right < count && !taken.has(right)) idx = right
        else if (left >= 0 && !taken.has(left)) idx = left
      }
      taken.add(idx)
      const handle = `b${idx}`
      if (w.e.source === bus.id) w.e.sourceHandle = handle
      else w.e.targetHandle = handle
    }
  }
}

/** Positions, widths and handles from a laid-out copy, keyed by id, for
 *  applying a layout to a live circuit. */
export function layoutPatch(circuit: CircuitJSON): {
  nodes: Map<string, { position: { x: number; y: number }; width?: number }>
  edges: Map<string, Pick<CircuitEdgeJSON, 'sourceHandle' | 'targetHandle' | 'waypoints'>>
} {
  return {
    nodes: new Map(
      circuit.nodes.map((n) => [
        n.id,
        { position: n.position ?? { x: 0, y: 0 }, width: n.type === 'busbar' ? (n.width ?? undefined) : undefined },
      ]),
    ),
    edges: new Map(
      circuit.edges.map((e) => [
        e.id,
        { sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, waypoints: e.waypoints },
      ]),
    ),
  }
}
