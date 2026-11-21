import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { HostingCapacityResult, TimeSeriesResult } from '../types/circuit'
import { runJob } from './jobs'
import { isPreview } from './scenarios'
import { runSolve } from './solve'

/**
 * Capacity headroom (studies/headroom.py) and the probe load: the largest
 * new load one bus can take, found by the hosting-capacity load search at
 * that bus alone (facility plan 2.2). Probe results live for the session,
 * in the results store under `studies.probes`, and go into the report.
 */

export interface HeadroomCell {
  ratingKva: number
  kva: number
  loadingPct: number
  pf: number
  spareKva: number
  spareKw: number
  voltageKw: number | null
  limit: 'thermal' | 'voltage'
  headroomKw: number
  headroomKva: number
}

export interface HeadroomRow {
  id: string
  name: string
  kind: string
  phases: number
  levels: Record<string, HeadroomCell>
}

export interface HeadroomResult {
  converged: boolean
  cancelled: boolean
  levels: { name: string; loadmult: number; rating: 'normal' | 'emergency' }[]
  rows: HeadroomRow[]
  voltage: boolean
  issues: { severity: string; message: string }[]
  scenario: string | null
}

export interface ProbeResult {
  nodeId: string
  name: string
  bus: string
  kw: number
  kva: number
  binding: string | null
  where: { bus?: string; element?: string; id?: string | null; value: number } | null
  scenario: string | null
  level: string
  at: number
}

/** The worst loading each element reached in a time-series run, by element id. */
export function timeSeriesPeaks(ts: TimeSeriesResult | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  if (!ts) return out
  for (const el of Object.values(ts.elements)) {
    let peak: number | null = null
    for (const v of el.loadingPct) if (v != null && (peak == null || v > peak)) peak = v
    if (peak != null && (out[el.id] == null || peak > out[el.id])) out[el.id] = peak
  }
  return out
}

/** Spare kVA at a time-series peak, on the rating the snapshot found. */
export function spareAtPeak(cell: HeadroomCell | undefined, peakPct: number | undefined): number | null {
  if (!cell || peakPct == null) return null
  return Math.round(cell.ratingKva * (1 - peakPct / 100) * 10) / 10
}

const PROBE_PF = 0.95

/** Find the largest new load the bus under `nodeId` can take before a
 *  voltage or thermal limit binds, on the open scenario at the active level. */
export async function findMaxLoad(nodeId: string): Promise<ProbeResult | null> {
  const rs = useResultsStore.getState()
  if (rs.studyRunning.probes) return null
  if (rs.stale || !rs.result) {
    if (!(await runSolve())) return null
  }
  const result = useResultsStore.getState().result
  const bus = result?.nodeBuses?.[nodeId]?.[0]
  const cs = useCircuitStore.getState()
  const node = cs.nodes.find((n) => n.id === nodeId)
  const name = String(node?.data.params.name ?? nodeId)
  if (!bus) {
    useResultsStore.getState().setFlash(`No bus found under ${name}; solve the circuit first.`, 'error')
    return null
  }
  const abort = new AbortController()
  useResultsStore.getState().setStudyRunning('probes', true, abort)
  useResultsStore.getState().setFlash(`Finding the maximum load at ${name}…`, 'info', 4000)
  try {
    const r = await runJob<HostingCapacityResult & { buses: Record<string, { where?: ProbeResult['where'] }> }>(
      '/api/jobs/hosting-capacity',
      {
        circuit: toCircuitJSON(cs),
        options: {
          kind: 'load', method: 'iterative', buses: [bus], threePhaseOnly: false, minKv: 0, loadPf: PROBE_PF, toleranceKw: 2,
          criteria: { voltage: true, thermal: true, deviation: false, regulatorReverse: false, substationReverse: false,
            faultCurrent: false, interrupting: false, islanding: false, controlOps: false },
        },
      },
      { signal: abort.signal },
    )
    const b = r.buses?.[bus.toLowerCase()] ?? r.buses?.[bus]
    if (!r.converged || !b) {
      useResultsStore.getState().setFlash(`Find maximum load: nothing could be evaluated at ${name}.`, 'error')
      return null
    }
    const scenario = cs.activeScenario && !isPreview(cs.activeScenario)
      ? (cs.scenarios.find((s) => s.id === cs.activeScenario)?.name ?? cs.activeScenario)
      : isPreview(cs.activeScenario) ? 'preview' : null
    const probe: ProbeResult = {
      nodeId, name, bus,
      kw: b.kw,
      kva: Math.round((b.kw / PROBE_PF) * 10) / 10,
      binding: b.binding,
      where: (b as { where?: ProbeResult['where'] }).where ?? null,
      scenario,
      level: r.loadLevel?.name ?? 'Rated',
      at: Date.now(),
    }
    const st = useResultsStore.getState()
    const prior = (st.studies.probes as ProbeResult[] | undefined) ?? []
    st.setStudy('probes', [probe, ...prior.filter((p) => !(p.nodeId === nodeId && p.scenario === scenario && p.level === probe.level))])
    st.setFlash(`${name}: ${probeSummary(probe, (id) => elementName(id))}`, 'info', 10000)
    return probe
  } catch (err) {
    const msg = (err as Error).message
    useResultsStore.getState().setFlash(msg === 'cancelled' ? 'Find maximum load cancelled.' : `Find maximum load: ${msg}`, msg === 'cancelled' ? 'info' : 'error')
    return null
  } finally {
    useResultsStore.getState().setStudyRunning('probes', false)
  }
}

function elementName(id: string | null | undefined): string | null {
  if (!id) return null
  const cs = useCircuitStore.getState()
  const n = cs.nodes.find((x) => x.id === id)
  const e = n ? undefined : cs.edges.find((x) => x.id === id)
  const nm = n?.data.params.name ?? e?.data?.params.name
  return typeof nm === 'string' && nm ? nm : id
}

/** "up to 190 kW (200 kVA) more; thermal at XF (100 %)". */
export function probeSummary(p: ProbeResult, nameOf: (id: string | null | undefined) => string | null): string {
  const size = `up to ${Math.round(p.kw)} kW (${Math.round(p.kva)} kVA) more`
  if (!p.binding || p.binding === 'none') return `${size}; nothing bound before the search cap`
  if (p.binding === 'thermal') {
    const el = nameOf(p.where?.id) ?? p.where?.element ?? 'an element'
    return `${size}; thermal: ${el} reaches ${p.where ? Math.round(p.where.value) : 100} % of its rating`
  }
  if (p.binding === 'voltage') {
    return `${size}; voltage: bus ${p.where?.bus ?? '?'} falls to ${p.where ? p.where.value.toFixed(3) : 'the lower limit'} pu`
  }
  return `${size}; ${p.binding}`
}
