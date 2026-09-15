/** Where a point drawn on an unrotated w×h symbol ends up once the symbol has
 *  turned clockwise by `rotation` degrees. The container swaps width and
 *  height at 90/270 (see rotatedBox in nodes/common.tsx), so the answer is in
 *  the rotated box's own coordinates. Pure, so the geometry can be tested
 *  without React Flow. */
export function rotatePoint(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
): { x: number; y: number } {
  const steps = ((Math.round(rotation / 90) % 4) + 4) % 4
  let px = x
  let py = y
  let bw = w
  let bh = h
  for (let i = 0; i < steps; i++) {
    // One clockwise quarter turn: the top edge becomes the right edge.
    ;[px, py] = [bh - py, px]
    ;[bw, bh] = [bh, bw]
  }
  return { x: px, y: py }
}
