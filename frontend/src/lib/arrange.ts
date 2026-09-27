/**
 * Arrange → Align, Distribute and Flip, as pure geometry so it can be tested
 * without a canvas. The store applies the answers as one undo step.
 */

export interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type Axis = 'horizontal' | 'vertical'

/** Snap to the 10 px grid everything else sits on. */
const snap = (v: number) => Math.round(v / 10) * 10

/** Line the boxes up on one edge or centre line of the whole selection, the
 *  way drawing tools do: left aligns every left edge with the leftmost,
 *  center puts every centre on the selection's centre, and so on. */
export function align(boxes: Box[], how: Alignment): Record<string, { x: number; y: number }> {
  if (boxes.length < 2) return {}
  const left = Math.min(...boxes.map((b) => b.x))
  const right = Math.max(...boxes.map((b) => b.x + b.w))
  const top = Math.min(...boxes.map((b) => b.y))
  const bottom = Math.max(...boxes.map((b) => b.y + b.h))
  const out: Record<string, { x: number; y: number }> = {}
  for (const b of boxes) {
    let { x, y } = b
    if (how === 'left') x = left
    else if (how === 'right') x = right - b.w
    else if (how === 'center') x = (left + right) / 2 - b.w / 2
    else if (how === 'top') y = top
    else if (how === 'bottom') y = bottom - b.h
    else y = (top + bottom) / 2 - b.h / 2
    out[b.id] = { x: snap(x), y: snap(y) }
  }
  return out
}

/** Space the boxes evenly between the two outermost, keeping their order:
 *  equal gaps between neighbours, so a row of different-sized symbols looks
 *  even. The outermost two stay where they are. */
export function distribute(boxes: Box[], axis: Axis): Record<string, { x: number; y: number }> {
  if (boxes.length < 3) return {}
  const horiz = axis === 'horizontal'
  const pos = (b: Box) => (horiz ? b.x : b.y)
  const size = (b: Box) => (horiz ? b.w : b.h)
  const sorted = [...boxes].sort((a, b) => pos(a) + size(a) / 2 - (pos(b) + size(b) / 2))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = pos(last) + size(last) - pos(first)
  const used = sorted.reduce((n, b) => n + size(b), 0)
  const gap = (span - used) / (sorted.length - 1)
  const out: Record<string, { x: number; y: number }> = {}
  let at = pos(first)
  for (const b of sorted) {
    const p = b === first || b === last ? pos(b) : snap(at)
    out[b.id] = horiz ? { x: p, y: b.y } : { x: b.x, y: p }
    at += size(b) + gap
  }
  return out
}

/** A symbol's `flip` mirrors it left-to-right in its own frame before its
 *  `rotation`. Mirroring what is on screen therefore has to fold into both:
 *  a horizontal mirror turns rotation r into -r, a vertical one into
 *  180 - r, and either toggles the flip. */
export function flipOnScreen(
  params: { rotation?: unknown; flip?: unknown },
  axis: Axis,
): { rotation: number; flip: boolean } {
  const r = Number(params.rotation) || 0
  const rotation = (((axis === 'horizontal' ? -r : 180 - r) % 360) + 360) % 360
  return { rotation, flip: params.flip !== true }
}
