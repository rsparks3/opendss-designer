import type { SolveResult } from '../types/circuit'

/** Data prep for the voltage-profile plot: every solved bus becomes a point
 *  at (distance from source, voltage), and every series connection becomes a
 *  segment between its two buses (lines solid, transformers/breakers dashed —
 *  a dashed drop marks a voltage change without distance). */
export interface ProfilePoint {
  bus: string
  distKm: number
  vminPu: number
  vmaxPu: number
  violation?: string
}

export interface ProfileSegment {
  from: string
  to: string
  dashed: boolean
}

export function computeProfile(
  result: SolveResult,
  nodes: { id: string; type?: string }[],
): { points: ProfilePoint[]; segments: ProfileSegment[] } {
  const dist = result.busDistances ?? {}
  const points: ProfilePoint[] = Object.entries(result.buses)
    .filter(([name, b]) => dist[name] != null && b.vminPu != null)
    .map(([name, b]) => ({
      bus: name,
      distKm: dist[name],
      vminPu: b.vminPu!,
      vmaxPu: b.vmaxPu ?? b.vminPu!,
      violation: b.violation,
    }))
    .sort((a, b) => a.distKm - b.distKm)

  const have = new Set(points.map((p) => p.bus))
  const ok = (a?: string, b?: string) => a && b && a !== b && have.has(a) && have.has(b)

  const segments: ProfileSegment[] = []
  for (const buses of Object.values(result.lineBuses ?? {})) {
    if (ok(buses[0], buses[1])) segments.push({ from: buses[0], to: buses[1], dashed: false })
  }
  for (const n of nodes) {
    if (n.type !== 'transformer' && n.type !== 'breaker') continue
    const buses = result.nodeBuses[n.id] ?? []
    if (ok(buses[0], buses[1])) segments.push({ from: buses[0], to: buses[1], dashed: true })
  }
  return { points, segments }
}
