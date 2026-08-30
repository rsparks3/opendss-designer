import dagre from '@dagrejs/dagre'
import { NODE_SIZE } from './defaults'
import type { CircuitJSON, CircuitNodeJSON } from '../types/circuit'

const snap = (v: number) => Math.round(v / 10) * 10

/** 1-terminal shunt devices that hang below their busbar like loads. */
const SHUNT_TYPES = new Set(['load', 'capacitor', 'generator', 'pvsystem', 'storage'])

/** Lay out an imported circuit hierarchically (mutates in place): source at
 *  the top, power flowing downward, loads hanging directly beneath their
 *  busbars, transformers/breakers centered between the buses they join.
 *  Finally, busbar connections are distributed across the top/bottom handle
 *  rows so wires never loop over a bar. */
export function autoLayout(circuit: CircuitJSON): void {
  rankWithDagre(circuit)
  alignDevicesBetweenBuses(circuit)
  hangLoadsUnderBuses(circuit)
  centerSourcesAboveBuses(circuit)
  distributeBusbarHandles(circuit)
}

function center(n: CircuitNodeJSON): { x: number; y: number } {
  const size = NODE_SIZE[n.type]
  const w = n.type === 'busbar' ? (n.width ?? size.w) : size.w
  return { x: (n.position?.x ?? 0) + w / 2, y: (n.position?.y ?? 0) + size.h / 2 }
}

/** Edges oriented in the direction power flows, so dagre's ranks read
 *  top-down: sources above buses, loads below, and the t1 (primary) side of
 *  a transformer/breaker upstream of its t2 side. */
function orientedEdges(circuit: CircuitJSON): [string, string][] {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  return circuit.edges.map((e): [string, string] => {
    const s = byId.get(e.source)
    const t = byId.get(e.target)
    if (s && SHUNT_TYPES.has(s.type)) return [e.target, e.source]
    if (t && SHUNT_TYPES.has(t.type)) return [e.source, e.target]
    if (s?.type === 'vsource') return [e.source, e.target]
    if (t?.type === 'vsource') return [e.target, e.source]
    if (s && (s.type === 'transformer' || s.type === 'breaker')) {
      return e.sourceHandle === 't1' ? [e.target, e.source] : [e.source, e.target]
    }
    if (t && (t.type === 'transformer' || t.type === 'breaker')) {
      return e.targetHandle === 't1' ? [e.source, e.target] : [e.target, e.source]
    }
    return [e.source, e.target]
  })
}

function rankWithDagre(circuit: CircuitJSON): void {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 50, ranksep: 90 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of circuit.nodes) {
    const size = NODE_SIZE[n.type]
    g.setNode(n.id, {
      width: (n.type === 'busbar' ? (n.width ?? size.w) : size.w) + 20,
      height: size.h + 30, // room for labels
    })
  }
  for (const [a, b] of orientedEdges(circuit)) {
    g.setEdge(a, b)
  }
  dagre.layout(g)

  for (const n of circuit.nodes) {
    const pos = g.node(n.id)
    if (pos) {
      n.position = { x: snap(pos.x - pos.width / 2), y: snap(pos.y - pos.height / 2) }
    }
  }
}

/** Put each two-terminal device (transformer/breaker) horizontally midway
 *  between the two buses it connects, for straight vertical drops. */
function alignDevicesBetweenBuses(circuit: CircuitJSON): void {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  for (const n of circuit.nodes) {
    if (n.type !== 'transformer' && n.type !== 'breaker') continue
    const neighbors: CircuitNodeJSON[] = []
    for (const e of circuit.edges) {
      const other =
        e.source === n.id ? byId.get(e.target) : e.target === n.id ? byId.get(e.source) : null
      if (other && other.type === 'busbar') neighbors.push(other)
    }
    if (!neighbors.length) continue
    const cx = neighbors.reduce((sum, b) => sum + center(b).x, 0) / neighbors.length
    n.position = { x: snap(cx - NODE_SIZE[n.type].w / 2), y: n.position?.y ?? 0 }
  }
}

/** Shunt devices (loads, capacitors, generators) sit in a row directly
 *  beneath their busbar, spread across its width so their drops land on
 *  distinct bottom handles. */
function hangLoadsUnderBuses(circuit: CircuitJSON): void {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  const perBus = new Map<string, CircuitNodeJSON[]>()
  for (const n of circuit.nodes) {
    if (!SHUNT_TYPES.has(n.type)) continue
    for (const e of circuit.edges) {
      const other =
        e.source === n.id ? byId.get(e.target) : e.target === n.id ? byId.get(e.source) : null
      if (other?.type === 'busbar') {
        perBus.set(other.id, [...(perBus.get(other.id) ?? []), n])
        break
      }
    }
  }
  const size = NODE_SIZE.load
  for (const [busId, loads] of perBus) {
    const bus = byId.get(busId)!
    const width = bus.width ?? NODE_SIZE.busbar.w
    const bx = bus.position?.x ?? 0
    const by = bus.position?.y ?? 0
    const perRow = Math.max(1, Math.floor(width / 70))
    loads.forEach((ld, i) => {
      const row = Math.floor(i / perRow)
      const inRow = Math.min(perRow, loads.length - row * perRow)
      const col = i % perRow
      ld.position = {
        x: snap(bx + ((col + 0.5) * width) / inRow - size.w / 2),
        y: snap(by + 80 + row * 110),
      }
    })
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
          y: snap((other.position?.y ?? 0) - 150),
        }
        break
      }
    }
  }
}

/** Spread busbar connections across handles so wires don't pile onto b0:
 *  sort each busbar's edges by the x position of the other endpoint, and use
 *  the top handle row (b) for elements above the bar, the bottom row (c) for
 *  elements below, so wires never loop over the bar. */
function distributeBusbarHandles(circuit: CircuitJSON): void {
  const posById = new Map(circuit.nodes.map((n) => [n.id, n.position]))
  for (const bus of circuit.nodes.filter((n) => n.type === 'busbar')) {
    const width = bus.width ?? NODE_SIZE.busbar.w
    const count = Math.max(2, Math.floor(width / 20))
    const busY = bus.position?.y ?? 0
    const attached = circuit.edges.filter((e) => e.source === bus.id || e.target === bus.id)
    attached.sort((a, b) => {
      const ax = posById.get(a.source === bus.id ? a.target : a.source)?.x ?? 0
      const bx = posById.get(b.source === bus.id ? b.target : b.source)?.x ?? 0
      return ax - bx
    })
    attached.forEach((e, i) => {
      const otherY = posById.get(e.source === bus.id ? e.target : e.source)?.y ?? 0
      const row = otherY > busY ? 'c' : 'b'
      const handle = `${row}${Math.min(count - 1, Math.round(((i + 0.5) * count) / attached.length))}`
      if (e.source === bus.id) e.sourceHandle = handle
      else e.targetHandle = handle
    })
  }
}
