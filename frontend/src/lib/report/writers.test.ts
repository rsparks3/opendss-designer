import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import fixture from '../../../../tests/fixtures/full-circuit.oneline.json'
import results from './__fixtures__/full-circuit.results.json'
import type { CircuitJSON, FaultResult, SolveResult } from '../../types/circuit'
import type { TccResult } from '../tcc'
import { buildReport } from './model'
import { needsUnicodeFont, toBase64, UNICODE_FONT, type FontFiles } from './fonts'
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

  it('asks for the Unicode face only when the substitutes are not enough', () => {
    expect(needsUnicodeFont(report)).toBe(false)
    const titled = { ...report, meta: { ...report.meta, study: { ...report.meta.study, title: 'Подстанция 12' } } }
    expect(needsUnicodeFont(titled)).toBe(true)
  })

  it('sets a report with text beyond Latin-1 in the embedded Unicode face', async () => {
    const require = createRequire(import.meta.url)
    const ttf = (name: string) => {
      const buf = readFileSync(require.resolve(`dejavu-fonts-ttf/ttf/${name}`))
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    }
    const files: FontFiles = {
      normal: ttf('DejaVuSans.ttf'),
      bold: ttf('DejaVuSans-Bold.ttf'),
      italic: ttf('DejaVuSans-Oblique.ttf'),
    }
    const titled = {
      ...report,
      meta: { ...report.meta, study: { ...report.meta.study, title: 'Подстанция 12 — 变电站' } },
      sections: report.sections.map((s) => ({
        ...s,
        figures: s.figures.map((f) => ({
          ...f,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><text font-family="system-ui, sans-serif">Шина</text></svg>',
        })),
      })),
    }
    const drawn: string[] = []
    const render: SvgRenderer = async (_doc, svg) => {
      drawn.push(svg)
    }
    const buf = await reportPdf(titled, render, async () => files)
    const text = new TextDecoder('latin1').decode(new Uint8Array(buf))
    expect(text).toContain(`/BaseFont /${UNICODE_FONT}`)
    expect(text).toContain('/FontFile2')
    // Only the glyphs used are embedded, compressed: the three faces are 2 MB raw.
    expect(buf.byteLength).toBeLessThan(400_000)
    // The drawing's text is pointed at the same face.
    expect(drawn[0]).toContain(`font-family="${UNICODE_FONT}"`)
    // The standard-font report never loads it.
    let loads = 0
    await reportPdf(report, render, async () => {
      loads += 1
      return files
    })
    expect(loads).toBe(0)
    expect(toBase64(new Uint8Array([72, 105]).buffer)).toBe('SGk=')
  })

  it('reads an SVG size from its root', () => {
    expect(svgSize('<svg xmlns="x" width="123.5" height="45" viewBox="0 0 1 1">')).toEqual({ w: 123.5, h: 45 })
  })
})
