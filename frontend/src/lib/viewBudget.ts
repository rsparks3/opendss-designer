// How much of a large circuit the canvas should draw as symbols.
//
// A large circuit is drawn two ways: as symbols React Flow mounts (only
// those in view), or as an overview on one canvas (OverviewLayer). The
// switch used to be a fixed zoom, 0.15, which on a wide feeder put a few
// hundred symbols in view on a laptop and a thousand on a 4K display, and
// kept the overview on while a narrow lateral had ten elements in view.
// The switch is now the count: symbols while few enough are in view to be
// mounted quickly, the overview when there are too many to be useful.

import { NODE_SIZE } from './defaults'
import type { NodeType } from '../types/circuit'

/** The budget, with hysteresis so the view does not flicker at the edge:
 *  symbols give way to the overview above `enter` in view, and the overview
 *  gives way to symbols again below `leave`. */
export const SYMBOL_BUDGET = { enter: 400, leave: 300 }

/** Below this zoom a symbol is three pixels across: overview regardless. */
export const MIN_SYMBOL_ZOOM = 0.08

interface Placed {
  type?: string
  position: { x: number; y: number }
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
}

/** A node's box from its position and its known size. */
export function boxOf(n: Placed): { x: number; y: number; w: number; h: number } {
  const size = NODE_SIZE[n.type as NodeType] ?? NODE_SIZE.load
  return {
    x: n.position.x,
    y: n.position.y,
    w: n.width ?? n.measured?.width ?? size.w,
    h: n.height ?? n.measured?.height ?? size.h,
  }
}

/** The bounds of a set of nodes, from the store alone: React Flow only
 *  knows the nodes it has drawn, and on a large circuit that is few. */
export function nodeBounds(nodes: Placed[]): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const n of nodes) {
    const b = boxOf(n)
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  if (x0 === Infinity) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** How many nodes a viewport shows, counting up to `cap` and stopping
 *  there: the caller only needs to know which side of the budget it is on,
 *  and this runs on every pan frame. */
export function nodesInView(
  nodes: Placed[],
  transform: [number, number, number],
  width: number,
  height: number,
  cap = SYMBOL_BUDGET.enter + 1,
): number {
  const [tx, ty, k] = transform
  if (!(k > 0) || width <= 0 || height <= 0) return 0
  const vx0 = -tx / k
  const vy0 = -ty / k
  const vx1 = (width - tx) / k
  const vy1 = (height - ty) / k
  let count = 0
  for (const n of nodes) {
    if (n.type === 'note' || n.type === 'zone') continue
    const b = boxOf(n)
    if (b.x + b.w < vx0 || b.x > vx1 || b.y + b.h < vy0 || b.y > vy1) continue
    if (++count >= cap) return count
  }
  return count
}

/** Whether to show the overview, given what it showed a moment ago. */
export function decideOverview(wasOverview: boolean, inView: number, zoom: number): boolean {
  if (zoom < MIN_SYMBOL_ZOOM) return true
  return wasOverview ? inView > SYMBOL_BUDGET.leave : inView > SYMBOL_BUDGET.enter
}
