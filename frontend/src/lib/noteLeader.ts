/** Geometry for a note's leader: the arrow from a note to what it is about. */
import { midpoint } from './splitLine'

export interface XY {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

const center = (b: Box): XY => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/** Where the ray from the box's centre towards `toward` leaves the box,
 *  pushed `gap` further out. */
export function exitPoint(box: Box, toward: XY, gap = 0): XY {
  const c = center(box)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (!dx && !dy) return c
  // The ray reaches a vertical side at t = (w/2)/|dx|, a horizontal one at
  // (h/2)/|dy|; whichever comes first is where it leaves.
  const tx = dx ? box.w / 2 / Math.abs(dx) : Infinity
  const ty = dy ? box.h / 2 / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty)
  const len = Math.hypot(dx, dy)
  const k = t + gap / len
  return { x: c.x + dx * k, y: c.y + dy * k }
}

/** The leader from a note to its target: from the note's edge to the edge of
 *  the target's box (a symbol), or to the point itself (a spot on a line).
 *  Null when the target sits under the note, where no arrow can show. */
export function leaderLine(note: Box, target: Box | XY): { from: XY; to: XY } | null {
  const isBox = 'w' in target
  const aim = isBox ? center(target) : target
  const inside = (b: Box, p: XY) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
  if (inside(note, aim)) return null
  const from = exitPoint(note, aim)
  const to = isBox ? exitPoint(target, center(note), 4) : aim
  if (isBox && inside(target, from)) return null
  if (Math.hypot(to.x - from.x, to.y - from.y) < 8) return null
  return { from, to }
}

/** Where on a line an arrow should land: halfway along it as drawn. */
export function lineAnchor(ends: [XY, XY], waypoints: XY[] = []): XY {
  return midpoint([ends[0], ...waypoints, ends[1]])
}

/** The three corners of an arrowhead at `to`, pointing away from `from`. */
export function arrowHead(from: XY, to: XY, size = 8): XY[] {
  const a = Math.atan2(to.y - from.y, to.x - from.x)
  const spread = Math.PI / 7
  return [
    to,
    { x: to.x - size * Math.cos(a - spread), y: to.y - size * Math.sin(a - spread) },
    { x: to.x - size * Math.cos(a + spread), y: to.y - size * Math.sin(a + spread) },
  ]
}
