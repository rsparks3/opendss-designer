import type { Issue } from '../types/circuit'

export interface TccTrace {
  label: string
  curve: string
  pickupA: number
  /** [amps, seconds] pairs, straight lines between them on log-log paper. */
  points: [number, number][]
}

export interface TccDevice {
  nodeId: string | null
  name: string
  kind: 'fuse' | 'recloser' | 'relay'
  switch: string
  bus: string | null
  traces: TccTrace[]
  faultA3ph?: number | null
  faultA1ph?: number | null
}

/** A switch on the diagram, with or without a curve of its own. A breaker has
 *  no protection attached, so it never appears in the plot — but it still has
 *  to interrupt whatever the fault study says is available. */
export interface TccSwitch {
  nodeId: string
  name: string
  kind: 'breaker' | 'fuse' | 'recloser' | 'relay'
  bus: string
  faultA3ph?: number | null
  faultA1ph?: number | null
  interruptingKa?: number | null
}

export interface TccResult {
  converged: boolean
  devices: TccDevice[]
  switches: TccSwitch[]
  issues: Issue[]
}

/** Seconds to operate at a given current, interpolated the way the curve is
 *  drawn: straight between points on log-log paper. Below the first point the
 *  device does not operate at all; past the last, the curve holds flat, which
 *  is what the engine does too. */
export function operateSeconds(trace: TccTrace, amps: number): number | null {
  const pts = trace.points
  if (!pts.length || amps < pts[0][0]) return null
  if (amps >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    if (amps <= x1) {
      if (x1 === x0) return y1
      const f = (Math.log10(amps) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0))
      return 10 ** (Math.log10(y0) + f * (Math.log10(y1) - Math.log10(y0)))
    }
  }
  return null
}

/** Decade ticks with the 1-2-5 minors that make TCC paper readable. */
export function logTicks(lo: number, hi: number): { v: number; major: boolean }[] {
  const out: { v: number; major: boolean }[] = []
  const from = Math.floor(Math.log10(lo))
  const to = Math.ceil(Math.log10(hi))
  for (let d = from; d <= to; d++) {
    for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const v = m * 10 ** d
      if (v >= lo && v <= hi) out.push({ v, major: m === 1 })
    }
  }
  return out
}

export function formatAmps(a: number): string {
  if (a >= 10000) return `${(a / 1000).toFixed(0)}k`
  if (a >= 1000) return `${(a / 1000).toFixed(1)}k`
  return a >= 100 ? a.toFixed(0) : a.toFixed(a >= 10 ? 0 : 1)
}

export function formatSeconds(s: number): string {
  if (s >= 100) return s.toFixed(0)
  if (s >= 1) return s.toFixed(1)
  if (s >= 0.1) return s.toFixed(2)
  return s.toFixed(3)
}
