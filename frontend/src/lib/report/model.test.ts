import { describe, expect, it } from 'vitest'
import fixture from '../../../../tests/fixtures/full-circuit.oneline.json'
import results from './__fixtures__/full-circuit.results.json'
import type { CircuitJSON, FaultResult, SolveResult, TimeSeriesResult } from '../../types/circuit'
import type { TccResult } from '../tcc'
import { profileSvg, tccSvg, timeSeriesSvg } from './charts'
import { buildReport, engineLabel, formatCell, header, reportFileName, type Report, type SectionKey, type Table } from './model'

// Recorded by scripts/make_report_fixture.py from the engine itself.
const circuit = fixture as unknown as CircuitJSON
const solve = results.solve as unknown as SolveResult
const fault = results.fault as unknown as FaultResult
const tcc = results.tcc as unknown as TccResult
const ALL: SectionKey[] = ['loadflow', 'diagram', 'shortcircuit', 'protection', 'timeseries']

function build(overrides: Partial<Parameters<typeof buildReport>[0]> = {}): Report {
  return buildReport({
    circuit,
    solve,
    fault,
    tcc,
    sections: new Set(ALL),
    date: new Date('2026-09-28T12:00:00'),
    figures: { diagram: '<svg/>' },
    softwareVersion: '0.7.0',
    engineVersion: '0.14',
    ...overrides,
  })
}

function table(r: Report, id: string): Table {
  const t = r.sections.flatMap((s) => s.tables).find((x) => x.id === id)
  if (!t) throw new Error(`no table ${id}`)
  return t
}

const value = (t: Table, item: string) => t.rows.find((r) => r.item === item)?.value

describe('study report model', () => {
  it('orders the sections the way a load-flow study reads', () => {
    expect(build().sections.map((s) => s.id)).toEqual([
      'study', 'summary', 'abnormal', 'buses', 'branches', 'loads', 'losses',
      'diagram', 'notes', 'shortcircuit', 'protection',
    ])
  })

  it('carries the title block and the criteria', () => {
    const r = build()
    const title = table(r, 'title-block')
    expect(value(title, 'Study')).toBe('Schema fixture study')
    expect(value(title, 'Engineer')).toBe('A. Engineer')
    expect(value(title, 'Software')).toBe('OpenDSS Designer 0.7.0')
    expect(title.note).toMatch(/every element type/i)
    expect(value(table(r, 'criteria'), 'Loading warning at')).toBe(75)
    expect(value(table(r, 'element-counts'), 'Loads')).toBe(2)
  })

  it('adds up the power the way the engine reports it', () => {
    const s = table(build(), 'summary')
    const src = solve.elements['vsource.source']
    expect(value(s, 'Source real power')).toBeCloseTo(-src.kw, 1)
    expect(value(s, 'Losses')).toBeCloseTo(solve.losses!.kw, 2)
    const loads = Object.values(solve.elements).filter((e) => e.id === 'n_load' || e.id === 'n_load2')
    expect(value(s, 'Total load')).toBeCloseTo(loads.reduce((a, e) => a + e.kw, 0), 1)
    // Generators and PV deliver; storage here is charging a little.
    const gen = ['n_gen', 'n_pv', 'n_stg'].map((id) => Object.values(solve.elements).find((e) => e.id === id)!)
    expect(value(s, 'Generation (PV, generators, storage)')).toBeCloseTo(-gen.reduce((a, e) => a + e.kw, 0), 1)
  })

  it('names buses as they are drawn and branches by their ends', () => {
    const r = build()
    expect(table(r, 'buses').rows.map((b) => b.bus)).toContain('BUS-HV')
    const ln1 = table(r, 'branches').rows.find((b) => b.element === 'LN1')!
    expect([ln1.from, ln1.to]).toEqual(['BUS-MV', 'BUS-FDR'])
    expect(ln1.type).toBe('Line')
    expect(ln1.rating).toBe(400)
    const hv = table(r, 'buses').rows.find((b) => b.bus === 'BUS-HV')!
    expect(hv.kvll).toBeCloseTo(115, 1)
  })

  it('finds nothing abnormal within the default criteria', () => {
    const r = build({ circuit: { ...circuit, limits: null } })
    expect(table(r, 'abnormal').rows).toEqual([])
    expect(table(r, 'abnormal').note).toMatch(/No bus voltage/)
  })

  it('lists abnormal conditions against the project criteria, worst first', () => {
    const tight = { vminPu: 1.0015, vmaxPu: 1.05, overloadPct: 20, warnPct: 10 }
    const r = build({ circuit: { ...circuit, limits: tight } })
    const t = table(r, 'abnormal')
    const conditions = t.rows.map((x) => x.condition)
    expect(conditions).toContain('Undervoltage')
    expect(conditions).toContain('Overload')
    expect(conditions).toContain('Heavy loading')
    // Violations come before warnings.
    const firstWarning = t.flags!.indexOf('warning')
    expect(t.flags!.slice(0, firstWarning).every((f) => f === 'violation')).toBe(true)
    expect(t.flags!.slice(firstWarning).every((f) => f === 'warning')).toBe(true)
    const reg = t.rows.find((x) => x.element === 'REG1')!
    expect(reg).toMatchObject({ condition: 'Overload', limit: 20, unit: '% of rating' })
    // The branch table tints the same rows.
    const branches = table(r, 'branches')
    expect(branches.flags![branches.rows.findIndex((b) => b.element === 'REG1')]).toBe('violation')
  })

  it('sums losses by type up to the circuit total', () => {
    const t = table(build(), 'loss-types')
    const total = t.rows.find((x) => x.type === 'Circuit total')!
    expect(total.kw).toBeCloseTo(solve.losses!.kw, 3)
    const parts = t.rows.filter((x) => x.type !== 'Circuit total').reduce((a, x) => a + (x.kw as number), 0)
    expect(parts).toBeCloseTo(solve.losses!.kw, 1)
  })

  it('reports the notes and what they are about', () => {
    expect(table(build(), 'notes').rows).toEqual([
      { text: 'Utility source\nFault duty per 2026 study', target: 'SRC1' },
    ])
  })

  it('tabulates fault currents and protective devices', () => {
    const r = build()
    expect(table(r, 'shortcircuit').rows).toHaveLength(Object.keys(fault.buses).length)
    const traces = tcc.devices.reduce((a, d) => a + d.traces.length, 0)
    expect(table(r, 'protection-settings').rows).toHaveLength(traces)
    expect(table(r, 'interrupting-duty').rows).toHaveLength(tcc.switches.length)
    // Devices by their drawn names; each element by its own part of the label.
    const rec = table(r, 'protection-settings').rows.filter((x) => x.device === 'REC1').map((x) => x.unit)
    expect(rec).toEqual(['fast', 'delayed'])
  })

  it('leaves out what was not asked for or not run', () => {
    const r = build({ sections: new Set(['loadflow']), fault: null })
    expect(r.sections.map((s) => s.id)).not.toContain('shortcircuit')
    expect(r.sections.map((s) => s.id)).not.toContain('diagram')
    const unsolved = build({ solve: null, sections: new Set(['loadflow']) })
    expect(table(unsolved, 'no-solve').note).toMatch(/solve it/)
  })

  it('summarises a time-series run and keeps every step for the workbook', () => {
    const ts = {
      converged: true, cancelled: false, mode: 'daily', stepMin: 60, steps: 3, downsampled: false,
      time: [0, 1, 2], totals: { kw: [100, 200, 150], lossKw: [1, 3, 2] },
      buses: {}, elements: {},
      summary: { energyKwh: 450, lossesKwh: 6, peakKw: 200, peakHour: 1, minVpu: { bus: 'bus_hv', hour: 1, value: 0.97 }, maxVpu: null },
      nonConvergedSteps: [], issues: [], nodeBuses: solve.nodeBuses, lineBuses: {}, busNames: {},
    } as unknown as TimeSeriesResult
    const r = build({ timeseries: ts })
    const summary = table(r, 'ts-summary')
    expect(value(summary, 'Losses, share of energy')).toBeCloseTo(1.33, 2)
    expect(summary.rows.find((x) => x.item === 'Lowest voltage')!.unit).toBe('pu at BUS-HV, hour 1')
    const series = table(r, 'ts-series')
    expect(series.workbookOnly).toBe(true)
    expect(series.rows).toHaveLength(3)
    expect(timeSeriesSvg(ts)).toMatch(/^<svg/)
  })

  it('draws its charts as standalone SVG', () => {
    const profile = profileSvg(solve, { vminPu: 0.95, vmaxPu: 1.05, overloadPct: 100, warnPct: 80 })!
    expect(profile).toMatch(/^<svg xmlns/)
    expect(profile).toContain('stroke-dasharray')
    const plot = tccSvg(tcc, { device: (d) => d.name.toUpperCase(), bus: (b) => `bus ${b}` })!
    expect(plot).toContain('<polyline')
    expect(plot).toContain('REC1 fast')
    // One fault marker per bus, however many devices sit on it.
    expect(plot.match(/3φ fault at/g)!.length).toBe(new Set(tcc.devices.map((d) => d.bus)).size)
  })

  it('names the solver in one short line, and counts the model in English', () => {
    const raw = ['DSS C-API Library version 0.14.5 revision 87d85c2622c828 based on OpenDSS SVN 3723', 'DSS-Python version: 0.15.7'].join('\n')
    expect(engineLabel(raw)).toBe('DSS C-API Library version 0.14.5')
    const counts = table(build(), 'element-counts').rows.map((r) => r.item)
    expect(counts).toContain('Buses')
    expect(counts).toContain('Storage')
    expect(counts).not.toContain('Buss')
  })

  it('holds shunt generation to its kVA rating and a capacitor to its continuous current', () => {
    const r = build({ circuit: { ...circuit, limits: { vminPu: 0.5, vmaxPu: 1.5, overloadPct: 50, warnPct: 1 } } })
    const types = table(r, 'abnormal').rows.map((x) => x.type)
    expect(types).toContain('Generator')
    expect(types).toContain('PV system')
    expect(types).toContain('Capacitor')
    expect(table(r, 'abnormal').note).toMatch(/kVA rating/)
    const gens = table(r, 'generation')
    const gen = gens.rows.find((x) => x.type === 'Generator')!
    expect(gen.ratingUnit).toBe('kVA')
    expect(gen.rating).toBe(750)
    expect(gen.loading).toBeGreaterThan(60)
    const cap = gens.rows.find((x) => x.type === 'Capacitor')!
    expect(cap.ratingUnit).toBe('A')
  })

  it('prints cells and headers', () => {
    expect(header({ key: 'k', label: 'Loss', unit: 'kW' })).toBe('Loss (kW)')
    expect(formatCell(1.23456, { key: 'k', label: '', digits: 2 })).toBe('1.23')
    expect(formatCell(null, { key: 'k', label: '' })).toBe('—')
    expect(reportFileName('Feeder: 12', 'pdf')).toBe('Feeder- 12-report.pdf')
  })
})
