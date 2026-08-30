import dagre from '@dagrejs/dagre'
import { NODE_SIZE } from './defaults'
import type { CircuitJSON, CircuitNodeJSON } from '../types/circuit'

const snap = (v: number) => Math.round(v / 10) * 10

/** Assign positions to an imported circuit (mutates in place).
 *
 *  If the model came with bus coordinates (BusCoords), the busbars are
 *  already positioned by the backend — element nodes are then placed
 *  around their buses. Otherwise everything gets a tree-ish top-down
 *  dagre layout. Either way, busbar connections are finally distributed
 *  across the top/bottom handle rows. */
export function autoLayout(circuit: CircuitJSON): void {
  const positionedBusbars = circuit.nodes.filter((n) => n.type === 'busbar' && n.position)
  if (positionedBusbars.length >= 2) {
    placeAroundCoordinates(circuit)
  } else {
    dagreLayout(circuit)
  }
  distributeBusbarHandles(circuit)
}

function center(n: CircuitNodeJSON): { x: number; y: number } {
  const size = NODE_SIZE[n.type]
  const w = n.type === 'busbar' ? (n.width ?? size.w) : size.w
  return { x: (n.position?.x ?? 0) + w / 2, y: (n.position?.y ?? 0) + size.h / 2 }
}

/** Place unpositioned element nodes near the buses they connect to. */
function placeAroundCoordinates(circuit: CircuitJSON): void {
  const byId = new Map(circuit.nodes.map((n) => [n.id, n]))
  const perAnchor = new Map<string, number>() // crowding counter per anchor node

  for (const n of circuit.nodes) {
    if (n.position) continue
    const anchors: CircuitNodeJSON[] = []
    for (const e of circuit.edges) {
      const other =
        e.source === n.id ? byId.get(e.target) : e.target === n.id ? byId.get(e.source) : null
      if (other?.position) anchors.push(other)
    }
    const size = NODE_SIZE[n.type]
    if (anchors.length >= 2) {
      // Two-terminal device (transformer/breaker) between two placed buses.
      const a = center(anchors[0])
      const b = center(anchors[1])
      n.position = {
        x: snap((a.x + b.x) / 2 - size.w / 2),
        y: snap((a.y + b.y) / 2 - size.h / 2),
      }
    } else if (anchors.length === 1) {
      const a = center(anchors[0])
      const k = perAnchor.get(anchors[0].id) ?? 0
      perAnchor.set(anchors[0].id, k + 1)
      const col = (k % 3) - 1
      const row = Math.floor(k / 3)
      const below = n.type !== 'vsource'
      n.position = {
        x: snap(a.x + col * 90 - size.w / 2),
        y: snap(a.y + (below ? 90 + row * 90 : -(140 + row * 90))),
      }
    } else {
      const k = perAnchor.get('__orphan__') ?? 0
      perAnchor.set('__orphan__', k + 1)
      n.position = { x: -200, y: k * 120 }
    }
  }
}

function dagreLayout(circuit: CircuitJSON): void {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const n of circuit.nodes) {
    const size = NODE_SIZE[n.type]
    g.setNode(n.id, {
      width: n.type === 'busbar' ? (n.width ?? size.w) : size.w,
      height: size.h + 24, // room for labels
    })
  }
  for (const e of circuit.edges) {
    g.setEdge(e.source, e.target)
  }
  dagre.layout(g)

  for (const n of circuit.nodes) {
    const pos = g.node(n.id)
    if (pos) {
      n.position = {
        x: snap(pos.x - pos.width / 2),
        y: snap(pos.y - pos.height / 2),
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
