// Pure loadshape helpers: CSV parsing, normalization, decimation for preview.

/** Parse pasted CSV/text into loadshape points. Accepts one value per line,
 *  comma/semicolon/whitespace separated values, or two-column `time,value`
 *  rows (col 0 is dropped when every row has 2+ numbers and col 0 is
 *  monotonically increasing — it's a time axis, not data). */
export function parseShapeText(text: string): { points: number[]; error: string | null } {
  const rows: number[][] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const cells = line
      .split(/[,;\t ]+/)
      .filter((c) => c !== '')
      .map((c) => Number(c))
    if (cells.some((v) => !Number.isFinite(v))) {
      // Tolerate a single header row; anything else is an error.
      if (rows.length === 0) continue
      return { points: [], error: `Line ${rows.length + 1}: not numeric — "${line.slice(0, 40)}"` }
    }
    if (cells.length) rows.push(cells)
  }
  if (!rows.length) return { points: [], error: 'No numeric values found.' }

  const twoCol = rows.every((r) => r.length >= 2)
  const col0 = rows.map((r) => r[0])
  const monotonic = col0.every((v, i) => i === 0 || v > col0[i - 1])
  if (twoCol && monotonic && rows.length > 1) {
    return { points: rows.map((r) => r[1]), error: null }
  }
  return { points: rows.flat(), error: null }
}

/** Scale so the peak (largest |value|) becomes 1.0. */
export function normalizePeak(points: number[]): number[] {
  // Loop instead of Math.max(...points): spreading 35k args can overflow.
  let peak = 0
  for (const v of points) peak = Math.max(peak, Math.abs(v))
  if (!peak || !Number.isFinite(peak)) return points
  return points.map((v) => round5(v / peak))
}

/** Scale so the mean becomes 1.0. */
export function normalizeAverage(points: number[]): number[] {
  const mean = points.reduce((a, b) => a + b, 0) / (points.length || 1)
  if (!mean || !Number.isFinite(mean)) return points
  return points.map((v) => round5(v / mean))
}

export function round5(v: number): number {
  return Number(v.toPrecision(5))
}

/** Min/max bucket decimation: caps the point count while preserving the
 *  envelope (every bucket contributes its min and max, in x order). */
export function decimate(
  points: { x: number; y: number }[],
  maxPoints: number,
): { x: number; y: number }[] {
  if (points.length <= maxPoints || maxPoints < 4) return points
  const buckets = Math.max(2, Math.floor(maxPoints / 2))
  const size = points.length / buckets
  const out: { x: number; y: number }[] = []
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * size)
    const hi = Math.min(points.length, Math.max(lo + 1, Math.floor((b + 1) * size)))
    let min = points[lo]
    let max = points[lo]
    for (let i = lo + 1; i < hi; i++) {
      if (points[i].y < min.y) min = points[i]
      if (points[i].y > max.y) max = points[i]
    }
    if (min === max) out.push(min)
    else out.push(min.x <= max.x ? min : max, min.x <= max.x ? max : min)
  }
  return out
}

export function shapeStats(points: number[]): {
  npts: number
  min: number
  max: number
  avg: number
} {
  if (!points.length) return { npts: 0, min: 0, max: 0, avg: 0 }
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (const v of points) {
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  return { npts: points.length, min, max, avg: sum / points.length }
}
