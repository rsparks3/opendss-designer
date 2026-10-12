// Where each element sits on the map.
//
// Only some things have coordinates of their own: buses (BusCoords), and
// whatever a GIS layer placed. Everything else is placed from its
// neighbours, the way a planning tool's map does it: a transformer or a
// switch midway between the buses it joins, a load or a capacitor at its bus
// (the map fans those out around the bus on screen), and a bus the file gave
// no coordinates to in the middle of the buses around it. Placement spreads
// outward one connection at a time, so it is linear in the size of the
// circuit; elements no placed neighbour reaches are left off the map.

import type { AppEdge, AppNode } from '../store/circuitStore'
import type { GeoPoint } from '../types/circuit'

export interface MapPoint {
  x: number
  y: number
}

export interface Placement {
  /** World position of every placed node. */
  pos: Map<string, MapPoint>
  /** Line edges as polylines (their GIS route when they have one). */
  lines: { id: string; pts: MapPoint[] }[]
  /** Wires as straight segments between their two ends. */
  wires: { id: string; a: MapPoint; b: MapPoint; source: string }[]
  /** Single-connection devices (loads, capacitors, DER) by the node they
   *  hang from, so the map can fan them out around it. */
  hanging: Map<string, string[]>
  /** Nodes whose position is their own coordinate (draggable on the map). */
  own: Set<string>
  placed: number
  total: number
}

const SKIP = new Set(['note', 'zone'])
const SHUNT = new Set(['load', 'capacitor', 'generator', 'pvsystem', 'storage'])

/** `project` turns the circuit's coordinates into world coordinates. */
export function placeOnMap(
  nodes: AppNode[],
  edges: AppEdge[],
  project: (p: GeoPoint) => MapPoint | null,
): Placement {
  const pos = new Map<string, MapPoint>()
  const own = new Set<string>()
  const neighbours = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    const list = neighbours.get(a)
    if (list) list.push(b)
    else neighbours.set(a, [b])
  }
  for (const e of edges) {
    link(e.source, e.target)
    link(e.target, e.source)
  }
  const counted = nodes.filter((n) => !SKIP.has(n.type ?? ''))
  for (const n of counted) {
    const g = n.data.geo
    const p = g ? project(g) : null
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      pos.set(n.id, p)
      own.add(n.id)
    }
  }

  // Outward, a ring at a time: each unplaced node takes the mean of its
  // placed neighbours -- the midpoint for a two-terminal device.
  let frontier = [...pos.keys()]
  while (frontier.length) {
    const candidates = new Set<string>()
    for (const id of frontier) {
      for (const nb of neighbours.get(id) ?? []) if (!pos.has(nb)) candidates.add(nb)
    }
    const next: string[] = []
    const placedNow = new Map<string, MapPoint>()
    for (const id of candidates) {
      let x = 0
      let y = 0
      let k = 0
      for (const nb of neighbours.get(id) ?? []) {
        const p = pos.get(nb)
        if (p) {
          x += p.x
          y += p.y
          k++
        }
      }
      if (k) placedNow.set(id, { x: x / k, y: y / k })
    }
    for (const [id, p] of placedNow) {
      pos.set(id, p)
      next.push(id)
    }
    frontier = next
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const hanging = new Map<string, string[]>()
  for (const n of counted) {
    if (!SHUNT.has(n.type ?? '') || own.has(n.id)) continue
    const nbs = neighbours.get(n.id) ?? []
    if (nbs.length !== 1 || !pos.has(nbs[0])) continue
    const list = hanging.get(nbs[0])
    if (list) list.push(n.id)
    else hanging.set(nbs[0], [n.id])
  }

  const lines: Placement['lines'] = []
  const wires: Placement['wires'] = []
  for (const e of edges) {
    const a = pos.get(e.source)
    const b = pos.get(e.target)
    if (!a || !b) continue
    if (e.type === 'line') {
      const route = (e.data?.geometry ?? []).map(project).filter((p): p is MapPoint => !!p)
      lines.push({ id: e.id, pts: [a, ...route, b] })
    } else if (!SKIP.has(byId.get(e.source)?.type ?? '')) {
      wires.push({ id: e.id, a, b, source: e.source })
    }
  }
  const placed = counted.filter((n) => pos.has(n.id)).length
  return { pos, lines, wires, hanging, own, placed, total: counted.length }
}
