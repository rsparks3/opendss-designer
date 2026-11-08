import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { HostingCapacityOptions, HostingCapacityResult } from '../types/circuit'
import { runJob } from './jobs'

/** The criteria a hosting-capacity run can switch on, with what each tests. */
export const HC_CRITERIA: { key: string; label: string; der: boolean; load: boolean; help: string }[] = [
  { key: 'voltage', label: 'Voltage', der: true, load: true, help: 'A bus above the upper limit (DER) or below the lower limit (load)' },
  { key: 'thermal', label: 'Thermal', der: true, load: true, help: "A line, transformer or device above the active level's rating" },
  { key: 'deviation', label: 'Voltage change on trip', der: true, load: false, help: 'Any bus moves more than the limit when the unit trips (IEEE 1547 §4.7)' },
  { key: 'regulatorReverse', label: 'Reverse power at a regulator', der: true, load: false, help: 'Power flows backwards through a regulator' },
  { key: 'substationReverse', label: 'Reverse power at the substation', der: true, load: false, help: 'The feeder exports more than the allowed kW at its head' },
  { key: 'faultCurrent', label: 'Fault-current increase', der: true, load: false, help: "The unit's contribution raises the fault current at its bus past the limit (SGIP 10 %)" },
  { key: 'interrupting', label: 'Interrupting duty', der: true, load: false, help: 'A device would exceed the allowed share of its interrupting rating (SGIP 87.5 %)' },
  { key: 'islanding', label: 'Islanding ratio', der: true, load: false, help: 'DER against the minimum load of its protection section' },
]

export const HC_LABELS: Record<string, string> = {
  voltage: 'voltage',
  thermal: 'thermal',
  deviation: 'voltage change on trip',
  regulatorReverse: 'reverse power (regulator)',
  substationReverse: 'reverse power (substation)',
  faultCurrent: 'fault-current increase',
  interrupting: 'interrupting duty',
  islanding: 'islanding ratio',
  controlOps: 'control operations',
  notConverged: 'did not converge',
  none: 'none (capped)',
}

export const DEFAULT_HC_OPTIONS: HostingCapacityOptions = {
  kind: 'der',
  method: 'iterative',
  criteria: Object.fromEntries(HC_CRITERIA.map((c) => [c.key, true])),
  minKv: 1,
  threePhaseOnly: true,
  deviationPct: 3,
  thermalPct: 100,
  substationExportKw: 0,
  faultIncreasePct: 10,
  interruptingPct: 87.5,
  islandingRatio: 0.667,
  derType: 'inverter',
  maxKw: 20000,
  toleranceKw: 10,
  hours: null,
}

/** Run the study as a background job and keep the result. */
export async function runHostingCapacity(options: HostingCapacityOptions): Promise<boolean> {
  const rs = useResultsStore.getState()
  if (rs.hcRunning) return false
  const abort = new AbortController()
  rs.setHcRunning(true, abort)
  try {
    const result = await runJob<HostingCapacityResult>(
      '/api/jobs/hosting-capacity',
      { circuit: toCircuitJSON(useCircuitStore.getState()), options },
      { signal: abort.signal, onProgress: (p) => useResultsStore.getState().setHcProgress(p) },
    )
    const store = useResultsStore.getState()
    if (!result.converged) {
      const why = result.issues.find((i) => i.severity === 'error')?.message
      store.setFlash(why ? `Hosting capacity: ${why}` : 'Hosting capacity: nothing could be evaluated.')
      return false
    }
    store.setHosting(result)
    const s = result.summary
    store.setFlash(
      `${s.evaluated} buses in ${s.seconds} s (${s.solves} solves): ` +
        `${s.minKw != null ? `${(s.minKw / 1000).toFixed(2)}–${((s.maxKw ?? 0) / 1000).toFixed(2)} MW` : 'no capacity found'}` +
        (result.cancelled ? ' (cancelled part way)' : ''),
      'info',
      8000,
    )
    return true
  } catch (err) {
    const msg = (err as Error).message
    useResultsStore.getState().setFlash(
      msg === 'cancelled' ? 'Hosting-capacity run cancelled.' : `Hosting capacity: ${msg}`,
      msg === 'cancelled' ? 'info' : 'error',
    )
    return false
  } finally {
    useResultsStore.getState().setHcRunning(false)
  }
}

/** Colour for a capacity, green (plenty) through amber to red (none), on a
 *  scale set by the run's largest value. */
export function hostingColor(kw: number | null | undefined, maxKw: number): string {
  if (kw == null) return '#9e9e9e'
  const t = Math.max(0, Math.min(1, maxKw > 0 ? kw / maxKw : 0))
  // Hue from red (0) to green (130) by capacity.
  return `hsl(${Math.round(130 * t)}, 70%, ${Math.round(42 - 6 * t)}%)`
}

export function formatKw(kw: number | null | undefined): string {
  if (kw == null) return '—'
  return kw >= 1000 ? `${(kw / 1000).toFixed(2)} MW` : `${kw.toFixed(0)} kW`
}

// --- exports ---------------------------------------------------------------------

/** The result as GeoJSON points, one per bus with coordinates, for a
 *  utility's GIS or a public hosting-capacity map. */
export function hostingGeoJson(result: HostingCapacityResult, crs: string | null): string {
  const { nodes } = useCircuitStore.getState()
  const busOf = new Map<string, { x: number; y: number; name: string }>()
  for (const n of nodes) {
    const buses = result.nodeBuses[n.id] ?? []
    if (!n.data.geo || !buses.length) continue
    for (const b of buses) if (!busOf.has(b)) busOf.set(b, { ...n.data.geo, name: String(n.data.params.name ?? n.id) })
  }
  const features = Object.entries(result.buses)
    .filter(([bus]) => busOf.has(bus))
    .map(([bus, r]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [busOf.get(bus)!.x, busOf.get(bus)!.y] },
      properties: {
        bus: result.busNames[bus] ?? bus,
        element: busOf.get(bus)!.name,
        kind: result.kind,
        capacity_kw: r.kw,
        binding: r.binding,
        capped: r.capped,
        kv_base: r.kvBase,
        phases: r.phases,
        ...Object.fromEntries(Object.entries(r.byCriterion).map(([k, v]) => [`kw_${k}`, v])),
        ...(r.kwByHour ? Object.fromEntries(Object.entries(r.kwByHour).map(([h, v]) => [`kw_h${h}`, v])) : {}),
      },
    }))
  const out: Record<string, unknown> = { type: 'FeatureCollection', features }
  if (crs) out.crs = { type: 'name', properties: { name: crs } }
  return JSON.stringify(out, null, 1)
}

export function hostingCsv(result: HostingCapacityResult): string {
  const crit = Object.keys(result.criteria).filter((k) => result.criteria[k])
  const hours = result.hours ?? []
  const head = ['bus', 'kind', 'capacity_kw', 'binding', 'capped', 'kv_base', 'phases', 'section_load_kw',
    ...crit.map((c) => `kw_${c}`), ...hours.map((h) => `kw_h${h}`)]
  const rows = Object.entries(result.buses).map(([bus, r]) => [
    result.busNames[bus] ?? bus, result.kind, r.kw, r.binding ?? '', r.capped ? 'yes' : 'no', r.kvBase, r.phases,
    r.sectionLoadKw,
    ...crit.map((c) => r.byCriterion[c] ?? ''),
    ...hours.map((h) => r.kwByHour?.[String(h)] ?? ''),
  ])
  const esc = (v: unknown) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n'
}
