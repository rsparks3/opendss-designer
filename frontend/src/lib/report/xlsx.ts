/** The study report as an Excel workbook: one sheet per section, each table
 *  a block with a bold header row, units in the headers and numbers stored
 *  as numbers (formatted to the column's decimals), so the sheets sort,
 *  filter and chart like any engineer's own. ExcelJS is loaded on first use. */
import type { Column, Report, ReportSection, RowFlag, Table } from './model'
import { header } from './model'

/** A figure already rasterised by the caller (the canvas lives in the
 *  browser); keyed by figure id. */
export interface FigurePng {
  data: ArrayBuffer
  width: number
  height: number
}

const FILL: Record<Exclude<RowFlag, null>, string> = {
  violation: 'FFFBE3E3',
  warning: 'FFFFF1DB',
}
const HEAD_FILL = 'FFE8EBEF'

/** Excel refuses some characters in sheet names and cuts them at 31. */
export function sheetName(title: string, taken: Set<string>): string {
  const base = title.replace(/[[\]:*?/\\]/g, '-').slice(0, 31) || 'Sheet'
  let name = base
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`
  taken.add(name.toLowerCase())
  return name
}

const numFmt = (c: Column) => (c.digits == null ? undefined : c.digits === 0 ? '0' : `0.${'0'.repeat(c.digits)}`)

export async function reportWorkbook(report: Report, pngs: Record<string, FigurePng> = {}): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  const { meta } = report
  wb.creator = meta.softwareVersion ? `OpenDSS Designer ${meta.softwareVersion}` : 'OpenDSS Designer'
  wb.created = meta.date
  wb.title = meta.study.title || meta.circuitName
  wb.subject = meta.study.caseName

  const taken = new Set<string>()
  for (const section of report.sections) {
    const tables = section.tables
    const figures = section.figures.filter((f) => pngs[f.id])
    if (!tables.length && !figures.length) continue
    const ws = wb.addWorksheet(sheetName(section.id === 'study' ? 'Study' : section.title, taken))
    writeSection(ws, section, tables)
    for (const fig of figures) {
      const png = pngs[fig.id]
      const id = wb.addImage({ buffer: png.data, extension: 'png' })
      const row = ws.rowCount + 2
      ws.getCell(row, 1).value = fig.title
      ws.getCell(row, 1).font = { bold: true }
      // Shown at half its pixel size: the PNG is drawn at 2x for sharpness.
      const scale = Math.min(0.5, 1100 / png.width)
      ws.addImage(id, { tl: { col: 0, row }, ext: { width: png.width * scale, height: png.height * scale } })
    }
  }
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>
}

type Sheet = import('exceljs').Worksheet

function writeSection(ws: Sheet, section: ReportSection, tables: Table[]) {
  const widths: number[] = []
  const grids = tables.filter((t) => !t.keyValue && t.rows.length)
  // Excel allows one filter per sheet: give it to the sheet's only grid.
  const filtered = grids.length === 1 ? grids[0] : null
  let first = true

  for (const t of tables) {
    if (!first) ws.addRow([])
    first = false
    const title = ws.addRow([t.title])
    title.font = { bold: true, size: 12 }

    const head = ws.addRow(t.columns.map(header))
    head.font = { bold: true }
    head.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } }
      cell.border = { bottom: { style: 'thin' } }
    })
    const headRow = head.number
    // Scrolling keeps the header in view when the grid starts the sheet.
    if (t === filtered && t === tables[0]) ws.views = [{ state: 'frozen', ySplit: headRow }]

    t.rows.forEach((r, i) => {
      const row = ws.addRow(t.columns.map((c) => (r[c.key] == null ? null : r[c.key])))
      t.columns.forEach((c, j) => {
        const cell = row.getCell(j + 1)
        const fmt = numFmt(c)
        if (fmt && typeof cell.value === 'number') cell.numFmt = fmt
        if (typeof r[c.key] === 'string' && String(r[c.key]).includes('\n')) {
          cell.alignment = { wrapText: true, vertical: 'top' }
        }
      })
      const flag = t.flags?.[i]
      if (flag) {
        row.eachCell({ includeEmpty: true }, (cell, col) => {
          if (col <= t.columns.length) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[flag] } }
        })
      }
    })
    if (t === filtered) {
      ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: headRow + t.rows.length, column: t.columns.length } }
    }
    if (t.note) {
      const note = ws.addRow([t.note])
      note.font = { italic: true, color: { argb: 'FF57606A' } }
    }

    t.columns.forEach((c, j) => {
      const longest = Math.max(
        header(c).length,
        ...t.rows.map((r) => String(r[c.key] ?? '').split('\n').reduce((m, l) => Math.max(m, l.length), 0)),
      )
      widths[j] = Math.max(widths[j] ?? 8, Math.min(longest + 2, 60))
    })
  }
  widths.forEach((w, j) => (ws.getColumn(j + 1).width = w))
  // The title block's first column holds long labels; keep it readable.
  if (section.id === 'study') ws.getColumn(1).width = Math.max(ws.getColumn(1).width ?? 10, 28)
}
