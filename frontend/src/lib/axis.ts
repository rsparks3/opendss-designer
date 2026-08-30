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
