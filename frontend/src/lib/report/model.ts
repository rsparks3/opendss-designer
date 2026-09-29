/** The study report as data: titled tables and figures, built from the
 *  circuit and whatever results exist. Both writers (report/pdf.ts and
 *  report/xlsx.ts) render this one structure, so the PDF and the workbook
 *  always say the same thing.
 *
 *  The sections follow what the distribution planning tools print for a
 *  load-flow study -- a summary, the abnormal conditions against the
 *  planning criteria, bus voltages, branch flows, loads and generation,
 *  losses -- then short circuit, protection and time series when asked.
 *  Numbers are kept as numbers; each column says how many decimals to show.
 */
import type {
  CircuitJSON,
  FaultResult,
  LimitsJSON,
  SolveResult,
  StudyInfoJSON,
  TimeSeriesResult,
} from '../../types/circuit'
import { EMPTY_STUDY, limitsOf } from '../limits'
import { operateSeconds, type TccResult } from '../tcc'
import { traceUnit } from './charts'

export type SectionKey = 'loadflow' | 'diagram' | 'shortcircuit' | 'protection' | 'timeseries'

export type Cell = string | number | null

export interface Column {
  key: string
  label: string
  unit?: string
  /** Decimals for a number; absent for text. */
  digits?: number
  /** Relative width in the PDF; text columns default wider. */
  width?: number
}

/** How a row reads against the criteria, for tinting. */
export type RowFlag = 'violation' | 'warning' | null

export interface Table {
  id: string
  title: string
  columns: Column[]
  rows: Record<string, Cell>[]
  flags?: RowFlag[]
  /** A line under the table: what the numbers mean, or why it is empty. */
  note?: string
  /** Too long for paper (every step of a yearly run): the workbook only. */
  workbookOnly?: boolean
  /** A two-column list of quantities rather than a grid. */
  keyValue?: boolean
}

export interface Figure {
  id: string
  title: string
  svg: string
  /** A page of its own, turned sideways (the one-line). */
  landscape?: boolean
}

export interface ReportSection {
  id: string
  title: string
  tables: Table[]
  figures: Figure[]
}

export interface ReportMeta {
  study: StudyInfoJSON
  circuitName: string
  date: Date
  limits: LimitsJSON
  softwareVersion: string | null
  engineVersion: string | null
}

export interface Report {
  meta: ReportMeta
  sections: ReportSection[]
}

export interface ReportInput {
  circuit: CircuitJSON
  solve: SolveResult | null
  fault?: FaultResult | null
  tcc?: TccResult | null
  timeseries?: TimeSeriesResult | null
  /** SVG drawings the caller rendered: the one-line (from the canvas) and
   *  the charts (report/charts.ts). */
  figures?: Partial<Record<'diagram' | 'profile' | 'tcc' | 'timeseries', string>>
  sections: ReadonlySet<SectionKey>
  date: Date
  softwareVersion?: string | null
  engineVersion?: string | null
}

export const SECTION_LABELS: Record<SectionKey, string> = {
  loadflow: 'Load flow',
  diagram: 'One-line diagram',
  shortcircuit: 'Short circuit',
  protection: 'Protection',
  timeseries: 'Time series',
}

export const TYPE_NAMES: Record<string, string> = {
  vsource: 'Source',
  busbar: 'Bus',
  transformer: 'Transformer',
  regulator: 'Regulator',
  breaker: 'Breaker',
  fuse: 'Fuse',
  recloser: 'Recloser',
  relay: 'Relay',
  load: 'Load',
  capacitor: 'Capacitor',
  generator: 'Generator',
  pvsystem: 'PV system',
  storage: 'Storage',
  line: 'Line',
  note: 'Note',
}

const SERIES = new Set(['line', 'transformer', 'regulator', 'breaker', 'fuse', 'recloser', 'relay'])

const PLURALS: Record<string, string> = {
  busbar: 'Buses',
  storage: 'Storage units',
  pvsystem: 'PV systems',
  vsource: 'Sources',
}
const plural = (type: string, n: number) =>
  n === 1 ? (TYPE_NAMES[type] ?? type) : (PLURALS[type] ?? `${TYPE_NAMES[type] ?? type}s`)

/** The engine's version as one short line: DSS-Extensions reports several
 *  libraries and a revision hash. */
export function engineLabel(raw: string | null | undefined): string | null {
  const first = raw?.split(/\r?\n/)[0].replace(/\s+revision\s+\S+.*$/i, '').trim()
  return first || null
}
const SQRT3 = Math.sqrt(3)
const LETTERS = ['', 'A', 'B', 'C']

/** Rounded the way the column will print it, so a sum in the workbook
 *  matches the rows above it. */
const round = (v: number, digits: number) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}
const num = (v: number | null | undefined, digits: number): number | null =>
  v == null || !Number.isFinite(v) ? null : round(v, digits)

/** Names and types by diagram id, and display names for the engine's buses. */
export class Names {
  private byId = new Map<string, { name: string; type: string }>()
  private buses = new Map<string, string>()

  constructor(circuit: CircuitJSON, nodeBuses: Record<string, string[]>) {
    for (const n of circuit.nodes) {
      this.byId.set(n.id, { name: String(n.params.name ?? n.id), type: n.type })
      // A busbar's bus goes by the busbar's own name, as it is drawn.
      const bus = n.type === 'busbar' ? nodeBuses[n.id]?.[0] : undefined
      if (bus && typeof n.params.name === 'string' && n.params.name) this.buses.set(bus, n.params.name)
    }
    for (const e of circuit.edges) {
      if (e.type === 'line') this.byId.set(e.id, { name: String(e.params?.name ?? e.id), type: 'line' })
    }
  }

  element(id: string, fallback: string): { name: string; type: string } {
    return this.byId.get(id) ?? { name: fallback.split('.').slice(1).join('.') || fallback, type: fallback.split('.')[0] }
  }

  bus(key: string | undefined | null): string {
    if (!key) return '—'
    return this.buses.get(key) ?? key.toUpperCase()
  }
}

/** A result's per-phase values keyed A/B/C by the node each belongs to. */
function byPhase(values: number[], nodes: number[] | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  values.forEach((v, i) => {
    const letter = LETTERS[nodes?.[i] ?? i + 1]
    if (letter && !(letter in out)) out[letter] = v
  })
  return out
}

const phaseLetters = (nodes: number[] | undefined) =>
  (nodes ?? []).map((n) => LETTERS[n] ?? '').filter(Boolean).join('')

type BusStatus = 'Undervoltage' | 'Overvoltage' | 'De-energized' | 'OK'

function busStatus(vmin: number | null, vmax: number | null, limits: LimitsJSON): BusStatus {
  if (vmax == null || vmax < 0.05) return 'De-energized'
  if (vmin != null && vmin < limits.vminPu) return 'Undervoltage'
  if (vmax > limits.vmaxPu) return 'Overvoltage'
  return 'OK'
}

function loadingFlag(pct: number | null, limits: LimitsJSON): RowFlag {
  if (pct == null) return null
  if (pct >= limits.overloadPct) return 'violation'
  if (pct >= limits.warnPct) return 'warning'
  return null
}

const kv = (label: string, value: Cell, unit = '') => ({ item: label, value, unit })
const KV_COLUMNS: Column[] = [
  { key: 'item', label: 'Quantity', width: 3 },
  { key: 'value', label: 'Value', width: 2 },
  { key: 'unit', label: 'Unit', width: 1 },
]

export function buildReport(input: ReportInput): Report {
  const { circuit, solve, sections } = input
  const limits = limitsOf(circuit.limits)
  const meta: ReportMeta = {
    study: { ...EMPTY_STUDY, ...(circuit.study ?? {}) },
    circuitName: circuit.name,
    date: input.date,
    limits,
    softwareVersion: input.softwareVersion ?? null,
    engineVersion: engineLabel(input.engineVersion),
  }
  const out: ReportSection[] = []
  const solved = solve?.converged ? solve : null
  const names = new Names(circuit, solved?.nodeBuses ?? input.fault?.nodeBuses ?? {})

  out.push(studySection(meta, circuit, solve))

  if (sections.has('loadflow')) {
    if (!solved) {
      out.push({
        id: 'loadflow',
        title: 'Load flow',
        tables: [
          {
            id: 'no-solve',
            title: 'Load flow',
            columns: [{ key: 'text', label: '' }],
            rows: [],
            note: 'The circuit has no converged power-flow solution; solve it before exporting.',
          },
        ],
        figures: [],
      })
    } else {
      out.push(summarySection(solved, names, limits))
      out.push(abnormalSection(solved, names, limits))
      out.push(busSection(solved, names, limits, input.figures?.profile))
      out.push(branchSection(solved, names, limits))
      out.push(loadSection(solved, names))
      out.push(lossSection(solved, names))
    }
  }

  if (sections.has('diagram') && input.figures?.diagram) {
    out.push({
      id: 'diagram',
      title: 'One-line diagram',
      tables: [],
      figures: [{ id: 'oneline', title: circuit.name || 'One-line diagram', svg: input.figures.diagram, landscape: true }],
    })
  }

  const notes = notesTable(circuit, names)
  if (notes && (sections.has('diagram') || sections.has('loadflow'))) {
    out.push({ id: 'notes', title: 'Notes', tables: [notes], figures: [] })
  }

  if (sections.has('shortcircuit') && input.fault?.converged) {
    out.push(faultSection(input.fault, new Names(circuit, input.fault.nodeBuses)))
  }
  if (sections.has('protection') && input.tcc) {
    out.push(protectionSection(input.tcc, names, input.figures?.tcc))
  }
  if (sections.has('timeseries') && input.timeseries) {
    out.push(timeSeriesSection(input.timeseries, names, input.figures?.timeseries))
  }
  return { meta, sections: out }
}

// --- sections -------------------------------------------------------------

function studySection(meta: ReportMeta, circuit: CircuitJSON, solve: SolveResult | null): ReportSection {
  const s = meta.study
  const counts = new Map<string, number>()
  for (const n of circuit.nodes) {
    if (n.type === 'note') continue
    counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
  }
  const lines = circuit.edges.filter((e) => e.type === 'line').length
  if (lines) counts.set('line', lines)
  const rows = [
    kv('Study', s.title || circuit.name),
    kv('Case', s.caseName || '—'),
    kv('Circuit', circuit.name),
    kv('Engineer', s.engineer || '—'),
    kv('Company', s.company || '—'),
    kv('Date', meta.date.toLocaleString()),
    kv('Software', meta.softwareVersion ? `OpenDSS Designer ${meta.softwareVersion}` : 'OpenDSS Designer'),
    kv('Solver', meta.engineVersion ?? 'OpenDSS'),
    kv('Solution', solve ? (solve.converged ? `Converged in ${solve.iterations} iterations` : 'Did not converge') : 'Not solved'),
  ]
  const criteria: Table = {
    id: 'criteria',
    title: 'Planning criteria',
    keyValue: true,
    columns: KV_COLUMNS,
    rows: [
      kv('Undervoltage below', meta.limits.vminPu, 'pu'),
      kv('Overvoltage above', meta.limits.vmaxPu, 'pu'),
      kv('Loading warning at', meta.limits.warnPct, '%'),
      kv('Overload at', meta.limits.overloadPct, '% of rating'),
    ],
  }
  const elements: Table = {
    id: 'element-counts',
    title: 'Model',
    keyValue: true,
    columns: KV_COLUMNS,
    rows: [...counts].map(([t, n]) => kv(plural(t, n), n)),
  }
  return {
    id: 'study',
    title: 'Study',
    tables: [
      { id: 'title-block', title: 'Study', keyValue: true, columns: KV_COLUMNS, rows, note: s.description || undefined },
      criteria,
      elements,
    ],
    figures: [],
  }
}

interface Totals {
  sourceKw: number
  sourceKvar: number
  loadKw: number
  loadKvar: number
  genKw: number
  genKvar: number
  capKvar: number
}

export function totals(solve: SolveResult, names: { element: Names['element'] }): Totals {
  const t: Totals = { sourceKw: 0, sourceKvar: 0, loadKw: 0, loadKvar: 0, genKw: 0, genKvar: 0, capKvar: 0 }
  for (const [full, e] of Object.entries(solve.elements)) {
    const { type } = names.element(e.id, full)
    // Terminal power is into the element: a source or generator delivering
    // power reads negative.
    if (type === 'vsource') {
      t.sourceKw -= e.kw
      t.sourceKvar -= e.kvar
    } else if (type === 'load') {
      t.loadKw += e.kw
      t.loadKvar += e.kvar
    } else if (type === 'generator' || type === 'pvsystem' || type === 'storage') {
      t.genKw -= e.kw
      t.genKvar -= e.kvar
    } else if (type === 'capacitor') {
      t.capKvar -= e.kvar
    }
  }
  return t
}

function summarySection(solve: SolveResult, names: Names, limits: LimitsJSON): ReportSection {
  const t = totals(solve, names)
  const kva = Math.hypot(t.sourceKw, t.sourceKvar)
  const pf = kva ? Math.abs(t.sourceKw) / kva : null
  const losses = solve.losses ?? { kw: 0, kvar: 0 }
  const input = t.sourceKw + Math.max(t.genKw, 0)

  let vmin: { v: number; bus: string } | null = null
  let vmax: { v: number; bus: string } | null = null
  for (const [bus, b] of Object.entries(solve.buses)) {
    if (b.vmaxPu == null || b.vmaxPu < 0.05) continue // de-energized: reported apart
    if (b.vminPu != null && (!vmin || b.vminPu < vmin.v)) vmin = { v: b.vminPu, bus }
    if (!vmax || b.vmaxPu > vmax.v) vmax = { v: b.vmaxPu, bus }
  }
  const abnormal = abnormalRows(solve, names, limits)
  const violations = abnormal.filter((r) => r.flag === 'violation').length
  const warnings = abnormal.filter((r) => r.flag === 'warning').length

  const rows = [
    kv('Source real power', num(t.sourceKw, 1), 'kW'),
    kv('Source reactive power', num(t.sourceKvar, 1), 'kvar'),
    kv('Source apparent power', num(kva, 1), 'kVA'),
    kv('Source power factor', num(pf, 3), ''),
    kv('Total load', num(t.loadKw, 1), 'kW'),
    kv('Total load (reactive)', num(t.loadKvar, 1), 'kvar'),
    kv('Generation (PV, generators, storage)', num(t.genKw, 1), 'kW'),
    kv('Capacitors', num(t.capKvar, 1), 'kvar'),
    kv('Losses', num(losses.kw, 2), 'kW'),
    kv('Losses (reactive)', num(losses.kvar, 2), 'kvar'),
    kv('Losses, share of power in', input > 0 ? num((100 * losses.kw) / input, 2) : null, '%'),
    kv('Lowest voltage', vmin ? num(vmin.v, 4) : null, vmin ? `pu at ${names.bus(vmin.bus)}` : 'pu'),
    kv('Highest voltage', vmax ? num(vmax.v, 4) : null, vmax ? `pu at ${names.bus(vmax.bus)}` : 'pu'),
    kv('Violations', violations, ''),
    kv('Warnings', warnings, ''),
  ]
  return {
    id: 'summary',
    title: 'Load flow summary',
    tables: [{ id: 'summary', title: 'Load flow summary', keyValue: true, columns: KV_COLUMNS, rows }],
    figures: [],
  }
}

interface AbnormalRow {
  flag: RowFlag
  condition: string
  element: string
  type: string
  phase: string
  value: number
  unit: string
  limit: number
  /** How far past the limit, as a fraction of it, for sorting. */
  severity: number
}

function abnormalRows(solve: SolveResult, names: Names, limits: LimitsJSON): AbnormalRow[] {
  const rows: AbnormalRow[] = []
  for (const [bus, b] of Object.entries(solve.buses)) {
    const status = busStatus(b.vminPu, b.vmaxPu, limits)
    if (status === 'OK') continue
    const phases = byPhase(b.vmagPu, b.nodes)
    const pick = (want: (v: number) => boolean) =>
      Object.entries(phases).filter(([, v]) => want(v)).map(([p]) => p).join('')
    if (status === 'De-energized') {
      rows.push({ flag: 'violation', condition: 'De-energized', element: names.bus(bus), type: 'Bus', phase: phaseLetters(b.nodes), value: b.vmaxPu ?? 0, unit: 'pu', limit: limits.vminPu, severity: 10 })
    } else if (status === 'Undervoltage') {
      rows.push({ flag: 'violation', condition: 'Undervoltage', element: names.bus(bus), type: 'Bus', phase: pick((v) => v < limits.vminPu), value: b.vminPu!, unit: 'pu', limit: limits.vminPu, severity: (limits.vminPu - b.vminPu!) / limits.vminPu })
    } else {
      rows.push({ flag: 'violation', condition: 'Overvoltage', element: names.bus(bus), type: 'Bus', phase: pick((v) => v > limits.vmaxPu), value: b.vmaxPu!, unit: 'pu', limit: limits.vmaxPu, severity: (b.vmaxPu! - limits.vmaxPu) / limits.vmaxPu })
    }
  }
  for (const [full, e] of Object.entries(solve.elements)) {
    const flag = loadingFlag(e.loadingPct, limits)
    if (!flag || e.loadingPct == null) continue
    const { name, type } = names.element(e.id, full)
    // Loading criteria are for what carries the feeder's current; a
    // capacitor near its rated current is doing its job.
    if (!SERIES.has(type)) continue
    const limit = flag === 'violation' ? limits.overloadPct : limits.warnPct
    const worst = byPhase(e.currents, e.phaseNodes)
    const peak = Math.max(...Object.values(worst))
    const phase = Object.entries(worst).filter(([, a]) => a >= peak - 1e-9).map(([p]) => p).join('')
    rows.push({
      flag,
      condition: flag === 'violation' ? 'Overload' : 'Heavy loading',
      element: name,
      type: TYPE_NAMES[type] ?? type,
      phase,
      value: e.loadingPct,
      unit: '% of rating',
      limit,
      severity: (e.loadingPct - limit) / limit,
    })
  }
  return rows.sort(
    (a, b) => (a.flag === b.flag ? 0 : a.flag === 'violation' ? -1 : 1) || b.severity - a.severity,
  )
}

function abnormalSection(solve: SolveResult, names: Names, limits: LimitsJSON): ReportSection {
  const rows = abnormalRows(solve, names, limits)
  return {
    id: 'abnormal',
    title: 'Abnormal conditions',
    tables: [
      {
        id: 'abnormal',
        title: 'Abnormal conditions',
        columns: [
          { key: 'condition', label: 'Condition', width: 1.6 },
          { key: 'element', label: 'Element', width: 2 },
          { key: 'type', label: 'Type', width: 1.3 },
          { key: 'phase', label: 'Phase', width: 0.8 },
          { key: 'value', label: 'Value', digits: 3 },
          { key: 'limit', label: 'Limit', digits: 3 },
          { key: 'unit', label: 'Unit', width: 1.3 },
        ],
        rows: rows.map((r) => ({
          condition: r.condition,
          element: r.element,
          type: r.type,
          phase: r.phase,
          value: num(r.value, r.unit === 'pu' ? 4 : 1),
          limit: r.limit,
          unit: r.unit,
        })),
        flags: rows.map((r) => r.flag),
        note: rows.length
          ? undefined
          : 'No bus voltage or element loading is outside the planning criteria.',
      },
    ],
    figures: [],
  }
}

function busSection(solve: SolveResult, names: Names, limits: LimitsJSON, profile?: string): ReportSection {
  const entries = Object.entries(solve.buses)
  const rows: Record<string, Cell>[] = []
  const flags: RowFlag[] = []
  for (const [bus, b] of entries) {
    const v = byPhase(b.vmagPu, b.nodes)
    const a = byPhase(b.vangDeg, b.nodes)
    const status = busStatus(b.vminPu, b.vmaxPu, limits)
    rows.push({
      bus: names.bus(bus),
      kvll: num(b.kvBase * SQRT3, 3),
      phases: phaseLetters(b.nodes),
      va: num(v.A, 4), vb: num(v.B, 4), vc: num(v.C, 4),
      aa: num(a.A, 1), ab: num(a.B, 1), ac: num(a.C, 1),
      vmin: num(b.vminPu, 4),
      vmax: num(b.vmaxPu, 4),
      status,
    })
    flags.push(status === 'OK' ? null : 'violation')
  }
  return {
    id: 'buses',
    title: 'Bus voltages',
    tables: [
      {
        id: 'buses',
        title: 'Bus voltages',
        columns: [
          { key: 'bus', label: 'Bus', width: 2 },
          { key: 'kvll', label: 'Base', unit: 'kV LL', digits: 2 },
          { key: 'phases', label: 'Phases', width: 0.8 },
          { key: 'va', label: 'V A', unit: 'pu', digits: 4 },
          { key: 'vb', label: 'V B', unit: 'pu', digits: 4 },
          { key: 'vc', label: 'V C', unit: 'pu', digits: 4 },
          { key: 'aa', label: '∠ A', unit: '°', digits: 1 },
          { key: 'ab', label: '∠ B', unit: '°', digits: 1 },
          { key: 'ac', label: '∠ C', unit: '°', digits: 1 },
          { key: 'vmin', label: 'V min', unit: 'pu', digits: 4 },
          { key: 'vmax', label: 'V max', unit: 'pu', digits: 4 },
          { key: 'status', label: 'Status', width: 1.5 },
        ],
        rows,
        flags,
        note: 'Voltages are line-to-neutral magnitudes in per unit of the bus base; angles are relative to the source.',
      },
    ],
    figures: profile ? [{ id: 'profile', title: 'Voltage profile', svg: profile }] : [],
  }
}

function branchSection(solve: SolveResult, names: Names, limits: LimitsJSON): ReportSection {
  const rows: Record<string, Cell>[] = []
  const flags: RowFlag[] = []
  for (const [full, e] of Object.entries(solve.elements)) {
    const { name, type } = names.element(e.id, full)
    if (!SERIES.has(type)) continue
    const buses = type === 'line' ? solve.lineBuses[e.id] : solve.nodeBuses[e.id]
    const amps = byPhase(e.currents, e.phaseNodes)
    rows.push({
      element: name,
      type: TYPE_NAMES[type] ?? type,
      from: names.bus(buses?.[0]),
      to: names.bus(buses?.[1]),
      phases: phaseLetters(e.phaseNodes),
      ia: num(amps.A, 1), ib: num(amps.B, 1), ic: num(amps.C, 1),
      rating: num(e.normAmps, 0),
      loading: num(e.loadingPct, 1),
      kw: num(e.kw, 1),
      kvar: num(e.kvar, 1),
      losskw: num(e.lossKw, 3),
      losskvar: num(e.lossKvar, 3),
    })
    flags.push(loadingFlag(e.loadingPct, limits))
  }
  return {
    id: 'branches',
    title: 'Branch flows',
    tables: [
      {
        id: 'branches',
        title: 'Branch flows',
        columns: [
          { key: 'element', label: 'Element', width: 1.8 },
          { key: 'type', label: 'Type', width: 1.3 },
          { key: 'from', label: 'From bus', width: 1.6 },
          { key: 'to', label: 'To bus', width: 1.6 },
          { key: 'phases', label: 'Ph', width: 0.6 },
          { key: 'ia', label: 'I A', unit: 'A', digits: 1 },
          { key: 'ib', label: 'I B', unit: 'A', digits: 1 },
          { key: 'ic', label: 'I C', unit: 'A', digits: 1 },
          { key: 'rating', label: 'Rating', unit: 'A', digits: 0 },
          { key: 'loading', label: 'Loading', unit: '%', digits: 1 },
          { key: 'kw', label: 'P', unit: 'kW', digits: 1 },
          { key: 'kvar', label: 'Q', unit: 'kvar', digits: 1 },
          { key: 'losskw', label: 'Loss', unit: 'kW', digits: 3 },
          { key: 'losskvar', label: 'Loss', unit: 'kvar', digits: 3 },
        ],
        rows,
        flags,
        note: 'Currents and power are at the from-bus terminal; power is positive flowing away from the from bus.',
      },
    ],
    figures: [],
  }
}

function loadSection(solve: SolveResult, names: Names): ReportSection {
  const loads: Record<string, Cell>[] = []
  const gens: Record<string, Cell>[] = []
  for (const [full, e] of Object.entries(solve.elements)) {
    const { name, type } = names.element(e.id, full)
    const bus = solve.nodeBuses[e.id]?.[0]
    const vbus = bus ? solve.buses[bus]?.vminPu : null
    if (type === 'load') {
      const kva = Math.hypot(e.kw, e.kvar)
      loads.push({
        element: name,
        bus: names.bus(bus),
        phases: phaseLetters(e.phaseNodes),
        kw: num(e.kw, 1),
        kvar: num(e.kvar, 1),
        kva: num(kva, 1),
        pf: kva ? num(e.kw / kva, 3) : null,
        v: num(vbus, 4),
      })
    } else if (type === 'generator' || type === 'pvsystem' || type === 'storage' || type === 'capacitor') {
      gens.push({
        element: name,
        type: TYPE_NAMES[type],
        bus: names.bus(bus),
        phases: phaseLetters(e.phaseNodes),
        kw: num(-e.kw, 1),
        kvar: num(-e.kvar, 1),
        v: num(vbus, 4),
      })
    }
  }
  const tables: Table[] = [
    {
      id: 'loads',
      title: 'Loads',
      columns: [
        { key: 'element', label: 'Load', width: 2 },
        { key: 'bus', label: 'Bus', width: 2 },
        { key: 'phases', label: 'Ph', width: 0.6 },
        { key: 'kw', label: 'P', unit: 'kW', digits: 1 },
        { key: 'kvar', label: 'Q', unit: 'kvar', digits: 1 },
        { key: 'kva', label: 'S', unit: 'kVA', digits: 1 },
        { key: 'pf', label: 'PF', digits: 3 },
        { key: 'v', label: 'V min at bus', unit: 'pu', digits: 4 },
      ],
      rows: loads,
      note: loads.length ? undefined : 'The circuit has no loads.',
    },
  ]
  if (gens.length) {
    tables.push({
      id: 'generation',
      title: 'Generation, storage and capacitors',
      columns: [
        { key: 'element', label: 'Element', width: 2 },
        { key: 'type', label: 'Type', width: 1.3 },
        { key: 'bus', label: 'Bus', width: 2 },
        { key: 'phases', label: 'Ph', width: 0.6 },
        { key: 'kw', label: 'P out', unit: 'kW', digits: 1 },
        { key: 'kvar', label: 'Q out', unit: 'kvar', digits: 1 },
        { key: 'v', label: 'V min at bus', unit: 'pu', digits: 4 },
      ],
      rows: gens,
      note: 'Output is positive delivered into the network; storage reads negative while charging.',
    })
  }
  return { id: 'loads', title: 'Loads and generation', tables, figures: [] }
}

function lossSection(solve: SolveResult, names: Names): ReportSection {
  const total = solve.losses?.kw ?? 0
  const items = Object.entries(solve.elements)
    .filter(([, e]) => e.lossKw != null)
    .map(([full, e]) => ({ ...names.element(e.id, full), kw: e.lossKw!, kvar: e.lossKvar ?? 0 }))
    .sort((a, b) => b.kw - a.kw)
  const byType = new Map<string, { kw: number; kvar: number; n: number }>()
  for (const i of items) {
    const t = TYPE_NAMES[i.type] ?? i.type
    const acc = byType.get(t) ?? { kw: 0, kvar: 0, n: 0 }
    acc.kw += i.kw
    acc.kvar += i.kvar
    acc.n += 1
    byType.set(t, acc)
  }
  const pct = (kw: number) => (total > 0 ? num((100 * kw) / total, 1) : null)
  return {
    id: 'losses',
    title: 'Losses',
    tables: [
      {
        id: 'loss-types',
        title: 'Losses by element type',
        columns: [
          { key: 'type', label: 'Type', width: 2 },
          { key: 'n', label: 'Count', digits: 0 },
          { key: 'kw', label: 'Loss', unit: 'kW', digits: 3 },
          { key: 'kvar', label: 'Loss', unit: 'kvar', digits: 3 },
          { key: 'pct', label: 'Share', unit: '%', digits: 1 },
        ],
        rows: [
          ...[...byType].map(([type, a]) => ({ type, n: a.n, kw: num(a.kw, 3), kvar: num(a.kvar, 3), pct: pct(a.kw) })),
          { type: 'Circuit total', n: items.length, kw: num(total, 3), kvar: num(solve.losses?.kvar ?? 0, 3), pct: total > 0 ? 100 : null },
        ],
        note: 'The circuit total is the engine\'s own figure; it can differ slightly from the sum of the elements listed.',
      },
      {
        id: 'loss-elements',
        title: 'Losses by element',
        columns: [
          { key: 'element', label: 'Element', width: 2 },
          { key: 'type', label: 'Type', width: 1.3 },
          { key: 'kw', label: 'Loss', unit: 'kW', digits: 3 },
          { key: 'kvar', label: 'Loss', unit: 'kvar', digits: 3 },
          { key: 'pct', label: 'Share', unit: '%', digits: 1 },
        ],
        rows: items.map((i) => ({
          element: i.name,
          type: TYPE_NAMES[i.type] ?? i.type,
          kw: num(i.kw, 3),
          kvar: num(i.kvar, 3),
          pct: pct(i.kw),
        })),
      },
    ],
    figures: [],
  }
}

function notesTable(circuit: CircuitJSON, names: Names): Table | null {
  const rows = circuit.nodes
    .filter((n) => n.type === 'note' && String(n.params.text ?? '').trim())
    .map((n) => {
      const target = typeof n.params.target === 'string' ? n.params.target : ''
      const known = circuit.nodes.some((x) => x.id === target) || circuit.edges.some((e) => e.id === target)
      return {
        text: String(n.params.text).trim(),
        target: target && known ? names.element(target, target).name : '—',
      }
    })
  if (!rows.length) return null
  return {
    id: 'notes',
    title: 'Notes',
    columns: [
      { key: 'text', label: 'Note', width: 5 },
      { key: 'target', label: 'About', width: 1.5 },
    ],
    rows,
  }
}

function faultSection(fault: FaultResult, names: Names): ReportSection {
  const rows = Object.entries(fault.buses).map(([bus, b]) => ({
    bus: names.bus(bus),
    kvll: num(b.kvBase * SQRT3, 3),
    i3: num(b.if3phA, 0),
    i1: num(b.if1phA, 0),
    mva: num(b.scMva3, 2),
    r1: num(b.zsc1.r, 4),
    x1: num(b.zsc1.x, 4),
    r0: num(b.zsc0.r, 4),
    x0: num(b.zsc0.x, 4),
    xr: b.zsc1.r > 0 ? num(b.zsc1.x / b.zsc1.r, 2) : null,
  }))
  return {
    id: 'shortcircuit',
    title: 'Short circuit',
    tables: [
      {
        id: 'shortcircuit',
        title: 'Short-circuit currents',
        columns: [
          { key: 'bus', label: 'Bus', width: 2 },
          { key: 'kvll', label: 'Base', unit: 'kV LL', digits: 2 },
          { key: 'i3', label: '3-phase', unit: 'A', digits: 0 },
          { key: 'i1', label: 'Line-ground', unit: 'A', digits: 0 },
          { key: 'mva', label: '3φ short-circuit', unit: 'MVA', digits: 2 },
          { key: 'r1', label: 'R1', unit: 'Ω', digits: 4 },
          { key: 'x1', label: 'X1', unit: 'Ω', digits: 4 },
          { key: 'r0', label: 'R0', unit: 'Ω', digits: 4 },
          { key: 'x0', label: 'X0', unit: 'Ω', digits: 4 },
          { key: 'xr', label: 'X/R', digits: 2 },
        ],
        rows,
        note: 'Bolted faults with the network as solved: loads, capacitors and storage are left out, as OpenDSS\'s fault study does. Impedances are the Thevenin equivalent at the bus.',
      },
    ],
    figures: [],
  }
}

function protectionSection(tcc: TccResult, names: Names, plot?: string): ReportSection {
  const settings: Record<string, Cell>[] = []
  for (const d of tcc.devices) {
    for (const t of d.traces) {
      const avail = t.fault === 'ground' ? d.faultA1ph : (d.faultA3ph ?? d.faultA1ph)
      const secs = avail ? operateSeconds(t, avail) : null
      settings.push({
        device: d.nodeId ? names.element(d.nodeId, d.name).name : d.name,
        type: TYPE_NAMES[d.kind] ?? d.kind,
        bus: names.bus(d.bus),
        unit: traceUnit(d, t),
        fault: t.fault === 'ground' ? 'Ground' : 'Phase',
        curve: t.curve,
        pickup: num(t.pickupA, 1),
        avail: num(avail, 0),
        time: num(secs, 3),
      })
    }
  }
  const duty: Record<string, Cell>[] = []
  const dutyFlags: RowFlag[] = []
  for (const s of tcc.switches) {
    const availKa = Math.max(s.faultA3ph ?? 0, s.faultA1ph ?? 0) / 1000
    const rating = s.interruptingKa ?? null
    const pct = rating ? (100 * availKa) / rating : null
    duty.push({
      device: names.element(s.nodeId, s.name).name,
      type: TYPE_NAMES[s.kind] ?? s.kind,
      bus: names.bus(s.bus),
      avail: num(availKa, 2),
      rating: num(rating, 2),
      pct: num(pct, 1),
    })
    dutyFlags.push(pct == null ? null : pct >= 100 ? 'violation' : pct >= 80 ? 'warning' : null)
  }
  const findings = tcc.issues.map((i) => ({ severity: i.severity === 'error' ? 'Error' : 'Warning', finding: i.message }))
  return {
    id: 'protection',
    title: 'Protection',
    tables: [
      {
        id: 'protection-settings',
        title: 'Protective device settings',
        columns: [
          { key: 'device', label: 'Device', width: 1.5 },
          { key: 'type', label: 'Type', width: 1.2 },
          { key: 'bus', label: 'Bus', width: 1.5 },
          { key: 'unit', label: 'Element', width: 1.6 },
          { key: 'fault', label: 'Sees', width: 0.9 },
          { key: 'curve', label: 'Curve', width: 1.3 },
          { key: 'pickup', label: 'Pickup', unit: 'A', digits: 1 },
          { key: 'avail', label: 'Fault avail.', unit: 'A', digits: 0 },
          { key: 'time', label: 'Operates in', unit: 's', digits: 3 },
        ],
        rows: settings,
        note: settings.length
          ? 'Available fault current is at the device\'s bus: three-phase for phase elements, line-to-ground for ground elements.'
          : 'The circuit has no fuses, reclosers or relays.',
      },
      {
        id: 'interrupting-duty',
        title: 'Interrupting duty',
        columns: [
          { key: 'device', label: 'Switch', width: 1.5 },
          { key: 'type', label: 'Type', width: 1.2 },
          { key: 'bus', label: 'Bus', width: 1.5 },
          { key: 'avail', label: 'Fault avail.', unit: 'kA', digits: 2 },
          { key: 'rating', label: 'Interrupting rating', unit: 'kA', digits: 2 },
          { key: 'pct', label: 'Duty', unit: '%', digits: 1 },
        ],
        rows: duty,
        flags: dutyFlags,
        note: duty.length ? undefined : 'The circuit has no switching devices.',
      },
      {
        id: 'coordination',
        title: 'Coordination findings',
        columns: [
          { key: 'severity', label: 'Severity', width: 1 },
          { key: 'finding', label: 'Finding', width: 7 },
        ],
        rows: findings,
        flags: tcc.issues.map((i) => (i.severity === 'error' ? 'violation' : 'warning')),
        note: findings.length ? undefined : 'No coordination or interrupting-duty problems were found.',
      },
    ],
    figures: plot ? [{ id: 'tcc', title: 'Time-current curves', svg: plot }] : [],
  }
}

function timeSeriesSection(ts: TimeSeriesResult, names: Names, chart?: string): ReportSection {
  const s = ts.summary
  const hour = (h: number) => `hour ${round(h, 2)}`
  const rows = [
    kv('Run', `${ts.mode === 'yearly' ? 'Yearly' : 'Daily'}, ${ts.steps} steps of ${ts.stepMin} min`),
    ...(s
      ? [
          kv('Energy delivered', num(s.energyKwh, 1), 'kWh'),
          kv('Energy lost', num(s.lossesKwh, 1), 'kWh'),
          kv('Losses, share of energy', s.energyKwh > 0 ? num((100 * s.lossesKwh) / s.energyKwh, 2) : null, '%'),
          kv('Peak demand', num(s.peakKw, 1), `kW at ${hour(s.peakHour)}`),
          kv('Lowest voltage', s.minVpu ? num(s.minVpu.value, 4) : null, s.minVpu ? `pu at ${names.bus(s.minVpu.bus)}, ${hour(s.minVpu.hour)}` : 'pu'),
          kv('Highest voltage', s.maxVpu ? num(s.maxVpu.value, 4) : null, s.maxVpu ? `pu at ${names.bus(s.maxVpu.bus)}, ${hour(s.maxVpu.hour)}` : 'pu'),
        ]
      : []),
    kv('Steps that did not converge', ts.nonConvergedSteps.length, ''),
  ]
  const tables: Table[] = [
    { id: 'ts-summary', title: 'Time-series summary', keyValue: true, columns: KV_COLUMNS, rows },
  ]
  // Every step, for the workbook. A downsampled run holds [min, max] pairs.
  const series: Record<string, Cell>[] = []
  if (ts.downsampled) {
    for (let i = 0; i + 1 < ts.time.length; i += 2) {
      series.push({
        from: num(ts.time[i], 3),
        to: num(ts.time[i + 1], 3),
        kwmin: num(ts.totals.kw[i], 1),
        kwmax: num(ts.totals.kw[i + 1], 1),
        lossmin: num(ts.totals.lossKw[i], 2),
        lossmax: num(ts.totals.lossKw[i + 1], 2),
      })
    }
    tables.push({
      id: 'ts-series',
      title: 'Time series (bucketed)',
      workbookOnly: true,
      columns: [
        { key: 'from', label: 'From hour', digits: 3 },
        { key: 'to', label: 'To hour', digits: 3 },
        { key: 'kwmin', label: 'Demand min', unit: 'kW', digits: 1 },
        { key: 'kwmax', label: 'Demand max', unit: 'kW', digits: 1 },
        { key: 'lossmin', label: 'Losses min', unit: 'kW', digits: 2 },
        { key: 'lossmax', label: 'Losses max', unit: 'kW', digits: 2 },
      ],
      rows: series,
      note: 'A long run is recorded as the minimum and maximum over each bucket of steps.',
    })
  } else {
    ts.time.forEach((t, i) =>
      series.push({ hour: num(t, 3), kw: num(ts.totals.kw[i], 1), loss: num(ts.totals.lossKw[i], 2) }),
    )
    tables.push({
      id: 'ts-series',
      title: 'Time series',
      workbookOnly: true,
      columns: [
        { key: 'hour', label: 'Hour', digits: 3 },
        { key: 'kw', label: 'Demand', unit: 'kW', digits: 1 },
        { key: 'loss', label: 'Losses', unit: 'kW', digits: 2 },
      ],
      rows: series,
    })
  }
  return {
    id: 'timeseries',
    title: 'Time series',
    tables,
    figures: chart ? [{ id: 'ts-chart', title: 'Demand and losses', svg: chart }] : [],
  }
}

/** "2026-09-28 feeder-12 report" -> a file name without the characters
 *  Windows refuses. */
export function reportFileName(name: string, ext: 'pdf' | 'xlsx'): string {
  const base = (name || 'circuit').trim().replace(/[\\/:*?"<>|]+/g, '-')
  return `${base}-report.${ext}`
}

/** A column's printed header: the label, and its unit in brackets. */
export function header(c: Column): string {
  return c.unit ? `${c.label} (${c.unit})` : c.label
}

/** A cell as printed. */
export function formatCell(v: Cell, c: Column): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'number') return c.digits != null ? v.toFixed(c.digits) : String(v)
  return v
}
