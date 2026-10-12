/** File → Export → Study report: gather what the report needs (solving,
 *  running the fault and protection studies when asked and not yet run),
 *  draw its figures, and hand the files to the browser. */
import { toCircuitJSON, useCircuitStore } from '../../store/circuitStore'
import { useResultsStore } from '../../store/resultsStore'
import type { CircuitJSON } from '../../types/circuit'
import { api } from '../api'
import { svgToPng } from '../exportDiagram'
import { captureDiagram, downloadBlob } from '../fileActions'
import { limitsOf } from '../limits'
import { runSolve } from '../solve'
import type { TccResult } from '../tcc'
import { profileSvg, tccSvg, timeSeriesSvg } from './charts'
import { buildReport, Names, reportFileName, type Report, type SectionKey } from './model'
import { svgSize } from './pdf'

export type ReportFormat = 'pdf' | 'xlsx' | 'both'

export interface ReportOptions {
  format: ReportFormat
  sections: SectionKey[]
  /** Told what is happening, for the dialog's status line. */
  onProgress?: (what: string) => void
}

const PROTECTIVE = new Set(['fuse', 'recloser', 'relay', 'breaker'])

/** Which sections make sense for the circuit as it stands, and why not. */
export function sectionAvailability(): Record<SectionKey, string | null> {
  const { nodes } = useCircuitStore.getState()
  const rs = useResultsStore.getState()
  return {
    loadflow: null,
    diagram: null,
    shortcircuit: null,
    protection: nodes.some((n) => PROTECTIVE.has(n.type ?? '')) ? null : 'The circuit has no breakers, fuses, reclosers or relays.',
    reliability: null,
    timeseries: rs.timeseries ? null : 'Run a daily or yearly time series first.',
  }
}

/** Build the report and download it. Throws with a reason a person can act
 *  on when a study it needs will not run. */
export async function exportReport(opts: ReportOptions): Promise<void> {
  const say = opts.onProgress ?? (() => {})
  const sections = new Set(opts.sections)
  const circuit: CircuitJSON = toCircuitJSON(useCircuitStore.getState())
  let rs = useResultsStore.getState()

  if (sections.has('loadflow') && (rs.stale || !rs.result)) {
    if (rs.analysisMode === 'timeseries') {
      throw new Error('Switch to Snapshot and solve before exporting a load-flow report.')
    }
    say('Solving the power flow…')
    if (!(await runSolve())) throw new Error('The power flow could not be run.')
    rs = useResultsStore.getState()
  }
  const solve = rs.result && !rs.stale ? rs.result : null
  if (sections.has('loadflow') && !solve?.converged) {
    throw new Error('The power flow does not converge; see the Problems list.')
  }

  let fault = rs.fault
  if (sections.has('shortcircuit') && !fault) {
    say('Running the fault study…')
    fault = await api.faultStudy(circuit)
    if (!fault.converged) throw new Error('The fault study did not converge.')
    useResultsStore.getState().setFault(fault)
  }

  let tcc: TccResult | null = null
  if (sections.has('protection')) {
    say('Running the protection study…')
    tcc = await api.tcc(circuit)
  }

  let reliability = rs.reliability
  if (sections.has('reliability') && !reliability) {
    say('Running the reliability study…')
    reliability = await api.reliability(circuit)
    if (!reliability.converged) throw new Error('The reliability study did not run; see the Problems list.')
    useResultsStore.getState().setReliability(reliability)
  }

  say('Drawing the figures…')
  const limits = limitsOf(circuit.limits)
  const names = new Names(circuit, solve?.nodeBuses ?? fault?.nodeBuses ?? {})
  const diagram = sections.has('diagram') ? await captureDiagram() : null
  const figures = {
    ...(diagram ? { diagram } : {}),
    ...(solve && sections.has('loadflow') ? { profile: profileSvg(solve, limits) ?? undefined } : {}),
    ...(tcc
      ? {
          tcc:
            tccSvg(tcc, {
              device: (d) => (d.nodeId ? names.element(d.nodeId, d.name).name : d.name),
              bus: (b) => names.bus(b),
            }) ?? undefined,
        }
      : {}),
    ...(rs.timeseries && sections.has('timeseries') ? { timeseries: timeSeriesSvg(rs.timeseries) ?? undefined } : {}),
  }

  let versions: { version?: string; opendssVersion?: string } = {}
  try {
    versions = await api.health()
  } catch {
    // The report says less about what made it; nothing else depends on it.
  }

  const report = buildReport({
    circuit,
    solve,
    fault,
    tcc,
    reliability,
    timeseries: rs.timeseries,
    figures,
    sections,
    date: new Date(),
    softwareVersion: versions.version ?? null,
    engineVersion: versions.opendssVersion ?? null,
  })

  if (opts.format === 'pdf' || opts.format === 'both') {
    say('Writing the PDF…')
    const { reportPdf } = await import('./pdf')
    const buf = await reportPdf(report)
    downloadBlob(reportFileName(circuit.name, 'pdf'), new Blob([buf], { type: 'application/pdf' }))
  }
  if (opts.format === 'xlsx' || opts.format === 'both') {
    say('Writing the workbook…')
    const { reportWorkbook } = await import('./xlsx')
    const buf = await reportWorkbook(report, await rasterise(report))
    downloadBlob(
      reportFileName(circuit.name, 'xlsx'),
      new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    )
  }
}

/** Every figure as a PNG for the workbook, no side past 4000 px (a canvas
 *  much larger than that fails in some browsers). */
async function rasterise(report: Report) {
  const out: Record<string, { data: ArrayBuffer; width: number; height: number }> = {}
  for (const fig of report.sections.flatMap((s) => s.figures)) {
    const { w, h } = svgSize(fig.svg)
    const scale = Math.min(2, 4000 / Math.max(w, h, 1))
    try {
      const blob = await svgToPng(fig.svg, scale)
      out[fig.id] = { data: await blob.arrayBuffer(), width: Math.ceil(w * scale), height: Math.ceil(h * scale) }
    } catch {
      // A figure that will not rasterise is left out of the workbook; the
      // PDF still draws it as vectors.
    }
  }
  return out
}
