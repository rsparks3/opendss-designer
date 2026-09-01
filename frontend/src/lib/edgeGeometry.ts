// Geometry of a drawn edge.
//
// An edge with no waypoints is drawn by ReactFlow's smoothstep router, which
// bends it into orthogonal elbows; once it has waypoints we draw the polyline
// through them ourselves. Adding the first waypoint therefore used to throw
// the elbows away and snap the edge into a straight line. To keep the shape,
// the corners of the path currently on screen are read back and adopted as
// waypoints alongside the new one.

import type { XY } from '../store/circuitStore'

/** Coordinates from an SVG path of absolute M/L/Q commands, in order, with
 *  consecutive duplicates collapsed. Smoothstep emits its corners as
 *  degenerate quadratics at borderRadius 0, so each corner arrives three
 *  times over. */
export function parsePathPoints(d: string): XY[] {
  const nums = d.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)?.map(Number) ?? []
  const pts: XY[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const p = { x: nums[i], y: nums[i + 1] }
    const last = pts[pts.length - 1]
    if (!last || last.x !== p.x || last.y !== p.y) pts.push(p)
  }
  return pts
}

/** Drop points that lie on the straight line between their neighbours: a
 *  smoothstep path carries several per leg, and each one would otherwise
 *  become a routing dot the user never asked for. */
export function simplifyCollinear(pts: XY[], epsilon = 0.01): XY[] {
  if (pts.length < 3) return pts.slice()
  const out: XY[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]
    const p = pts[i]
    const b = pts[i + 1]
    const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)
    if (Math.abs(cross) > epsilon) out.push(p)
  }
  out.push(pts[pts.length - 1])
  return out
}

/** The routing points of a polyline: everything but its two endpoints. */
export function interiorPoints(pts: XY[]): XY[] {
  return pts.length > 2 ? pts.slice(1, -1) : []
}

export interface Insertion {
  /** Index among the polyline's interior points to insert at. */
  index: number
  /** Where the new point goes — on the polyline, so the shape is unchanged. */
  point: XY
}

/** Where a click should add a routing point. The click is projected onto the
 *  nearest segment rather than used as-is, so adding a point never moves the
 *  wire. On an axis-aligned segment the free coordinate is snapped to the
 *  grid (which keeps it on the segment); a diagonal segment takes the exact
 *  projection instead. */
export function insertPoint(pts: XY[], click: XY, grid = 10): Insertion {
  let best: Insertion = { index: Math.max(0, pts.length - 2), point: click }
  let bestDist = Infinity
  const snap = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(Math.round(v / grid) * grid, Math.min(lo, hi)), Math.max(lo, hi))

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((click.x - a.x) * dx + (click.y - a.y) * dy) / len2))
    const proj = { x: a.x + t * dx, y: a.y + t * dy }
    const dist = (click.x - proj.x) ** 2 + (click.y - proj.y) ** 2
    if (dist >= bestDist) continue
    bestDist = dist
    const point =
      Math.abs(dx) < 0.01
        ? { x: a.x, y: snap(proj.y, a.y, b.y) }
        : Math.abs(dy) < 0.01
          ? { x: snap(proj.x, a.x, b.x), y: a.y }
          : proj
    best = { index: i, point }
  }
  return best
}

/** The polyline an edge is drawn as right now, read back from its rendered
 *  path. Returns null when the edge is not on screen (or the path cannot be
 *  read), leaving the caller to fall back to an approximation. */
export function renderedEdgePoints(edgeId: string): XY[] | null {
  if (typeof document === 'undefined') return null
  const el = document.querySelector(
    `.react-flow__edge[data-id="${CSS.escape(edgeId)}"] path.react-flow__edge-path`,
  )
  const d = el?.getAttribute('d')
  if (!d) return null
  const pts = parsePathPoints(d)
  return pts.length >= 2 ? pts : null
}
