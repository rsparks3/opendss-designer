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
import { compareResults } from '../compare'
import { HC_LABELS } from '../hostingCapacity'
import { applyScenario, levelNamed } from '../scenarios'
import type {
  BalanceResult,
  BatchCell,
  IslandSummary,
  BatchResult,
  CapacityResult,
  CvrResult,
  HostingCapacityResult,
  LossResult,
  N1Result,
  FuseSavingResult,
  PlacementResult,
  QaResult,
  ReachResult,
  RecloserPlacementResult,
  ScreenResult,
  TlmResult,
  SweepResult,
  TransferResult,
  CircuitJSON,
  FaultResult,
  LimitsJSON,
  ReliabilityResult,
  SolveResult,
  StudyInfoJSON,
  TimeSeriesResult,
} from '../../types/circuit'
import { EMPTY_STUDY, limitsOf } from '../limits'
import { operateSeconds, type TccResult } from '../tcc'
import { traceUnit } from './charts'
import { fromCircuitJSON, type AppEdge, type AppNode } from '../../store/circuitStore'
import {
  buildTopology, firstProtectiveUpstream, PRIORITIES, PRIORITY_LABELS, PROTECTIVE_TYPES, priorityOf, upstreamPaths,
} from '../trace'

export type SectionKey = 'loadflow' | 'diagram' | 'critical' | 'scenarios' | 'outage' | 'shortcircuit' | 'protection' | 'reliability' | 'timeseries' | 'comparison' | 'batch' | 'hosting' | 'screening' | 'studies' | 'history'

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
  reliability?: ReliabilityResult | null
  timeseries?: TimeSeriesResult | null
  /** The pinned baseline solve, for the Comparison section. */
  baseline?: { label: string; result: SolveResult } | null
  /** The last batch run, for the Batch section. */
  batch?: BatchResult | null
  /** The last hosting-capacity run. */
  hosting?: HostingCapacityResult | null
  /** The last interconnection screening. */
  screening?: ScreenResult | null
  /** The M14 planning studies that have been run, by key. */
  studies?: Partial<Record<string, unknown>> | null
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
  critical: 'Critical loads',
  scenarios: 'Scenarios',
  outage: 'Loss of utility',
  shortcircuit: 'Short circuit',
  protection: 'Protection',
  reliability: 'Reliability',
  timeseries: 'Time series',
  comparison: 'Comparison',
  batch: 'Scenarios and load levels',
  hosting: 'Hosting capacity',
  screening: 'Interconnection screening',
  studies: 'Planning studies',
  history: 'Change log',
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
  zone: 'Zone',
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
      out.push(loadSection(solved, names, limits, circuit))
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

  if (sections.has('critical')) {
    out.push(criticalLoadsSection(circuit))
  }
  if (sections.has('outage')) {
    const sec = outageSection(circuit, solved, input.batch ?? null)
    if (sec.tables.length) out.push(sec)
  }
  if (sections.has('scenarios') && circuit.scenarios?.length) {
    out.push(scenariosSection(circuit, input.batch ?? null))
  }

  if (sections.has('shortcircuit') && input.fault?.converged) {
    out.push(faultSection(input.fault, new Names(circuit, input.fault.nodeBuses)))
  }
  if (sections.has('protection') && input.tcc) {
    const prot = protectionSection(input.tcc, names, input.figures?.tcc)
    prot.tables.push(settingsSheet(circuit, names))
    out.push(prot)
  }
  if (sections.has('reliability') && input.reliability?.converged) {
    const rel = reliabilitySection(input.reliability, names)
    const r = input.reliability
    if (r.maifi != null || r.asai != null) {
      rel.tables.splice(1, 0, {
        id: 'reliability-more',
        title: 'Further indices',
        keyValue: true,
        columns: KV_COLUMNS,
        rows: [
          kv('MAIFI (momentary interruptions per customer per year)', r.maifi ?? null),
          kv('ASAI (availability)', r.asai != null ? r.asai * 100 : null, '%'),
          kv('CEMI₁ (customers with more than one interruption a year)', r.cemi ? r.cemi['1'] * 100 : null, '%'),
          kv('CEMI₃', r.cemi ? r.cemi['3'] * 100 : null, '%'),
          kv('CEMI₅', r.cemi ? r.cemi['5'] * 100 : null, '%'),
          kv('ASIFI (load-weighted SAIFI)', r.asifi ?? null),
          kv('Customer interruption cost', r.outageCost ?? null, '$/yr'),
        ],
        note: r.outageCostRates
          ? 'Cost per sustained interruption and per customer-hour by class: ' +
            Object.entries(r.outageCostRates).map(([c, v]) => `${c} $${v.perInterruption} / $${v.perHour}`).join(', ') +
            '. Order-of-magnitude defaults; replace with the utility\'s own.'
          : undefined,
      })
    }
    out.push(rel)
  }
  if (sections.has('timeseries') && input.timeseries) {
    out.push(timeSeriesSection(input.timeseries, names, input.figures?.timeseries))
  }
  if (sections.has('comparison') && input.baseline && solved) {
    out.push(comparisonSection(input.baseline, solved, circuit, names))
  }
  if (sections.has('batch') && input.batch) {
    out.push(batchSection(input.batch, names))
  }
  if (sections.has('hosting') && input.hosting?.converged) {
    out.push(hostingSection(input.hosting, names))
  }
  if (sections.has('screening') && input.screening?.converged) {
    out.push(screeningSection(input.screening))
  }
  if (sections.has('studies') && input.studies) {
    const s = studiesSection(input.studies, names)
    if (s.tables.length) out.push(s)
  }
  if (sections.has('history') && circuit.history?.length) {
    out.push({
      id: 'history',
      title: 'Change log',
      tables: [{
        id: 'history',
        title: 'Parameter changes',
        columns: [
          { key: 'when', label: 'When' }, { key: 'who', label: 'By' }, { key: 'element', label: 'Element' },
          { key: 'param', label: 'Parameter' }, { key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'scenario', label: 'Scenario' },
        ],
        rows: [...circuit.history].reverse().map((h) => ({
          when: new Date(h.t).toLocaleString(), who: h.who || '—', element: names.element(h.id, h.id).name, param: h.param,
          from: h.old == null ? '—' : typeof h.old === 'object' ? JSON.stringify(h.old) : String(h.old),
          to: h.new == null ? '—' : typeof h.new === 'object' ? JSON.stringify(h.new) : String(h.new),
          scenario: h.scenario ? (circuit.scenarios?.find((s) => s.id === h.scenario)?.name ?? h.scenario) : 'base case',
        })),
      }],
      figures: [],
    })
  }
  return { meta, sections: out }
}

function studiesSection(studies: Partial<Record<string, unknown>>, names: Names): ReportSection {
  const tables: Table[] = []
  const n1 = studies.n1 as N1Result | undefined
  if (n1?.converged) {
    tables.push({
      id: 'n1',
      title: 'N-1 contingency',
      columns: [
        { key: 'device', label: 'Lost device' },
        { key: 'kind', label: 'Type' },
        { key: 'dark', label: 'Load left dark', unit: 'kW', digits: 0 },
        { key: 'tie', label: 'Best tie' },
        { key: 'restored', label: 'Restored', unit: 'kW', digits: 0 },
        { key: 'remaining', label: 'Still dark', unit: 'kW', digits: 0 },
        { key: 'minV', label: 'Lowest V', unit: 'pu', digits: 3 },
        { key: 'loading', label: 'Highest loading', unit: '%', digits: 0 },
        { key: 'viol', label: 'New violations' },
      ],
      rows: n1.cases.map((c) => ({
        device: c.element, kind: c.kind, dark: c.unservedKw, tie: c.bestTie?.tieName ?? ((c.unservedKw ?? 0) > 0.5 ? 'none' : null),
        restored: c.bestTie?.restoredKw ?? null, remaining: c.remainingUnservedKw,
        minV: c.bestTie?.minVpu ?? c.noAction?.minVpu ?? null, loading: c.bestTie?.maxLoadingPct ?? c.noAction?.maxLoadingPct ?? null,
        viol: c.bestTie ? c.bestTie.newViolations : c.noAction ? Math.max(0, c.noAction.violations - n1.base.violations) : null,
      })),
      flags: n1.cases.map((c) => ((c.remainingUnservedKw ?? 0) > 0.5 ? 'violation' : null)),
      note: `${n1.summary.evaluated} devices at ${n1.loadLevel.name}; ties: ${n1.ties.map((t) => t.name).join(', ') || 'none'}; base load ${n1.base.totalLoadKw} kW.`,
    })
  }
  const tr = studies.transfer as TransferResult | undefined
  if (tr?.converged) {
    tables.push({
      id: 'transfer', title: `Transfer capability of tie ${tr.tieName}`,
      columns: [
        { key: 'side', label: 'Side isolated at' }, { key: 'load', label: 'Load transferred', unit: 'kW', digits: 0 },
        { key: 'kw', label: 'Can carry', unit: 'kW', digits: 0 }, { key: 'mult', label: '× present', digits: 2 },
        { key: 'minV', label: 'Lowest V', unit: 'pu', digits: 3 }, { key: 'loading', label: 'Highest loading', unit: '%', digits: 0 }, { key: 'note', label: 'Note' },
      ],
      rows: tr.directions.map((d) => ({ side: d.isolatingName ?? d.sideBus, load: d.transferredLoadKw ?? null, kw: d.kw, mult: d.multiplier ?? null, minV: d.minVpu ?? null, loading: d.maxLoadingPct ?? null, note: d.note ?? (d.carriesPresentLoad ? 'carries the present load' : 'cannot carry the present load') })),
    })
  }
  const sw = studies.sweep as SweepResult | undefined
  if (sw?.converged) {
    tables.push({
      id: 'sweep', title: 'Setting sweep',
      columns: [
        { key: 'settings', label: 'Settings' }, { key: 'energy', label: 'Energy', unit: 'kWh', digits: 0 }, { key: 'loss', label: 'Losses', unit: 'kWh', digits: 1 },
        { key: 'minV', label: 'Lowest V', unit: 'pu', digits: 3 }, { key: 'maxV', label: 'Highest V', unit: 'pu', digits: 3 }, { key: 'ops', label: 'Control operations' },
        { key: 'under', label: 'Under V (bus·steps)' }, { key: 'over', label: 'Over V (bus·steps)' }, { key: 'overload', label: 'Overload steps' },
      ],
      rows: sw.rows.map((r) => ({ settings: Object.entries(r.settings).map(([k, v]) => `${k} = ${v}`).join(', '), energy: r.energyKwh, loss: r.lossesKwh, minV: r.minVpu, maxV: r.maxVpu, ops: r.controlOps, under: r.undervoltageBusSteps, over: r.overvoltageBusSteps, overload: r.overloadSteps })),
      flags: sw.rows.map((r) => (r.undervoltageBusSteps + r.overvoltageBusSteps + r.overloadSteps ? 'warning' : null)),
      note: `A day at ${sw.stepMin}-minute steps per row; rows without violations first, then by losses.`,
    })
  }
  const cv = studies.cvr as CvrResult | undefined
  if (cv?.converged) {
    tables.push({
      id: 'cvr', title: 'Conservation voltage reduction', keyValue: true, columns: KV_COLUMNS,
      rows: [
        kv('How', cv.how), kv('Energy, present settings', cv.base.energyKwh, 'kWh/day'), kv('Energy, reduced', cv.reduced.energyKwh, 'kWh/day'),
        kv('Energy saved', cv.energySavedKwh, 'kWh/day'), kv('Energy saved', cv.energySavedPct, '%'), kv('Voltage reduced', cv.voltageReducedPct, '%'),
        kv('CVR factor', cv.cvrFactor), kv('Losses saved', cv.lossesSavedKwh, 'kWh/day'), kv('Lowest customer voltage, reduced', cv.lowestLoadV120, 'V (120 base)'),
        kv('Loads on a voltage-dependent model', cv.cvrLoads),
      ],
    })
  }
  const pl = studies.placement as PlacementResult | undefined
  if (pl?.converged) {
    tables.push({
      id: 'placement', title: `Capacitor placement, ${pl.kvar} kvar banks`,
      columns: [
        { key: 'bank', label: 'Bank' }, { key: 'bus', label: 'Bus' }, { key: 'loss', label: 'Loss reduction', unit: 'kW', digits: 2 },
        { key: 'minV', label: 'Lowest V after', unit: 'pu', digits: 3 }, { key: 'lift', label: 'Voltage lift', unit: 'pu', digits: 4 }, { key: 'maxV', label: 'Highest V after', unit: 'pu', digits: 3 },
      ],
      rows: pl.placed.map((p, i) => ({ bank: i + 1, bus: names.bus(p.bus), loss: p.lossReductionKw, minV: p.minVpu, lift: p.voltageLiftPu, maxV: p.maxVpu })),
      note: `Base losses ${pl.base.lossKw} kW; with the banks ${pl.totalLossReductionKw} kW less. Greedy, one bank at a time, over ${pl.candidates} candidate buses.`,
    })
  }
  const ba = studies.balance as BalanceResult | undefined
  if (ba?.converged) {
    tables.push({
      id: 'balance', title: 'Phase balance',
      columns: [
        { key: 'lateral', label: 'Lateral' }, { key: 'load', label: 'Load', unit: 'kW', digits: 0 }, { key: 'move', label: 'Move' },
        { key: 'after', label: 'Head unbalance after', unit: '%', digits: 1 }, { key: 'impr', label: 'Improvement', unit: 'pts', digits: 1 },
        { key: 'loss', label: 'Loss change', unit: 'kW', digits: 2 }, { key: 'vunb', label: 'Worst voltage unbalance', unit: '%', digits: 2 },
      ],
      rows: ba.candidates.slice(0, 40).map((c) => ({ lateral: c.name, load: c.loadKw, move: `${c.fromPhase} → ${c.toPhase}`, after: c.currentUnbalancePct, impr: c.currentImprovementPct, loss: c.lossChangeKw, vunb: c.voltageUnbalancePct })),
      note: `Base: head currents ${ba.base.headCurrentsA?.map((a) => a.toFixed(0)).join(' / ') ?? '—'} A, current unbalance ${ba.base.currentUnbalancePct ?? '—'} %, worst voltage unbalance ${ba.base.voltageUnbalancePct ?? '—'} % at ${ba.base.voltageUnbalanceBus ?? '—'}.`,
    })
  }
  const lo = studies.losses as LossResult | undefined
  if (lo?.converged) {
    tables.push({
      id: 'losses-eval', title: `Loss evaluation, ${lo.mode === 'daily' ? 'a day' : 'a year'}`,
      columns: [{ key: 'cls', label: 'Element class' }, { key: 'kwh', label: 'Losses', unit: 'kWh', digits: 1 }, { key: 'share', label: 'Share', unit: '%', digits: 1 }, { key: 'cost', label: 'Cost', unit: '$', digits: 0 }],
      rows: lo.byClass.map((r) => ({ cls: r.label, kwh: r.kwh, share: r.share, cost: r.cost })),
      note: `Energy served ${lo.energyKwh} kWh, losses ${lo.lossesKwh} kWh (${lo.lossPct ?? '—'} %); at peak ${lo.peakLossKw} kW of ${lo.peakKw} kW` + (lo.pricePerKwh ? ` at $${lo.pricePerKwh}/kWh, $${lo.costTotal}.` : '.'),
    })
  }
  const qa = studies.qa as QaResult | undefined
  if (qa) {
    tables.push({
      id: 'qa', title: `Model QA: ${qa.score} % complete`,
      columns: [{ key: 'severity', label: 'Severity' }, { key: 'code', label: 'Code' }, { key: 'message', label: 'Finding' }],
      rows: qa.findings.map((f) => ({ severity: f.severity, code: f.code, message: f.message })),
      flags: qa.findings.map((f) => (f.severity === 'warning' ? 'warning' : null)),
      note: qa.completeness.map((c) => `${c.class}: ${c.pct} % of ${c.count}`).join('; '),
    })
  }
  const tlm = studies.tlm as TlmResult | undefined
  if (tlm?.converged) {
    tables.push({
      id: 'tlm', title: `Service transformers, ${tlm.mode === 'daily' ? 'a day' : 'a year'} at ${tlm.ambientC} °C`,
      columns: [
        { key: 'name', label: 'Transformer' }, { key: 'kva', label: 'kVA', digits: 0 }, { key: 'peak', label: 'Peak', unit: '%', digits: 0 },
        { key: 'h100', label: 'Hours over 100 %', digits: 1 }, { key: 'h150', label: 'Hours over 150 %', digits: 1 },
        { key: 'hot', label: 'Hottest spot', unit: '°C', digits: 0 }, { key: 'aging', label: 'Aging factor', digits: 2 }, { key: 'lol', label: 'Loss of life', unit: '%/yr', digits: 3 },
      ],
      rows: tlm.transformers.map((t) => ({ name: t.name, kva: t.kva, peak: t.peakPct, h100: t.hoursOver100, h150: t.hoursOver150, hot: t.maxHotSpotC, aging: t.equivalentAging, lol: t.lossOfLifePctPerYear })),
      flags: tlm.transformers.map((t) => (t.flag === 'overloaded' ? 'violation' : t.flag === 'aging' ? 'warning' : null)),
    })
    if (tlm.services.length) {
      tables.push({
        id: 'secondary-voltage', title: 'Voltage at the meter',
        columns: [{ key: 'name', label: 'Load' }, { key: 'min', label: 'Lowest', unit: 'V (120 base)', digits: 1 }, { key: 'hour', label: 'at hour', digits: 2 }, { key: 'max', label: 'Highest', unit: 'V', digits: 1 }],
        rows: tlm.services.map((s) => ({ name: s.name, min: s.minV120, hour: s.minHour, max: s.maxV120 })),
        flags: tlm.services.map((s) => (s.flag ? 'violation' : null)),
        note: 'ANSI C84.1 Range A at the meter is 114 to 126 V.',
      })
    }
  }
  const reach = studies.reach as ReachResult | undefined
  if (reach?.converged) {
    tables.push({
      id: 'reach', title: `Reach (minimum faults through ${reach.rOhm} Ω)`,
      columns: [
        { key: 'device', label: 'Device' }, { key: 'pickup', label: 'Pickup', unit: 'A', digits: 0 },
        { key: 'min', label: 'Minimum fault at end of zone', unit: 'A', digits: 0 }, { key: 'kind', label: 'Kind' },
        { key: 'der', label: 'DER infeed', unit: 'A', digits: 0 }, { key: 'seen', label: 'Seen by device', unit: 'A', digits: 0 },
        { key: 'ratio', label: 'Reach ratio', digits: 2 }, { key: 'ground', label: 'Ground ratio', digits: 2 },
      ],
      rows: reach.devices.map((d) => ({ device: d.name, pickup: d.phasePickupA, min: d.minFaultA, kind: d.minFaultKind === 'lg' ? 'line-to-ground' : d.minFaultKind === 'll' ? 'line-to-line' : null, der: d.derInfeedA, seen: d.seenByDeviceA, ratio: d.reachRatio, ground: d.groundReachRatio })),
      flags: reach.devices.map((d) => (d.ok ? null : 'violation')),
      note: `A device should see at least ${reach.margin} × its pickup at the end of its zone.`,
    })
  }
  const fs = studies.fusesaving as FuseSavingResult | undefined
  if (fs?.converged && fs.pairs.length) {
    tables.push({
      id: 'fuse-saving', title: 'Recloser–fuse coordination',
      columns: [
        { key: 'recloser', label: 'Recloser' }, { key: 'fuse', label: 'Fuse' }, { key: 'imax', label: 'Max fault at fuse', unit: 'A', digits: 0 },
        { key: 'fast', label: 'Fast operates', unit: 's', digits: 3 }, { key: 'melt', label: 'Fuse melts', unit: 's', digits: 3 }, { key: 'saving', label: 'Fuse saving' },
        { key: 'imin', label: 'Min fault in zone', unit: 'A', digits: 0 }, { key: 'clear', label: 'Fuse clears', unit: 's', digits: 3 }, { key: 'delayed', label: 'Delayed operates', unit: 's', digits: 3 }, { key: 'blowing', label: 'Fuse blowing' },
      ],
      rows: fs.pairs.map((p) => ({ recloser: p.recloser, fuse: p.fuse, imax: p.maxFaultA, fast: p.recloserFastS, melt: p.fuseMeltS, saving: p.fuseSaving ? 'yes' : 'no', imin: p.minFaultA, clear: p.fuseClearS, delayed: p.recloserDelayedS, blowing: p.fuseBlowing ? 'yes' : 'no' })),
      flags: fs.pairs.map((p) => (p.fuseSaving && p.fuseBlowing ? null : 'warning')),
      note: `Total clearing time from the fuse's own total-clear curve where given, else melting time × ${fs.clearOverMelt}.`,
    })
  }
  const rp = studies.recplacement as RecloserPlacementResult | undefined
  if (rp?.converged) {
    tables.push({
      id: 'recloser-placement', title: 'Recloser placement',
      columns: [{ key: 'line', label: 'Line' }, { key: 'km', label: 'Length', unit: 'km', digits: 2 }, { key: 'saifi', label: 'SAIFI', digits: 3 }, { key: 'saidi', label: 'SAIDI', unit: 'h', digits: 3 }, { key: 'd', label: 'Change in SAIDI', unit: 'h', digits: 3 }, { key: 'saved', label: 'Customer-hours saved', digits: 1 }],
      rows: rp.candidates.slice(0, 25).map((c) => ({ line: c.name, km: c.lengthKm, saifi: c.saifi, saidi: c.saidi, d: c.saidiChange, saved: c.custHoursSaved })),
      note: `Today SAIFI ${rp.base.saifi}, SAIDI ${rp.base.saidi} h; a recloser mid-way on each line in turn.`,
    })
  }
  const ca = studies.capacity as CapacityResult | undefined
  if (ca?.converged) {
    tables.push({
      id: 'capacity', title: 'Feeder capacity', keyValue: true, columns: KV_COLUMNS,
      rows: [
        kv('Load level', `${ca.loadLevel.name} (×${ca.baseMult})`), kv('Present load', ca.base.sourceKw, 'kW'),
        kv('Capacity', ca.capacityKw, 'kW'), kv('Capacity multiplier', ca.capacityMult), kv('Headroom', ca.headroomKw, 'kW'),
        kv('Binds on', ca.binding === 'voltage' ? `undervoltage at ${ca.atLimit.minVBus ?? '—'}` : ca.binding === 'thermal' ? `overload of ${ca.atLimit.maxLoadingElement ?? '—'}` : ca.binding),
        kv('At the limit', `lowest V ${ca.atLimit.minVpu ?? '—'} pu, highest loading ${ca.atLimit.maxLoadingPct} %`),
      ],
    })
  }
  return { id: 'studies', title: 'Planning studies', tables, figures: [] }
}

export const ISOCHRONOUS_NOTE =
  'Generators in isochronous mode are modelled as voltage sources at their terminals: held at 1.0 pu by their ' +
  'voltage regulators in the power flow, and behind their subtransient reactance (Xd\u2032\u2032, 0.15 pu ' +
  'unless entered) in fault studies. The model does not limit a machine to its rating, share load by droop, or ' +
  'represent governor or fuel limits: a loading over 100 % means the island cannot be carried as configured. ' +
  'Screening grade, not a dynamic or stability study.'

/** Loss of utility: for every case whose islands a generator carries or
 *  that leaves load dark -- each scenario of the last batch, or this solve
 *  when there is no batch -- the islands and the unserved load. */
export function outageSection(circuit: CircuitJSON, solve: SolveResult | null, batch: BatchResult | null): ReportSection {
  const cases: { label: string; islands: IslandSummary }[] = []
  const relevant = (isl: IslandSummary | null | undefined) =>
    !!isl && (isl.islands.some((i) => i.sources.some((s) => s.kind === 'generator')) ||
      PRIORITIES.some((p) => isl.unservedKw[p] > 0))
  if (batch) {
    const level = batch.levels[0] ?? null
    for (const c of batch.cells) {
      if (c.level === level && relevant(c.detail?.islands)) cases.push({ label: c.scenarioName, islands: c.detail!.islands! })
    }
  } else if (solve && relevant(solve.islands)) {
    cases.push({ label: scenarioLabel(circuit, solve), islands: solve.islands! })
  }
  const tables: Table[] = []
  for (const { label, islands } of cases) {
    const rows = islands.islands.map((i) => ({
      island: i.energized ? i.sources.map((s) => s.name).join(' + ') : 'De-energised',
      served: i.energized ? i.servedKw : null,
      rating: i.sources.reduce((s, x) => s + (x.ratingKva ?? 0), 0) || null,
      loading: i.sources.length === 1 ? i.sources[0].loadingPct : null,
      fuel: i.sources.find((s) => s.fuelHours)?.fuelHours ?? null,
      vmin: i.vminPu,
      vmax: i.vmaxPu,
      critical: i.unservedKw.critical || null,
      unserved: PRIORITIES.reduce((s, p) => s + i.unservedKw[p], 0) || null,
    }))
    tables.push({
      id: `outage-islands-${tables.length}`,
      title: `${label}: islands`,
      columns: [
        { key: 'island', label: 'Carried by' },
        { key: 'served', label: 'Served', unit: 'kW', digits: 0 },
        { key: 'rating', label: 'Rating', unit: 'kVA', digits: 0 },
        { key: 'loading', label: 'Loading', unit: '%', digits: 0 },
        { key: 'fuel', label: 'Fuel', unit: 'h', digits: 0 },
        { key: 'vmin', label: 'V min', unit: 'pu', digits: 3 },
        { key: 'vmax', label: 'V max', unit: 'pu', digits: 3 },
        { key: 'critical', label: 'Critical unserved', unit: 'kW', digits: 0 },
        { key: 'unserved', label: 'All unserved', unit: 'kW', digits: 0 },
      ],
      rows,
      flags: islands.islands.map((i) => (i.alarm ? 'violation' : !i.energized ? 'warning' : null)),
      note: islands.islands.some((i) => i.multipleSources)
        ? 'An island held by more than one source: how they share it is not modelled (indicative only).'
        : undefined,
    })
    if (islands.unservedLoads.length) {
      tables.push({
        id: `outage-unserved-${tables.length}`,
        title: `${label}: unserved loads`,
        columns: [
          { key: 'name', label: 'Load' },
          { key: 'building', label: 'Building' },
          { key: 'priority', label: 'Priority' },
          { key: 'kw', label: 'Load', unit: 'kW', digits: 0 },
        ],
        rows: islands.unservedLoads.map((l) => ({
          name: l.name, building: l.building || '—',
          priority: PRIORITY_LABELS[(l.priority as (typeof PRIORITIES)[number])] ?? l.priority, kw: l.kw,
        })),
        flags: islands.unservedLoads.map((l) => (l.priority === 'critical' ? 'violation' : null)),
      })
    }
  }
  if (tables.length) tables[tables.length - 1].note = [tables[tables.length - 1].note, ISOCHRONOUS_NOTE].filter(Boolean).join(' ')
  return { id: 'outage', title: 'Loss of utility', tables, figures: [] }
}

/** A parameter change in words: "opened", "taken out of service", or
 *  "kw 900 → 1200". */
export function changeInWords(key: string, before: unknown, after: unknown): string {
  const show = (v: unknown) => (v == null || v === '' ? '(blank)' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  if (key === 'closed') return after === false ? 'opened' : 'closed'
  if (key === 'enabled') return after === false ? 'taken out of service' : 'returned to service'
  if (key === 'islandMode') return after === 'isochronous' ? 'set to isochronous (carries an island)' : 'set to grid-following'
  return `${key} ${show(before)} → ${show(after)}`
}

/** Every scenario with what it changes, in words, and -- when a batch has
 *  been run -- the load each leaves unserved, by priority. */
export function scenariosSection(circuit: CircuitJSON, batch: BatchResult | null): ReportSection {
  const nodes = new Map(circuit.nodes.map((n) => [n.id, n]))
  const edges = new Map(circuit.edges.map((e) => [e.id, e]))
  const label = (id: string) => {
    const n = nodes.get(id)
    const e = n ? undefined : edges.get(id)
    const type = n ? TYPE_NAMES[n.type] ?? n.type : e?.type === 'line' ? 'Line' : 'Wire'
    const name = (n?.params.name ?? e?.params.name ?? id) as string
    return `${type} ${name}`
  }
  const rows: Record<string, Cell>[] = []
  for (const sc of circuit.scenarios ?? []) {
    const changes: string[] = []
    for (const [id, patch] of Object.entries(sc.overrides)) {
      const before = nodes.get(id)?.params ?? edges.get(id)?.params ?? {}
      const words = Object.entries(patch).map(([k, v]) => changeInWords(k, before[k], v))
      changes.push(`${label(id)}: ${words.join('; ')}`)
    }
    for (const n of sc.addedNodes) changes.push(`${TYPE_NAMES[n.type] ?? n.type} ${String(n.params.name ?? n.id)} added`)
    for (const e of sc.addedEdges) if (e.type === 'line') changes.push(`Line ${String(e.params.name ?? e.id)} added`)
    for (const id of sc.removed) if (nodes.has(id) || edges.get(id)?.type === 'line') changes.push(`${label(id)} removed`)
    if (!changes.length) changes.push('(no changes from the base case)')
    changes.forEach((text, i) => rows.push({
      scenario: i === 0 ? sc.name : '',
      description: i === 0 ? sc.description || '' : '',
      change: text,
    }))
  }
  const tables: Table[] = [{
    id: 'scenario-definitions',
    title: 'Scenario definitions',
    columns: [
      { key: 'scenario', label: 'Scenario' },
      { key: 'description', label: 'Description' },
      { key: 'change', label: 'Change from the base case', width: 3 },
    ],
    rows,
  }]
  if (batch) {
    const level = batch.levels[0] ?? null
    const cells = batch.scenarios
      .map((sc) => batch.cells.find((c) => c.scenario === sc.id && c.level === level))
      .filter((c): c is BatchCell => !!c)
    tables.push({
      id: 'scenario-compare',
      title: `Scenario comparison${cells[0] ? ` at ${cells[0].levelName}` : ''}`,
      columns: [
        { key: 'scenario', label: 'Scenario' },
        { key: 'critical', label: 'Unserved critical', unit: 'kW', digits: 0 },
        { key: 'essential', label: 'Unserved essential', unit: 'kW', digits: 0 },
        { key: 'other', label: 'Other unserved', unit: 'kW', digits: 0 },
        { key: 'minv', label: 'Lowest voltage', unit: 'pu', digits: 3 },
        { key: 'load', label: 'Highest loading', unit: '%', digits: 0 },
        { key: 'losses', label: 'Losses', unit: 'kW', digits: 1 },
      ],
      rows: cells.map((c) => ({
        scenario: c.scenarioName,
        critical: c.detail?.unservedKw.critical ?? null,
        essential: c.detail?.unservedKw.essential ?? null,
        other: c.detail ? c.detail.unservedKw.nonessential + c.detail.unservedKw.unassigned : null,
        minv: c.minVpu,
        load: c.maxLoadingPct,
        losses: c.lossKw,
      })),
      flags: cells.map((c) => (!c.converged || (c.detail?.unservedKw.critical ?? 0) > 0 ? 'violation'
        : (c.detail?.unservedKw.essential ?? 0) > 0 ? 'warning' : null)),
      note: 'From the last batch run (Scenarios tab → Run all). Unserved load is the load on buses the solve left de-energised.',
    })
  }
  return { id: 'scenarios', title: 'Scenarios', tables, figures: [] }
}

/** The drawing a section should read: the base with the open scenario
 *  applied, as the solve sees it. */
export function effectiveDrawing(circuit: CircuitJSON): { nodes: AppNode[]; edges: AppEdge[] } {
  const base = fromCircuitJSON(circuit)
  const sc = circuit.activeScenario ? circuit.scenarios?.find((x) => x.id === circuit.activeScenario) : undefined
  if (!sc) return base
  return applyScenario(base, sc, (nodes, edges) =>
    fromCircuitJSON({ version: circuit.version, name: '', nodes, edges, busNames: {}, loadShapes: {} }))
}

/** Every critical and essential load with what feeds it: the source, the
 *  feeder (the last protective device leaving a switchgear bus on the way
 *  down -- the feeder breaker, not the main or a bus tie above it), the
 *  transformer nearest the load, and the first
 *  protective device that would clear a fault at it. From the drawing; no
 *  solve. */
export function criticalLoadsSection(circuit: CircuitJSON): ReportSection {
  const { nodes, edges } = effectiveDrawing(circuit)
  const topo = buildTopology(nodes, edges)
  const nameOf = (id: string | null | undefined) => {
    if (!id) return '—'
    const n = topo.nodes.get(id)
    const p = n ? n.data.params : topo.edges.find((e) => e.id === id)?.data?.params
    return String(p?.name || id)
  }
  const typeOf = (id: string) => topo.nodes.get(id)?.type ?? (topo.series.has(id) ? 'line' : '')
  const rows: Record<string, Cell>[] = []
  const wanted = [...topo.nodes.values()].filter(
    (n) => n.type === 'load' && ['critical', 'essential'].includes(priorityOf(n.data.params)),
  )
  wanted.sort((a, b) =>
    PRIORITIES.indexOf(priorityOf(a.data.params)) - PRIORITIES.indexOf(priorityOf(b.data.params)) ||
    String(a.data.params.name ?? '').localeCompare(String(b.data.params.name ?? '')))
  let dark = 0
  for (const n of wanted) {
    const p = n.data.params
    const [path] = upstreamPaths(topo, n.id)
    let feeder: string | null = null
    let transformer: string | null = null
    if (path) {
      // The feeder: the last protective device leaving a switchgear bus (a
      // bus with three or more protective devices on it) on the way down;
      // failing that, the first line after a bus that branches.
      const devicesAt = (bus: string) =>
        (topo.links.get(bus) ?? []).filter(([, el]) => PROTECTIVE_TYPES.has(typeOf(el))).length
      for (let i = 0; i < path.elements.length; i++) {
        if (PROTECTIVE_TYPES.has(typeOf(path.elements[i])) && devicesAt(path.buses[i]) >= 3) feeder = path.elements[i]
      }
      for (let i = 0; i < path.elements.length && !feeder; i++) {
        if ((topo.links.get(path.buses[i]) ?? []).length >= 3 && typeOf(path.elements[i]) === 'line') feeder = path.elements[i]
      }
      for (const el of path.elements) if (typeOf(el) === 'transformer') transformer = el
    } else {
      dark++
    }
    rows.push({
      load: nameOf(n.id),
      building: String(p.building ?? '') || '—',
      priority: PRIORITY_LABELS[priorityOf(p)],
      kw: Number(p.kw) || 0,
      source: path ? nameOf(path.sourceId) : 'none (de-energised)',
      feeder: nameOf(feeder),
      transformer: nameOf(transformer),
      device: nameOf(firstProtectiveUpstream(topo, n.id)),
    })
  }
  const sc = circuit.activeScenario ? circuit.scenarios?.find((x) => x.id === circuit.activeScenario) : undefined
  const notes = [
    'Priorities as entered on each load. Source and feeder are traced on the drawing (open switches and elements out of service break a path); the feeder is the last protective device leaving a switchgear bus (three or more devices) on the way to the load.',
    sc ? `As configured in scenario "${sc.name}".` : '',
    dark ? `${dark} of them have no path to any source as drawn.` : '',
  ].filter(Boolean)
  return {
    id: 'critical',
    title: 'Critical loads',
    tables: [{
      id: 'critical-loads',
      title: 'Critical and essential loads',
      columns: [
        { key: 'load', label: 'Load' },
        { key: 'building', label: 'Building' },
        { key: 'priority', label: 'Priority' },
        { key: 'kw', label: 'Load', unit: 'kW', digits: 0 },
        { key: 'source', label: 'Source' },
        { key: 'feeder', label: 'Feeder' },
        { key: 'transformer', label: 'Transformer' },
        { key: 'device', label: 'First protective device' },
      ],
      rows,
      flags: rows.map((r) => (String(r.source).startsWith('none') ? 'violation' : null)),
      note: rows.length ? notes.join(' ') : 'No load is marked critical or essential (set Priority on the loads).',
    }],
    figures: [],
  }
}

function screeningSection(s: ScreenResult): ReportSection {
  const setup: Table = {
    id: 'screening-setup',
    title: 'Interconnection screening',
    keyValue: true,
    columns: KV_COLUMNS,
    rows: [
      kv('Point of common coupling', `${s.busName} (${s.kvBase} kV, ${s.phases}-phase)`),
      kv('Unit', `${s.unit.kw} kW, pf ${s.unit.pf}, ${s.unit.kva} kVA ${s.unit.derType}${s.unit.export ? ', exporting' : ', non-export'}`),
      kv('Line section', `${s.section.peakLoadKw} kW peak load, ${s.section.minLoadKw} kW minimum (×${s.section.minLoadMult}), ${s.section.existingDerKw} kW DER already connected`),
      kv('Load level', `${s.loadLevel.name} (×${s.loadLevel.loadmult})`),
      kv('Outcome', s.outcome === 'pass' ? 'Passes the screens' : s.outcome === 'supplemental' ? 'Needs supplemental review' : `Fails: ${s.failed.join(', ')}`),
    ],
  }
  const table: Table = {
    id: 'screening-rows',
    title: 'Screens',
    columns: [
      { key: 'screen', label: 'Screen' },
      { key: 'value', label: 'Value' },
      { key: 'limit', label: 'Limit' },
      { key: 'result', label: 'Result' },
      { key: 'note', label: 'Note' },
    ],
    rows: s.screens.map((r) => ({
      screen: r.label,
      value: r.value == null ? null : `${r.value} ${r.unit}`.trim(),
      limit: r.limit == null ? null : `${r.limit} ${r.unit}`.trim(),
      result: r.pass === null ? '—' : r.pass ? 'pass' : 'fail',
      note: r.note,
    })),
    flags: s.screens.map((r) => (r.pass === false ? 'violation' : null)),
    note: 'Fault-current and interrupting screens use the unit\'s contribution (1.2 × rated for an inverter, 5 × for a synchronous machine) against a base fault study; rapid voltage change is the difference between solves with and without the unit.',
  }
  return { id: 'screening', title: 'Interconnection screening', tables: [setup, table], figures: [] }
}

function hostingSection(h: HostingCapacityResult, names: Names): ReportSection {
  const crit = Object.entries(h.criteria).filter(([, on]) => on).map(([k]) => k)
  const setup: Table = {
    id: 'hosting-setup',
    title: 'Hosting capacity',
    keyValue: true,
    columns: KV_COLUMNS,
    rows: [
      kv('Kind', h.kind === 'der' ? 'DER (generation)' : 'Load'),
      kv('Method', h.method === 'sensitivity' ? 'Sensitivity (one probe per bus, confirmed)' : 'Iterative (bisection at every bus)'),
      kv('Load level', `${h.loadLevel.name} (×${h.loadLevel.loadmult}${h.loadLevel.rating === 'emergency' ? ', emergency ratings' : ''})`),
      kv('Criteria', crit.map((k) => HC_LABELS[k] ?? k).join(', ')),
      kv('Limits', [
        `voltage change on trip ${h.options.deviationPct} %`, `thermal ${h.options.thermalPct} %`,
        `export ${h.options.substationExportKw} kW`, `fault increase ${h.options.faultIncreasePct} %`,
        `interrupting ${h.options.interruptingPct} %`, `islanding ratio ${h.options.islandingRatio}`,
      ].join('; ')),
      kv('Unit', h.kind === 'der' ? `${h.options.derType} at pf ${h.options.pf}` : `load at pf ${h.options.loadPf}`),
      ...(h.hours.length ? [kv('Hours', h.hours.join(', '))] : []),
      kv('Buses evaluated', h.summary.evaluated),
      kv('Capacity', h.summary.minKw == null ? '—' : `${h.summary.minKw} to ${h.summary.maxKw} kW, median ${h.summary.medianKw}`),
      kv('Binding criteria', Object.entries(h.summary.bindingCounts).map(([k, n]) => `${HC_LABELS[k] ?? k} ×${n}`).join(', ')),
      kv('Solves', `${h.summary.solves} in ${h.summary.seconds} s`),
    ],
    note: Object.values(h.exclusions).some((l) => l.length)
      ? 'Excluded as already over a limit in the base case: ' + Object.entries(h.exclusions).filter(([, l]) => l.length).map(([k, l]) => `${k} (${l.join(', ')})`).join('; ')
      : undefined,
  }
  const table: Table = {
    id: 'hosting-buses',
    title: 'Capacity by bus',
    columns: [
      { key: 'bus', label: 'Bus' },
      { key: 'kv', label: 'kV', digits: 2 },
      { key: 'kw', label: 'Capacity', unit: 'kW', digits: 0 },
      { key: 'binding', label: 'Binds on' },
      ...crit.map((k) => ({ key: `c_${k}`, label: HC_LABELS[k] ?? k, unit: 'kW', digits: 0 })),
      ...h.hours.map((hr) => ({ key: `h_${hr}`, label: `h ${hr}`, unit: 'kW', digits: 0 })),
      { key: 'section', label: 'Section load', unit: 'kW', digits: 0 },
    ],
    rows: Object.entries(h.buses)
      .sort((a, b) => a[1].kw - b[1].kw)
      .map(([bus, r]) => ({
        bus: names.bus(bus),
        kv: r.kvBase,
        kw: r.kw,
        binding: (HC_LABELS[r.binding ?? ''] ?? r.binding ?? '—') + (r.capped ? ' (cap reached)' : ''),
        ...Object.fromEntries(crit.map((k) => [`c_${k}`, r.byCriterion[k] ?? null])),
        ...Object.fromEntries(h.hours.map((hr) => [`h_${hr}`, r.kwByHour?.[String(hr)] ?? null])),
        section: r.sectionLoadKw || null,
      })),
    note: 'Per-criterion columns are the sensitivity method\'s estimates of the capacity each criterion alone would allow.',
  }
  return { id: 'hosting', title: 'Hosting capacity', tables: [setup, table], figures: [] }
}

function levelLabel(circuit: CircuitJSON, solve: SolveResult | null): string {
  const lvl = solve?.loadLevel ?? levelNamed(circuit.loadLevels ?? null, circuit.activeLevel ?? null)
  const rating = lvl.rating === 'emergency' ? ', emergency ratings' : ''
  return lvl.name === 'Rated' && lvl.loadmult === 1 ? 'Rated (every load at its kW)' : `${lvl.name} (×${lvl.loadmult}${rating})`
}

function scenarioLabel(circuit: CircuitJSON, solve: SolveResult | null): string {
  const id = solve?.scenario ?? circuit.activeScenario ?? null
  if (!id) return 'Base case'
  return circuit.scenarios?.find((sc) => sc.id === id)?.name ?? id
}

function comparisonSection(
  baseline: { label: string; result: SolveResult },
  solve: SolveResult,
  circuit: CircuitJSON,
  names: Names,
): ReportSection {
  const cmp = compareResults(baseline.result, solve)
  const d = (v: number | null) => (v == null ? null : v)
  const summary: Table = {
    id: 'comparison-summary',
    title: 'Comparison',
    keyValue: true,
    columns: KV_COLUMNS,
    rows: [
      kv('Baseline', baseline.label),
      kv('This solve', `${scenarioLabel(circuit, solve)} at ${levelLabel(circuit, solve)}`),
      kv('Change in losses', d(cmp.lossKw), 'kW'),
      kv('Change in lowest voltage', d(cmp.minV), 'pu'),
      kv('Change in highest loading', d(cmp.maxLoading), '%'),
      kv('Violations before → after', `${cmp.violationsBefore} → ${cmp.violationsAfter}`),
    ],
  }
  const buses: Table = {
    id: 'comparison-buses',
    title: 'Bus voltages that changed',
    columns: [
      { key: 'bus', label: 'Bus' },
      { key: 'before', label: 'Before', unit: 'pu', digits: 4 },
      { key: 'after', label: 'After', unit: 'pu', digits: 4 },
      { key: 'delta', label: 'Change', unit: 'pu', digits: 4 },
      { key: 'status', label: 'Status' },
    ],
    rows: cmp.buses.filter((r) => r.changed).map((r) => ({
      bus: names.bus(r.key.slice(4)), before: r.before, after: r.after, delta: r.delta, status: r.status,
    })),
    flags: cmp.buses.filter((r) => r.changed).map((r) => r.flag),
    note: 'Lowest phase voltage at each bus; buses within 0.0005 pu of the baseline are left out.',
  }
  const elements: Table = {
    id: 'comparison-elements',
    title: 'Element loading that changed',
    columns: [
      { key: 'element', label: 'Element' },
      { key: 'before', label: 'Before', unit: '%', digits: 1 },
      { key: 'after', label: 'After', unit: '%', digits: 1 },
      { key: 'delta', label: 'Change', unit: '%', digits: 1 },
      { key: 'kw', label: 'Change in kW', unit: 'kW', digits: 1 },
      { key: 'loss', label: 'Change in losses', unit: 'kW', digits: 2 },
    ],
    rows: cmp.elements.filter((r) => r.changed).map((r) => ({
      element: r.id ? names.element(r.id, r.label).name : r.label,
      before: r.before, after: r.after, delta: r.delta, kw: r.deltaKw ?? null, loss: r.deltaLossKw ?? null,
    })),
    flags: cmp.elements.filter((r) => r.changed).map((r) => r.flag),
  }
  return { id: 'comparison', title: 'Comparison', tables: [summary, buses, elements], figures: [] }
}

function batchSection(batch: BatchResult, names: Names): ReportSection {
  const table: Table = {
    id: 'batch-matrix',
    title: 'Every scenario at every load level',
    columns: [
      { key: 'scenario', label: 'Case' },
      { key: 'level', label: 'Load level' },
      { key: 'mult', label: 'Multiplier', digits: 2 },
      { key: 'rating', label: 'Rating' },
      { key: 'kw', label: 'Source', unit: 'kW', digits: 0 },
      { key: 'minV', label: 'Lowest V', unit: 'pu', digits: 3 },
      { key: 'minVBus', label: 'at bus' },
      { key: 'maxV', label: 'Highest V', unit: 'pu', digits: 3 },
      { key: 'loading', label: 'Highest loading', unit: '%', digits: 0 },
      { key: 'element', label: 'element' },
      { key: 'loss', label: 'Losses', unit: 'kW', digits: 1 },
      { key: 'under', label: 'Under V' },
      { key: 'over', label: 'Over V' },
      { key: 'overloads', label: 'Overloads' },
    ],
    rows: batch.cells.map((c) => ({
      scenario: c.scenarioName,
      level: c.levelName,
      mult: c.loadmult,
      rating: c.rating,
      kw: c.converged ? c.sourceKw : null,
      minV: c.minVpu,
      minVBus: c.minVBus ? names.bus(c.minVBus) : null,
      maxV: c.maxVpu,
      loading: c.maxLoadingPct,
      element: c.maxLoadingId ? names.element(c.maxLoadingId, c.maxLoadingElement ?? '').name : (c.maxLoadingElement ?? null),
      loss: c.lossKw,
      under: c.undervoltages,
      over: c.overvoltages,
      overloads: c.converged ? c.overloads : `did not converge`,
    })),
    flags: batch.cells.map((c) => (!c.converged || c.undervoltages + c.overvoltages + c.overloads ? 'violation' : c.loadingWarnings ? 'warning' : null)),
    note: batch.cancelled ? 'The run was cancelled part way; the cells listed are the ones solved.' : undefined,
  }
  return { id: 'batch', title: 'Scenarios and load levels', tables: [table], figures: [] }
}

// --- sections -------------------------------------------------------------

function studySection(meta: ReportMeta, circuit: CircuitJSON, solve: SolveResult | null): ReportSection {
  const s = meta.study
  const counts = new Map<string, number>()
  for (const n of circuit.nodes) {
    if (n.type === 'note' || n.type === 'zone') continue
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
    kv('Load level', levelLabel(circuit, solve)),
    kv('Scenario', scenarioLabel(circuit, solve)),
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
          ? 'Lines, transformers and switches are judged by current against their ampere rating; ' +
            'generators, PV and storage by apparent power against their kVA rating; a capacitor ' +
            'against the 135 % of rated current it may carry continuously (IEEE 18).'
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

function loadSection(solve: SolveResult, names: Names, limits: LimitsJSON, circuit: CircuitJSON): ReportSection {
  const loads: Record<string, Cell>[] = []
  const gens: Record<string, Cell>[] = []
  const genFlags: RowFlag[] = []
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
        cls: String((circuit.nodes.find((n) => n.id === e.id)?.params.class as string | undefined) ?? '—'),
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
        rating: e.ratingKva != null ? num(e.ratingKva, 0) : e.normAmps != null ? num(e.normAmps, 0) : null,
        ratingUnit: e.ratingKva != null ? 'kVA' : e.normAmps != null ? 'A' : '',
        loading: num(e.loadingPct, 1),
        v: num(vbus, 4),
      })
      genFlags.push(loadingFlag(e.loadingPct, limits))
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
        { key: 'cls', label: 'Class' },
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
        { key: 'rating', label: 'Rating', digits: 0 },
        { key: 'ratingUnit', label: 'Unit', width: 0.7 },
        { key: 'loading', label: 'Loading', unit: '%', digits: 1 },
        { key: 'v', label: 'V min at bus', unit: 'pu', digits: 4 },
      ],
      rows: gens,
      flags: genFlags,
      note:
        "Output is positive delivered into the network; storage reads negative while charging. " +
        "Loading is apparent power against the kVA rating; a capacitor's is current against the 135 % of rated it may carry continuously.",
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

/** Every protective device's settings as a relay technician reads them. */
function settingsSheet(circuit: CircuitJSON, names: Names): Table {
  const rows: Record<string, Cell>[] = []
  for (const n of circuit.nodes) {
    if (!['fuse', 'recloser', 'relay', 'breaker'].includes(n.type)) continue
    const p = n.params
    const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : p[k] != null && p[k] !== '' && Number.isFinite(Number(p[k])) ? Number(p[k]) : null)
    const cont = num('normamps')
    const pickup = n.type === 'fuse' ? num('ratedcurrent') : num('phasetrip')
    rows.push({
      device: names.element(n.id, String(p.name ?? n.id)).name,
      type: p.sectionalizer === true ? 'sectionalizer' : n.type,
      pickup,
      multiple: pickup != null && cont ? pickup / cont : null,
      ground: n.type === 'fuse' ? null : num('groundtrip'),
      curves: [p.fusecurve, p.clearcurve && `clear ${p.clearcurve}`, p.phasefast && `fast ${p.phasefast}`, p.phasedelayed && `delayed ${p.phasedelayed}`, p.phasecurve, p.groundcurve && p.groundcurve !== 'none' && `ground ${p.groundcurve}`]
        .filter(Boolean)
        .join(', ') || '—',
      delay: num('delay'),
      shots: n.type === 'recloser' ? `${num('numfast') ?? 1} fast of ${num('shots') ?? 4}` : null,
      intervals: n.type === 'recloser' ? (Array.isArray(p.recloseintervals) ? (p.recloseintervals as number[]).join(', ') : (p.recloseintervals as string | undefined) ?? null) : null,
      interrupting: num('interruptingka'),
    })
  }
  return {
    id: 'settings-sheet',
    title: 'Settings sheet',
    columns: [
      { key: 'device', label: 'Device' },
      { key: 'type', label: 'Type' },
      { key: 'pickup', label: 'Pickup', unit: 'A', digits: 0 },
      { key: 'multiple', label: '× continuous', digits: 2 },
      { key: 'ground', label: 'Ground pickup', unit: 'A', digits: 0 },
      { key: 'curves', label: 'Curves' },
      { key: 'delay', label: 'Time dial / delay', unit: 's', digits: 2 },
      { key: 'shots', label: 'Operations' },
      { key: 'intervals', label: 'Reclose intervals', unit: 's' },
      { key: 'interrupting', label: 'Interrupting', unit: 'kA', digits: 1 },
    ],
    rows,
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

function reliabilitySection(rel: ReliabilityResult, names: Names): ReportSection {
  const device = (headId: string | null, head: string) => names.element(headId ?? head, head)
  const indices: Table = {
    id: 'reliability-indices',
    title: 'Reliability indices',
    keyValue: true,
    columns: KV_COLUMNS,
    rows: [
      kv('SAIFI', num(rel.saifi, 4), 'interruptions per customer per year'),
      kv('SAIDI', num(rel.saidi, 4), 'hours per customer per year'),
      kv('CAIDI', num(rel.caidi, 3), 'hours per interruption'),
      ...(rel.saifiKw != null ? [kv('SAIFI (kW-weighted)', num(rel.saifiKw, 4), 'interruptions per year')] : []),
      kv('Customers', rel.totalCustomers),
      kv('Customer interruptions', num(rel.custInterrupts, 2), 'per year'),
      kv('Customer hours out', num(rel.custHours, 1), 'per year'),
      kv('Metered at', rel.meters.map((m) => device(m.elementId, m.element).name).join(', ') || '—'),
    ],
    note:
      "OpenDSS's EnergyMeter reliability calculation: a permanent fault anywhere in a protection section " +
      "(a fuse, recloser or relay and every branch down to the next one) interrupts every customer downstream " +
      "of the section's head device, for that branch's repair time." +
      (rel.unsectioned.count
        ? ` ${rel.unsectioned.count} element${rel.unsectioned.count === 1 ? '' : 's'} between a meter and the first ` +
          `protective device (${num(rel.unsectioned.lambda, 4)} faults per year in all) belong to no section, so faults ` +
          'there are not counted.'
        : ''),
  }
  const tables: Table[] = [indices]
  if (rel.meters.length > 1) {
    tables.push({
      id: 'reliability-zones',
      title: 'Metered zones',
      columns: [
        { key: 'meter', label: 'Metered at', width: 2 },
        { key: 'customers', label: 'Customers', digits: 0 },
        { key: 'saifi', label: 'SAIFI', unit: '/yr', digits: 4 },
        { key: 'saidi', label: 'SAIDI', unit: 'h/yr', digits: 4 },
        { key: 'caidi', label: 'CAIDI', unit: 'h', digits: 3 },
        { key: 'ci', label: 'Cust. interruptions', unit: '/yr', digits: 2 },
      ],
      rows: rel.meters.map((m) => ({
        meter: device(m.elementId, m.element).name,
        customers: m.customers,
        saifi: num(m.saifi, 4),
        saidi: num(m.saidi, 4),
        caidi: num(m.caidi, 3),
        ci: num(m.custInterrupts, 2),
      })),
    })
  }
  tables.push({
    id: 'reliability-sections',
    title: 'Protection sections',
    columns: [
      { key: 'head', label: 'Section head', width: 1.8 },
      { key: 'device', label: 'Device', width: 1.2 },
      { key: 'branches', label: 'Branches', digits: 0 },
      { key: 'km', label: 'Exposed', unit: 'km', digits: 2 },
      { key: 'lambda', label: 'Faults', unit: '/yr', digits: 4 },
      { key: 'repair', label: 'Repair', unit: 'h', digits: 1 },
      { key: 'customers', label: 'Customers downstream', digits: 0 },
      { key: 'ci', label: 'Cust. interruptions', unit: '/yr', digits: 3 },
      { key: 'ch', label: 'Cust. hours', unit: '/yr', digits: 2 },
    ],
    rows: rel.sections.map((s) => ({
      head: device(s.headId, s.head).name,
      device: TYPE_NAMES[s.device] ?? s.device,
      branches: s.branches,
      km: num(s.lengthKm, 2),
      lambda: num(s.lambda, 4),
      repair: num(s.avgRepairHrs, 1),
      customers: s.totalCustomers,
      ci: num(s.custInterrupts, 3),
      ch: num(s.custHours, 2),
    })),
    note: rel.sections.length ? undefined : 'No fuse, recloser or relay is metered, so there are no protection sections.',
  })
  tables.push({
    id: 'reliability-elements',
    title: 'Element fault rates',
    columns: [
      { key: 'element', label: 'Element', width: 1.8 },
      { key: 'type', label: 'Type', width: 1.2 },
      { key: 'section', label: 'Section', width: 1.6 },
      { key: 'faultrate', label: 'Fault rate', unit: '/yr', digits: 4 },
      { key: 'pctperm', label: 'Permanent', unit: '%', digits: 0 },
      { key: 'repair', label: 'Repair', unit: 'h', digits: 1 },
      { key: 'lambda', label: 'Permanent faults', unit: '/yr', digits: 4 },
      { key: 'downstream', label: 'Incl. downstream', unit: '/yr', digits: 4 },
      { key: 'customers', label: 'Customers downstream', digits: 0 },
    ],
    rows: Object.entries(rel.elements).map(([full, e]) => {
      const { name, type } = names.element(e.id, full)
      const section = rel.sections.find((s) => s.id === e.sectionId)
      return {
        element: name,
        type: TYPE_NAMES[type] ?? type,
        section: section ? device(section.headId, section.head).name : 'none',
        faultrate: num(e.faultRate, 4),
        pctperm: num(e.pctPerm, 0),
        repair: num(e.repairHrs, 1),
        lambda: num(e.lambda, 4),
        downstream: num(e.accumulatedLambda, 4),
        customers: e.totalCustomers,
      }
    }),
    note: "A line's fault rate is per unit of its length per year; a device's is per year.",
  })
  return { id: 'reliability', title: 'Reliability', tables, figures: [] }
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
