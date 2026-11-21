import type { AppEdge, AppNode } from '../store/circuitStore'
import type { Issue, Params, TccCurveJSON } from '../types/circuit'
import { topologyOf, upstreamPaths } from './trace'

export interface TccTrace {
  label: string
  curve: string
  /** Which fault this trace answers to: a ground unit only sees the residual
   *  current of an unbalanced fault. */
  fault: 'phase' | 'ground'
  pickupA: number
  /** The time dial the curve's seconds were multiplied by (relays), and the
   *  added delay; with `keys` they let the plot redraw an edit itself. */
  timeDial?: number
  delay?: number
  /** Which element params set the curve, pickup and time dial. */
  keys?: { curve?: string; pickup?: string; td?: string }
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

// --- redrawing from an edit, chains and margins (facility plan 2.5) -------------------

/** Curve name -> [multiple of pickup, seconds] points: the engine's own and
 *  the generic families (GET /api/tcccurves), then the circuit's own curves. */
export type CurveLibrary = Record<string, [number, number][]>

export function curveLibrary(
  served: { name: string; points: [number, number][] }[] | null | undefined,
  mine: Record<string, TccCurveJSON>,
): CurveLibrary {
  const out: CurveLibrary = {}
  for (const c of served ?? []) out[c.name.toLowerCase()] = c.points
  for (const [name, c] of Object.entries(mine)) {
    const n = Math.min(c.multiples.length, c.seconds.length)
    if (n >= 2) out[name.toLowerCase()] = c.multiples.slice(0, n).map((m, i) => [m, c.seconds[i]])
  }
  return out
}

const num = (v: unknown): number | null => {
  const f = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(f) && f > 0 ? f : null
}

/** A device's traces redrawn from its params as they are now: curve, pickup,
 *  time dial and added delay, each falling back to what the engine read when
 *  the param is not set. A curve the library does not hold keeps the traced
 *  points; a curve set to 'none' drops the trace. No solve: the fault
 *  current does not depend on any of these. */
export function retrace(device: TccDevice, params: Params | undefined, lib: CurveLibrary): TccDevice {
  if (!params) return device
  const traces: TccTrace[] = []
  for (const t of device.traces) {
    const k = t.keys ?? {}
    const rawCurve = k.curve ? params[k.curve] : undefined
    const curve = typeof rawCurve === 'string' && rawCurve.trim() ? rawCurve.trim().toLowerCase() : t.curve
    if (curve === 'none') continue
    const base = lib[curve]
    const pickup = (k.pickup ? num(params[k.pickup]) : null) ?? t.pickupA
    const td = (k.td ? num(params[k.td]) : null) ?? t.timeDial ?? 1
    const delayRaw = params.delay
    const delay = delayRaw === undefined || delayRaw === null || delayRaw === '' ? (t.delay ?? 0) : Math.max(0, Number(delayRaw) || 0)
    if (!base || base.length < 2) {
      traces.push(t)
      continue
    }
    const label = t.label.includes(`(${t.curve})`) ? t.label.replace(`(${t.curve})`, `(${curve})`) : t.label
    traces.push({
      ...t, label, curve, pickupA: pickup, timeDial: td, delay,
      points: base.map(([m, sec]) => [Math.round(m * pickup * 100) / 100, Math.round((sec * td + delay) * 1e5) / 1e5]),
    })
  }
  return { ...device, traces }
}

/** The trace that operates first at `amps` for this kind of fault, and when. */
export function fastest(device: TccDevice, amps: number, fault: 'phase' | 'ground' = 'phase'): { trace: TccTrace; secs: number } | null {
  let traces = device.traces.filter((t) => (t.fault ?? 'phase') === fault)
  if (!traces.length && fault === 'ground' && device.kind === 'fuse') traces = device.traces
  let best: { trace: TccTrace; secs: number } | null = null
  for (const t of traces) {
    const secs = operateSeconds(t, amps)
    if (secs != null && (!best || secs < best.secs)) best = { trace: t, secs }
  }
  return best
}

/** As core/protection.py grades a pair. */
export const COORDINATION_MARGIN_S = 0.25
export const FUSE_MELT_FRACTION = 0.75

export interface PairMargin {
  down: string
  up: string
  amps: number
  fault: 'phase' | 'ground'
  downSecs: number | null
  upSecs: number | null
  marginS: number | null
  ok: boolean | null
  rule: string
}

/** Each adjacent pair of a chain (nearest the fault first), graded at the
 *  downstream device's fault current: three-phase on the phase units and,
 *  where both have one, line-to-ground on the ground units. */
export function chainMargins(chain: TccDevice[]): PairMargin[] {
  const out: PairMargin[] = []
  for (let i = 0; i + 1 < chain.length; i++) {
    const down = chain[i]
    const up = chain[i + 1]
    for (const [fault, amps] of [['phase', down.faultA3ph], ['ground', down.faultA1ph]] as const) {
      if (!amps) continue
      const hasGround = (d: TccDevice) => d.kind === 'fuse' || d.traces.some((t) => t.fault === 'ground')
      if (fault === 'ground' && !(hasGround(down) && hasGround(up))) continue
      const a = fastest(down, amps, fault)
      const b = fastest(up, amps, fault)
      const fuses = down.kind === 'fuse' && up.kind === 'fuse'
      let ok: boolean | null = null
      if (a && b) ok = fuses ? a.secs <= b.secs * FUSE_MELT_FRACTION : b.secs - a.secs >= COORDINATION_MARGIN_S
      else if (a && !b) ok = true // the upstream device does not see it at all
      out.push({
        down: down.name, up: up.name, amps, fault,
        downSecs: a?.secs ?? null, upSecs: b?.secs ?? null,
        marginS: a && b ? b.secs - a.secs : null,
        ok,
        rule: fuses ? `clears within ${FUSE_MELT_FRACTION * 100} % of the upstream melt` : `${COORDINATION_MARGIN_S} s margin`,
      })
    }
  }
  return out
}

/** Params that change a curve but not the fault current: editing only these
 *  redraws the plot without making its fault lines stale. */
export const PROTECTION_ONLY_KEYS = new Set([
  'name', 'fusecurve', 'clearcurve', 'ratedcurrent', 'phasefast', 'phasedelayed', 'groundfast', 'grounddelayed',
  'phasetrip', 'groundtrip', 'phasecurve', 'groundcurve', 'tdphase', 'tdground', 'delay', 'fastops', 'shots',
  'recloseintervals', 'interruptingka', 'withstandka', 'bracingka', 'tags', 'faultrate', 'pctperm', 'repair',
  'meter', 'tie', 'priority', 'building', 'numcust',
])

/** A string that changes when anything the fault study depends on changes. */
export function faultSignature(
  nodes: { id: string; type?: string; data: { params: Params } }[],
  edges: { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; type?: string; data?: { params?: Params } }[],
): string {
  const strip = (p: Params | undefined) => {
    const o: Params = {}
    for (const [k, v] of Object.entries(p ?? {})) if (!PROTECTION_ONLY_KEYS.has(k)) o[k] = v
    return o
  }
  return JSON.stringify([
    nodes.filter((n) => n.type !== 'note' && n.type !== 'zone').map((n) => [n.id, n.type, strip(n.data.params)]),
    edges.map((e) => [e.id, e.type, e.source, e.sourceHandle, e.target, e.targetHandle, strip(e.data?.params)]),
  ])
}

const CURVED = new Set(['fuse', 'recloser', 'relay'])

/** A protective device and every one above it on its path to a source,
 *  nearest first: the chain a coordination plot is read along. */
export function tccChain(nodes: AppNode[], edges: AppEdge[], deviceId: string): string[] {
  const topo = topologyOf(nodes, edges)
  const path = upstreamPaths(topo, deviceId)[0]
  const above = path ? [...path.elements].reverse() : []
  const kind = new Map(nodes.map((n) => [n.id, n.type]))
  return [deviceId, ...above.filter((id) => CURVED.has(kind.get(id) ?? ''))]
}
