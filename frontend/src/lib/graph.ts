import type { BusResult, ElementResult, SolveResult } from '../types/circuit'

/** Data prep for the Graph tab: pick an X and a Y quantity, get plottable
 *  rows. Bus quantities give one row per bus; element quantities one row per
 *  element, plotted at its source-side bus (bus-kind X values resolve
 *  through that bus). Segments (feeder topology) are drawn only for bus
 *  quantities, where connecting bus values makes sense. */
export interface Quantity {
  key: string
  label: string
  kind: 'bus' | 'element'
}

export const X_QUANTITIES: Quantity[] = [
  { key: 'dist', label: 'km from source', kind: 'bus' },
  { key: 'vmin', label: 'V min (pu)', kind: 'bus' },
]

export const Y_QUANTITIES: Quantity[] = [
  { key: 'vmin', label: 'V min (pu)', kind: 'bus' },
  { key: 'vmax', label: 'V max (pu)', kind: 'bus' },
  { key: 'kw', label: 'P flow (kW)', kind: 'element' },
  { key: 'kvar', label: 'Q flow (kvar)', kind: 'element' },
  { key: 'amps', label: 'Max current (A)', kind: 'element' },
  { key: 'loading', label: 'Loading (%)', kind: 'element' },
  { key: 'losskw', label: 'Loss (kW)', kind: 'element' },
  { key: 'losskvar', label: 'Loss (kvar)', kind: 'element' },
]

export interface GraphRow {
  /** Bus name (bus rows) or element full name (element rows). */
  id: string
  bus: string
  x: number
  y: number
  violation?: string
}

export interface GraphSegment {
  from: string
  to: string
  dashed: boolean
}

function busValue(key: string, name: string, b: BusResult | undefined,
                  dist: Record<string, number>): number | null {
  if (!b) return null
  switch (key) {
    case 'dist':
      return dist[name] ?? null
    case 'vmin':
      return b.vminPu
    case 'vmax':
      return b.vmaxPu
    default:
      return null
  }
}

function elementValue(key: string, e: ElementResult): number | null {
  switch (key) {
    case 'kw':
      return e.kw
    case 'kvar':
      return e.kvar
    case 'amps':
      return e.currents.length ? Math.max(...e.currents) : null
    case 'loading':
      return e.loadingPct
    case 'losskw':
      return e.lossKw
    case 'losskvar':
      return e.lossKvar
    default:
      return null
  }
}

export function computeGraph(
  result: SolveResult,
  nodes: { id: string; type?: string }[],
  xKey: string,
  yKey: string,
): { rows: GraphRow[]; segments: GraphSegment[] } {
  const yq = Y_QUANTITIES.find((q) => q.key === yKey)
  const dist = result.busDistances ?? {}
  const rows: GraphRow[] = []
  const segments: GraphSegment[] = []

  if (!yq || yq.kind === 'bus') {
    for (const [name, b] of Object.entries(result.buses)) {
      const x = busValue(xKey, name, b, dist)
      const y = busValue(yKey, name, b, dist)
      if (x == null || y == null) continue
      rows.push({ id: name, bus: name, x, y, violation: b.violation })
    }
    const have = new Set(rows.map((r) => r.id))
    const ok = (a?: string, b?: string) => a && b && a !== b && have.has(a) && have.has(b)
    for (const buses of Object.values(result.lineBuses ?? {})) {
      if (ok(buses[0], buses[1])) segments.push({ from: buses[0], to: buses[1], dashed: false })
    }
    for (const n of nodes) {
      if (n.type !== 'transformer' && n.type !== 'breaker') continue
      const buses = result.nodeBuses[n.id] ?? []
      if (ok(buses[0], buses[1])) segments.push({ from: buses[0], to: buses[1], dashed: true })
    }
  } else {
    for (const [name, e] of Object.entries(result.elements)) {
      const buses = result.nodeBuses[e.id] ?? result.lineBuses[e.id] ?? []
      if (!buses.length) continue
      // Source-side terminal: the bus nearest the source.
      const bus = [...buses].sort(
        (a, b) => (dist[a] ?? Infinity) - (dist[b] ?? Infinity),
      )[0]
      const x = busValue(xKey, bus, result.buses[bus], dist)
      const y = elementValue(yKey, e)
      if (x == null || y == null) continue
      rows.push({ id: name, bus, x, y, violation: e.violations[0] })
    }
  }

  rows.sort((a, b) => a.x - b.x)
  return { rows, segments }
}
