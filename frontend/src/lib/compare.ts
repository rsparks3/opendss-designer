import type { SolveResult } from '../types/circuit'

/** Two solves of (nearly) the same circuit, bus by bus and element by
 *  element. Buses match by name, elements by engine name (class.name), so
 *  a renamed element shows as one gone and one new. */

export interface CompareRow {
  key: string
  label: string
  /** Diagram id of the element (null for a bus with no node on it). */
  id: string | null
  before: number | null
  after: number | null
  delta: number | null
  changed: boolean
  status: string
  flag: 'violation' | 'warning' | null
  deltaKw?: number | null
  deltaLossKw?: number | null
}

export interface Comparison {
  buses: CompareRow[]
  elements: CompareRow[]
  lossKw: number | null
  minV: number | null
  maxLoading: number | null
  violationsBefore: number
  violationsAfter: number
}

const V_EPS = 0.0005
const L_EPS = 0.05

function violations(r: SolveResult): number {
  return (
    Object.values(r.buses).filter((b) => b.violation).length +
    Object.values(r.elements).filter((e) => e.violations.length).length
  )
}

function minV(r: SolveResult): number | null {
  const vals = Object.values(r.buses)
    .map((b) => b.vminPu)
    .filter((v): v is number => v != null && v > 0.05)
  return vals.length ? Math.min(...vals) : null
}

function maxLoading(r: SolveResult): number | null {
  const vals = Object.values(r.elements)
    .map((e) => e.loadingPct)
    .filter((v): v is number => v != null)
  return vals.length ? Math.max(...vals) : null
}

const diff = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? null : b - a

/** Which node sits on each bus, for locating a bus on the drawing. */
function nodeOnBus(r: SolveResult): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, buses] of Object.entries(r.nodeBuses)) {
    for (const b of buses) if (!out.has(b)) out.set(b, id)
  }
  return out
}

export function compareResults(before: SolveResult, after: SolveResult): Comparison {
  const buses: CompareRow[] = []
  const onBus = nodeOnBus(after)
  for (const name of new Set([...Object.keys(before.buses), ...Object.keys(after.buses)])) {
    const b = before.buses[name]
    const a = after.buses[name]
    const delta = diff(b?.vminPu, a?.vminPu)
    const status = !b ? 'new' : !a ? 'gone' : a.violation ?? (b.violation ? 'cleared' : 'ok')
    buses.push({
      key: `bus:${name}`,
      label: after.busNames[name] ?? before.busNames[name] ?? name,
      id: onBus.get(name) ?? null,
      before: b?.vminPu ?? null,
      after: a?.vminPu ?? null,
      delta,
      changed: !b || !a || (delta != null && Math.abs(delta) >= V_EPS),
      status,
      flag: a?.violation ? 'violation' : null,
    })
  }
  const elements: CompareRow[] = []
  for (const name of new Set([...Object.keys(before.elements), ...Object.keys(after.elements)])) {
    const b = before.elements[name]
    const a = after.elements[name]
    const delta = diff(b?.loadingPct, a?.loadingPct)
    const deltaKw = diff(b?.kw, a?.kw)
    const deltaLossKw = diff(b?.lossKw, a?.lossKw)
    elements.push({
      key: `el:${name}`,
      label: name.split('.', 2)[1] ?? name,
      id: a?.id ?? b?.id ?? null,
      before: b?.loadingPct ?? null,
      after: a?.loadingPct ?? null,
      delta,
      changed:
        !b || !a || (delta != null && Math.abs(delta) >= L_EPS) ||
        (deltaKw != null && Math.abs(deltaKw) >= 0.5),
      status: !b ? 'new' : !a ? 'gone' : a.violations.length ? a.violations.join(', ') : 'ok',
      flag: a?.violations.length ? 'violation' : null,
      deltaKw,
      deltaLossKw,
    })
  }
  // Largest numeric change first; buses and elements that appeared or
  // vanished (no delta to speak of) come after them.
  const mag = (r: CompareRow) => (r.delta == null ? -1 : Math.abs(r.delta))
  buses.sort((x, y) => mag(y) - mag(x))
  elements.sort((x, y) => mag(y) - mag(x))
  return {
    buses,
    elements,
    lossKw: diff(before.losses?.kw, after.losses?.kw),
    minV: diff(minV(before), minV(after)),
    maxLoading: diff(maxLoading(before), maxLoading(after)),
    violationsBefore: violations(before),
    violationsAfter: violations(after),
  }
}

/** Colour for a voltage change: red when the bus got lower, green higher. */
export function deltaColor(delta: number, scale: number): string {
  const t = Math.max(-1, Math.min(1, delta / scale))
  if (Math.abs(t) < 0.05) return '#607d8b'
  return t < 0 ? `hsl(4, ${Math.round(40 + 55 * -t)}%, 45%)` : `hsl(130, ${Math.round(35 + 45 * t)}%, 36%)`
}
