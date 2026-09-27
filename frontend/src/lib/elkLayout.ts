import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPort } from 'elkjs/lib/elk.bundled.js'
import { NODE_SIZE, SYMBOL_PITCH } from './defaults'
import {
  BUS_MARGIN,
  busbarHandleCount,
  HANG_ROW_H,
  layoutBasics,
  MIN_BUS_W,
  prepareNodes,
  sizeOf,
  SLOT,
  snapBusbarWidth,
  type LayoutOptions,
} from './layout'
import { rotatePoint } from './rotatePoint'
import type { CircuitEdgeJSON, CircuitJSON, CircuitNodeJSON } from '../types/circuit'

/**
 * Arrange → Layered layout with routed wires: the Eclipse Layout Kernel's
 * layered algorithm (elkjs), which places the circuit and also routes every
 * connection in right angles around the symbols. This module is loaded on
 * first use, so the engine (a few hundred kB) never weighs on start-up.
 *
 * The house rules of Clean up carry over: every shunt device hangs in one
 * row beneath its bar (so a bar and its row are one box to ELK), bars are
 * sized to what leaves them, compact pass-through bars stay short, and each
 * symbol's terminals are fixed ports so routes end exactly where the wires
 * attach. ELK's bend points become the edges' routing points.
 */

const snap = (v: number) => Math.round(v / 10) * 10
const BAR_H = NODE_SIZE.busbar.h

type XY = { x: number; y: number }
type Side = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST'
const SIDES: Side[] = ['NORTH', 'EAST', 'SOUTH', 'WEST']

/** Where each terminal of an upright symbol is, and which side it leaves. */
function baseTerminals(n: CircuitNodeJSON): Record<string, { x: number; y: number; side: Side }> {
  const { w, h } = NODE_SIZE[n.type]
  if (n.type === 'vsource') return { t1: { x: w / 2, y: h, side: 'SOUTH' } }
  if (n.type === 'transformer') {
    const three = Array.isArray(n.params?.windings) && (n.params.windings as unknown[]).length >= 3
    const tw = three ? 60 : 40
    return {
      t1: { x: 20, y: 0, side: 'NORTH' },
      t2: { x: 20, y: h, side: 'SOUTH' },
      ...(three ? { t3: { x: tw, y: 40, side: 'EAST' as Side } } : {}),
    }
  }
  if (['regulator', 'breaker', 'fuse', 'recloser', 'relay'].includes(n.type)) {
    return { t1: { x: w / 2, y: 0, side: 'NORTH' }, t2: { x: w / 2, y: h, side: 'SOUTH' } }
  }
  return { t1: { x: w / 2, y: 0, side: 'NORTH' } }
}

/** The same terminals once the symbol is turned (a left-to-right layout
 *  lays series devices on their side). */
function terminals(n: CircuitNodeJSON): Record<string, { x: number; y: number; side: Side }> {
  const rot = Number(n.params?.rotation) || 0
  const steps = ((Math.round(rot / 90) % 4) + 4) % 4
  const { w, h } = n.type === 'transformer' && baseTerminals(n).t3 ? { w: 60, h: 80 } : NODE_SIZE[n.type]
  const out: Record<string, { x: number; y: number; side: Side }> = {}
  for (const [id, t] of Object.entries(baseTerminals(n))) {
    const p = rotatePoint(t.x, t.y, w, h, rot)
    out[id] = { x: p.x, y: p.y, side: SIDES[(SIDES.indexOf(t.side) + steps) % 4] }
  }
  return out
}

function symbolBox(n: CircuitNodeJSON): { w: number; h: number } {
  if (n.type === 'transformer' && baseTerminals(n).t3) {
    return (Number(n.params?.rotation) || 0) % 180 ? { w: 80, h: 60 } : { w: 60, h: 80 }
  }
  return sizeOf(n)
}

/** Keep a route orthogonal after its end moved from `was` to `now`: the
 *  neighbouring bend takes the new coordinate along the segment's axis. */
function reattach(was: XY, now: XY, bend: XY | undefined): void {
  if (!bend) return
  if (Math.abs(bend.x - was.x) < Math.abs(bend.y - was.y)) bend.x = now.x
  else bend.y = now.y
}

export async function elkLayout(circuit: CircuitJSON, opts: LayoutOptions = {}): Promise<void> {
  const direction = opts.direction ?? 'TB'
  const { byId, oriented, hung, hungIds } = layoutBasics(circuit)
  prepareNodes(circuit, hung, direction)

  // Which way each edge runs, upstream first, keyed by edge id.
  const flow = new Map<string, [string, string]>()
  circuit.edges.forEach((e, i) => flow.set(e.id, oriented[i]))
  const routed = circuit.edges.filter((e) => !hungIds.has(e.source) && !hungIds.has(e.target))

  // Bars: wide enough for the busier side, counted from the flow.
  for (const bus of circuit.nodes) {
    if (bus.type !== 'busbar') continue
    if (bus.params?.compact) {
      bus.width = 60
      continue
    }
    let inward = 0
    let outward = hung.get(bus.id)?.length ?? 0
    for (const e of routed) {
      const [from, to] = flow.get(e.id)!
      if (to === bus.id) inward++
      else if (from === bus.id) outward++
    }
    const slots = Math.max(inward, outward, 1)
    bus.width = snapBusbarWidth(Math.max(MIN_BUS_W, slots * SLOT + 2 * BUS_MARGIN))
  }

  // --- the ELK graph -------------------------------------------------------
  const portOf = (e: CircuitEdgeJSON, nodeId: string): string => {
    const n = byId.get(nodeId)!
    if (n.type === 'busbar') return `${e.id}@${nodeId}`
    const handle = (e.source === nodeId ? e.sourceHandle : e.targetHandle) || 't1'
    return `${nodeId}:${handle}`
  }
  const children: ElkNode[] = []
  for (const n of circuit.nodes) {
    if (hungIds.has(n.id)) continue
    if (n.type === 'busbar') {
      const height = BAR_H + (hung.has(n.id) ? HANG_ROW_H : 0)
      const ports: ElkPort[] = []
      for (const e of routed) {
        if (e.source !== n.id && e.target !== n.id) continue
        const into = flow.get(e.id)![1] === n.id
        // Across the page, every line meets a bar from above: bottom ports
        // would make each bar sit lower than the last, a staircase, where
        // top ports let the trunk run level with the loads still beneath.
        const side = direction === 'LR' || into ? 'NORTH' : 'SOUTH'
        ports.push({
          id: portOf(e, n.id),
          width: 1,
          height: 1,
          layoutOptions: { 'elk.port.side': side },
        })
      }
      children.push({
        id: n.id,
        width: n.width ?? NODE_SIZE.busbar.w,
        height,
        ports,
        layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
      })
    } else {
      const { w, h } = symbolBox(n)
      children.push({
        id: n.id,
        width: w,
        height: h,
        ports: Object.entries(terminals(n)).map(([handle, t]) => ({
          id: `${n.id}:${handle}`,
          x: t.x,
          y: t.y,
          width: 0,
          height: 0,
          layoutOptions: { 'elk.port.side': t.side },
        })),
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      })
    }
  }
  const edges: ElkExtendedEdge[] = routed.map((e) => {
    const [from, to] = flow.get(e.id)!
    return { id: e.id, sources: [portOf(e, from)], targets: [portOf(e, to)] }
  })

  const elk = new ELK()
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '50',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      'elk.spacing.edgeEdge': '10',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children,
    edges,
  })

  // --- read it back --------------------------------------------------------
  const placed = new Map((graph.children ?? []).map((c) => [c.id, c]))
  const portAt = new Map<string, XY>()
  for (const c of graph.children ?? []) {
    for (const p of c.ports ?? []) portAt.set(p.id, { x: (c.x ?? 0) + (p.x ?? 0), y: (c.y ?? 0) + (p.y ?? 0) })
  }
  for (const n of circuit.nodes) {
    const c = placed.get(n.id)
    if (c) n.position = { x: snap(c.x ?? 0), y: snap(c.y ?? 0) }
  }

  // Bar handles: the bottom row shares out its slots between the hanging
  // row and the connections leaving downward, in the order ELK put the
  // ports; the top row takes the handle nearest each arriving port.
  const handleAt = new Map<string, XY>() // port id -> the handle's point on the bar
  const boxBottom = new Map<string, number>()
  for (const bus of circuit.nodes) {
    if (bus.type !== 'busbar' || hungIds.has(bus.id)) continue
    const width = bus.width ?? NODE_SIZE.busbar.w
    const count = busbarHandleCount(width)
    const bx = bus.position?.x ?? 0
    const by = bus.position?.y ?? 0
    const mid = bx + width / 2
    const row = hung.get(bus.id) ?? []
    if (row.length) boxBottom.set(bus.id, by + BAR_H + HANG_ROW_H)
    type Slot = { x: number; port?: string; edge?: CircuitEdgeJSON; shunt?: CircuitNodeJSON }
    const down: Slot[] = []
    const up: Slot[] = []
    for (const e of routed) {
      if (e.source !== bus.id && e.target !== bus.id) continue
      const port = portOf(e, bus.id)
      const at = portAt.get(port) ?? { x: mid, y: by }
      ;(direction === 'LR' || flow.get(e.id)![1] === bus.id ? up : down).push({ x: at.x, port, edge: e })
    }
    // Shunts sit in the middle of the row, between what leaves left and right.
    const shunts: Slot[] = row.map((s) => ({ x: mid, shunt: s }))
    const bottom = [...down, ...shunts].sort((a, b) => a.x - b.x)
    bottom.forEach((slot, i) => {
      const wanted = mid + (i - (bottom.length - 1) / 2) * SLOT
      const idx = Math.min(count - 1, Math.max(0, Math.round((wanted - bx) / SYMBOL_PITCH - 0.5)))
      const x = bx + (idx + 0.5) * SYMBOL_PITCH
      if (slot.shunt) {
        const w = NODE_SIZE[slot.shunt.type].w
        slot.shunt.position = { x: snap(x - w / 2), y: snap(by + BAR_H + 40) }
        for (const e of circuit.edges) {
          if (e.source === bus.id && e.target === slot.shunt.id) e.sourceHandle = `c${idx}`
          else if (e.target === bus.id && e.source === slot.shunt.id) e.targetHandle = `c${idx}`
        }
      } else if (slot.edge && slot.port) {
        if (slot.edge.source === bus.id) slot.edge.sourceHandle = `c${idx}`
        else slot.edge.targetHandle = `c${idx}`
        handleAt.set(slot.port, { x, y: by + BAR_H })
      }
    })
    const taken = new Set<number>()
    for (const slot of up.sort((a, b) => a.x - b.x)) {
      let idx = Math.min(count - 1, Math.max(0, Math.round((slot.x - bx) / SYMBOL_PITCH - 0.5)))
      for (let step = 1; taken.has(idx) && step <= count; step++) {
        if (idx + step < count && !taken.has(idx + step)) idx += step
        else if (idx - step >= 0 && !taken.has(idx - step)) idx -= step
      }
      taken.add(idx)
      if (slot.edge!.source === bus.id) slot.edge!.sourceHandle = `b${idx}`
      else slot.edge!.targetHandle = `b${idx}`
      handleAt.set(slot.port!, { x: bx + (idx + 0.5) * SYMBOL_PITCH, y: by })
    }
  }
  // A symbol's terminal is where ELK put the port, less the snapping.
  for (const n of circuit.nodes) {
    if (n.type === 'busbar' || hungIds.has(n.id)) continue
    for (const [handle, t] of Object.entries(terminals(n))) {
      handleAt.set(`${n.id}:${handle}`, { x: (n.position?.x ?? 0) + t.x, y: (n.position?.y ?? 0) + t.y })
    }
  }

  // Routes: ELK's bend points, re-attached to the snapped handles, with a
  // drop past the hanging row first where a line leaves a bar that has one.
  const laid = new Map((graph.edges ?? []).map((e) => [e.id, e]))
  for (const e of routed) {
    const section = laid.get(e.id)?.sections?.[0]
    if (!section) continue
    const [from, to] = flow.get(e.id)!
    const fromPort = portOf(e, from)
    const toPort = portOf(e, to)
    const start = handleAt.get(fromPort) ?? section.startPoint
    const end = handleAt.get(toPort) ?? section.endPoint
    const bends = (section.bendPoints ?? []).map((p) => ({ x: p.x, y: p.y }))
    const pts: XY[] = []
    const below = boxBottom.get(from)
    if (below !== undefined && byId.get(from)?.type === 'busbar' && direction !== 'LR') {
      // Straight down from the slot to beneath the hanging row, then ELK's way.
      const drop = { x: start.x, y: below }
      reattach(section.startPoint, drop, bends[0])
      pts.push(drop)
    } else {
      reattach(section.startPoint, start, bends[0])
    }
    reattach(section.endPoint, end, bends[bends.length - 1])
    pts.push(...bends)
    const waypoints = pts
      .map((p) => ({ x: snap(p.x), y: snap(p.y) }))
      .filter((p, i, all) => i === 0 || p.x !== all[i - 1].x || p.y !== all[i - 1].y)
    // Stored the way the edge was drawn, which may be against the flow.
    if (e.source !== from) waypoints.reverse()
    e.waypoints = waypoints.length ? waypoints : null
  }
}
