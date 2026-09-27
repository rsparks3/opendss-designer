import { insertPoint } from './edgeGeometry'

/** Split line: where on a drawn line a new bus goes, and how the line's
 *  length divides between the two halves. Pure geometry; the store does
 *  the editing. */

export interface XY {
  x: number
  y: number
}

export interface Split {
  /** The point on the line, snapped along axis-aligned runs. */
  point: XY
  /** How far along the drawn line the click was, 0..1. */
  fraction: number
  /** Routing points each half keeps (interior points only). */
  before: XY[]
  after: XY[]
  /** Direction of travel at the split, from the line's source end. */
  vertical: boolean
  forward: boolean
}

const dist = (a: XY, b: XY) => Math.hypot(b.x - a.x, b.y - a.y)

function arcLength(pts: XY[]): number {
  let n = 0
  for (let i = 1; i < pts.length; i++) n += dist(pts[i - 1], pts[i])
  return n
}

/** The point halfway along the drawn line (Arrange → Split line, which has
 *  no click to go by). */
export function midpoint(pts: XY[]): XY {
  const half = arcLength(pts) / 2
  let run = 0
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i])
    if (run + seg >= half && seg > 0) {
      const t = (half - run) / seg
      return { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y) }
    }
    run += seg
  }
  return pts[0]
}

/** Where a click on the polyline `pts` (source end first) splits it. */
export function splitAt(pts: XY[], click: XY): Split {
  const { index, point } = insertPoint(pts, click)
  const a = pts[index]
  const b = pts[index + 1] ?? a
  // The length divides at the exact spot clicked; only the bus is snapped
  // to the grid, which would otherwise skew the split by up to 5 px.
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1
  const t = Math.max(0, Math.min(1, ((click.x - a.x) * (b.x - a.x) + (click.y - a.y) * (b.y - a.y)) / len2))
  const exact = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
  const total = arcLength(pts) || 1
  const upTo = arcLength([...pts.slice(0, index + 1), exact])
  const vertical = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x)
  return {
    point,
    fraction: Math.min(1, Math.max(0, upTo / total)),
    before: pts.slice(1, index + 1),
    after: pts.slice(index + 1, -1),
    vertical,
    forward: vertical ? b.y >= a.y : b.x >= a.x,
  }
}

/** A length divided at `fraction`: the first half to six significant
 *  figures, the second whatever is left, so the two add back up to the
 *  whole (toPrecision(12) only clears floating-point dust). */
export function divideLength(length: number, fraction: number): [number, number] {
  const first = Number((length * fraction).toPrecision(6))
  const second = Number((length - first).toPrecision(12))
  return [first, second]
}
