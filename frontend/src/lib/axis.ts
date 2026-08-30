// Axis math shared by the Graph tab charts (snapshot + time modes).

export function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1))
  const norm = raw / mag
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag
}

export function fmt(v: number, step: number): string {
  if (step < 0.005) return v.toFixed(4)
  if (step < 0.05) return v.toFixed(3)
  if (step < 0.5) return v.toFixed(2)
  if (step < 5) return v.toFixed(1)
  return v.toFixed(0)
}

export function ticks(lo: number, hi: number, count = 5): number[] {
  const step = niceStep((hi - lo) / count)
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(t)
  return out
}

/** Hour of year at each month start (non-leap), for yearly-axis labels. */
export const MONTH_STARTS = [0, 744, 1416, 2160, 2880, 3624, 4344, 5088, 5832, 6552, 7296, 8016]
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Human label for a simulation hour: "13.00 h" (daily) / "Jun 21, h 4092" (yearly). */
export function fmtSimHour(h: number, mode: 'daily' | 'yearly'): string {
  if (mode === 'daily') return `${h.toFixed(2)} h`
  const m = Math.max(MONTH_STARTS.filter((s) => s <= h).length - 1, 0)
  const day = Math.floor((h - MONTH_STARTS[m]) / 24) + 1
  return `${MONTH_NAMES[m]} ${day}, h ${h.toFixed(1)}`
}
