import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import fixture from '../../../../tests/fixtures/full-circuit.oneline.json'
import results from './__fixtures__/full-circuit.results.json'
import type { CircuitJSON, FaultResult, SolveResult } from '../../types/circuit'
import type { TccResult } from '../tcc'
import { buildReport } from './model'
import { pdfSafe, reportPdf, svgSize, type SvgRenderer } from './pdf'
import { reportWorkbook, sheetName } from './xlsx'

const report = buildReport({
  circuit: fixture as unknown as CircuitJSON,
  solve: results.solve as unknown as SolveResult,
  fault: results.fault as unknown as FaultResult,
  tcc: results.tcc as unknown as TccResult,
  sections: new Set(['loadflow', 'diagram', 'shortcircuit', 'protection']),
  date: new Date('2026-09-28T12:00:00'),
  figures: { diagram: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"/>' },
  softwareVersion: '0.7.0',
})

describe('study report workbook', () => {
  it('has a sheet per section, numbers as numbers', async () => {
    const buf = await reportWorkbook(report)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    const names = wb.worksheets.map((w) => w.name)
    expect(names).toEqual([
      'Study', 'Load flow summary', 'Abnormal conditions', 'Bus voltages', 'Branch flows',
      'Loads and generation', 'Losses', 'Notes', 'Short circuit', 'Protection',
    ])
    const buses = wb.getWorksheet('Bus voltages')!
    expect(buses.getCell(2, 1).value).toBe('Bus')
    expect(buses.getCell(2, 2).value).toBe('Base (kV LL)')
    const kv = buses.getCell(3, 2)
    expect(typeof kv.value).toBe('number')
    expect(kv.numFmt).toBe('0.00')
    expect(buses.autoFilter).toBeTruthy()
  })

  it('names sheets the way Excel allows', () => {
    const taken = new Set<string>()
    expect(sheetName('Loads/generation [draft]: a very long section title', taken)).toBe('Loads-generation -draft-- a ver')
    expect(sheetName('Study', taken)).toBe('Study')
    expect(sheetName('study', taken)).toBe('study 2')
  })
})

describe('study report PDF', () => {
  it('writes a multi-page PDF with a vector figure where the one-line goes', async () => {
    const drawn: string[] = []
    const render: SvgRenderer = async (_doc, svg) => {
      drawn.push(svg)
    }
    const buf = await reportPdf(report, render)
    const text = new TextDecoder('latin1').decode(new Uint8Array(buf))
    expect(text.startsWith('%PDF-')).toBe(true)
    const pages = (text.match(/\/Type \/Page\b/g) ?? []).length
    expect(pages).toBeGreaterThan(6)
    expect(drawn).toHaveLength(1)
    expect(text).toContain('Schema fixture study')
  })

  it('spells out what the standard fonts cannot draw', () => {
    expect(pdfSafe('3φ fault, 0.5 Ω, ∠ A ≥ 5')).toBe('3ph fault, 0.5 ohm, Ang A >= 5')
    expect(pdfSafe('Café — 20 °C')).toBe('Café — 20 °C')
    expect(pdfSafe('变电站')).toBe('???')
  })

  it('reads an SVG size from its root', () => {
    expect(svgSize('<svg xmlns="x" width="123.5" height="45" viewBox="0 0 1 1">')).toEqual({ w: 123.5, h: 45 })
  })
})
