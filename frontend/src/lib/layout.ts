import dagre from '@dagrejs/dagre'
import { NODE_SIZE } from './defaults'
import type { CircuitJSON } from '../types/circuit'

/** Assign positions to an imported circuit (mutates in place). Tree-ish
 *  top-down layout with the source at the top; the user tidies afterward. */
export function autoLayout(circuit: CircuitJSON): void {
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
        x: Math.round((pos.x - pos.width / 2) / 10) * 10,
        y: Math.round((pos.y - pos.height / 2) / 10) * 10,
      }
    }
  }

  // Spread busbar connections across handles so wires don't pile onto b0:
  // sort each busbar's edges by the x position of the other endpoint, and use
  // the top handle row (b) for elements above the bar, the bottom row (c) for
  // elements below, so wires never loop over the bar.
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
