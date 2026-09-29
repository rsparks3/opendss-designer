/** The study report as a PDF: a title page, then each section with its
 *  tables (headers repeated across pages, abnormal rows tinted) and its
 *  figures as vector drawings, every page headed with the study and
 *  footed with the page number. jsPDF, its table plug-in and svg2pdf are
 *  loaded on first use.
 *
 *  The PDF's built-in fonts only cover Latin-1, so the few symbols the
 *  report uses are spelled out (φ -> ph, Ω -> ohm) rather than printed as
 *  blanks. Embedding a Unicode font would lift that at the cost of a few
 *  hundred kilobytes per report. */
import type { jsPDF as JsPdf } from 'jspdf'
import type { Figure, Report, RowFlag, Table } from './model'
import { formatCell, header } from './model'

const MARGIN = 40
const HEAD_H = 28
const FOOT_H = 26
const INK: [number, number, number] = [31, 35, 40]
const MUTED: [number, number, number] = [87, 96, 106]
const TINT: Record<Exclude<RowFlag, null>, [number, number, number]> = {
  violation: [251, 227, 227],
  warning: [255, 241, 219],
}
/** A one-line longer than this (flow units) is printed on 11x17. */
const BIG_DRAWING = 1500
/** Tables wider than this go on a landscape page. */
const WIDE = 9

const SUBSTITUTES: [RegExp, string][] = [
  [/φ/g, 'ph'],
  [/∠/g, 'Ang'],
  [/Ω/g, 'ohm'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/→/g, '->'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
]

/** Text the PDF's standard fonts can draw. */
export function pdfSafe(s: string): string {
  let out = s
  for (const [re, to] of SUBSTITUTES) out = out.replace(re, to)
  // Anything else outside Latin-1 would print as nothing at all.
  return out.replace(/[^\u0000-ÿ–—•…€]/g, '?')
}

export type SvgRenderer = (doc: JsPdf, svg: string, box: { x: number; y: number; w: number; h: number }) => Promise<void>

/** Draw an SVG string with svg2pdf, fitted to the box, keeping its shape. */
const svg2pdfRenderer: SvgRenderer = async (doc, svg, box) => {
  // Called directly: loaded on demand, the plug-in does not reliably find
  // the jsPDF it would register itself on.
  const { svg2pdf } = await import('svg2pdf.js')
  const el = new DOMParser().parseFromString(pdfSafe(svg), 'image/svg+xml').documentElement
  // svg2pdf reads computed geometry, so the drawing is attached while it works.
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden'
  holder.appendChild(el)
  document.body.appendChild(holder)
  try {
    const { w, h } = svgSize(svg)
    const k = Math.min(box.w / w, box.h / h)
    await svg2pdf(el, doc, { x: box.x + (box.w - w * k) / 2, y: box.y, width: w * k, height: h * k })
  } finally {
    holder.remove()
  }
}

export function svgSize(svg: string): { w: number; h: number } {
  const m = /<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/.exec(svg)
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 720, h: 380 }
}

export async function reportPdf(report: Report, render: SvgRenderer = svg2pdfRenderer): Promise<ArrayBuffer> {
  const { jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' })
  const { meta } = report
  const title = pdfSafe(meta.study.title || meta.circuitName || 'Study report')
  doc.setProperties({
    title,
    subject: pdfSafe(meta.study.caseName || 'Load-flow study'),
    author: pdfSafe(meta.study.engineer),
    creator: meta.softwareVersion ? `OpenDSS Designer ${meta.softwareVersion}` : 'OpenDSS Designer',
  })

  // The title page carries the title block itself, then the criteria and
  // the model's make-up.
  let y = titlePage(doc, report) + 24
  const pageW = () => doc.internal.pageSize.getWidth()
  const pageH = () => doc.internal.pageSize.getHeight()
  const study = report.sections.find((s) => s.id === 'study')
  if (study) drawTables(doc, autoTable, study.tables.slice(1), y)

  for (const section of report.sections) {
    if (section.id === 'study') continue
    const printable = section.tables.filter((t) => !t.workbookOnly)
    const wide = printable.some((t) => t.columns.length > WIDE)
    // A page to itself (the one-line) turns to suit the drawing's shape.
    const own = section.figures.find((f) => f.landscape)
    const ownSize = own ? svgSize(own.svg) : null
    const landscape = ownSize ? ownSize.w >= ownSize.h : wide
    // A big feeder's one-line gets an 11x17 sheet, as drawings are plotted.
    const sheet = ownSize && Math.max(ownSize.w, ownSize.h) > BIG_DRAWING ? 'tabloid' : 'letter'
    doc.addPage(sheet, landscape ? 'landscape' : 'portrait')
    y = MARGIN + HEAD_H
    doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(...INK)
    doc.text(pdfSafe(section.title), MARGIN, y + 6)
    y += 22

    for (const fig of section.figures.filter((f) => f.landscape)) {
      y = await drawFigure(doc, render, fig, y, pageH() - MARGIN - FOOT_H - y)
    }
    y = drawTables(doc, autoTable, printable, y)
    if (section.tables.some((t) => t.workbookOnly)) {
      doc.setFont('helvetica', 'italic').setFontSize(8.5).setTextColor(...MUTED)
      doc.text('Every step of the run is listed in the Excel version of this report.', MARGIN, y + 4)
      y += 18
    }
    for (const fig of section.figures.filter((f) => !f.landscape)) {
      const { w, h } = svgSize(fig.svg)
      const need = ((pageW() - 2 * MARGIN) / w) * h + 24
      if (y + need > pageH() - MARGIN - FOOT_H) {
        doc.addPage(sheet, landscape ? 'landscape' : 'portrait')
        y = MARGIN + HEAD_H
      }
      y = await drawFigure(doc, render, fig, y, need)
    }
  }

  chrome(doc, report, title)
  return doc.output('arraybuffer')
}

/** Returns where the page's text ended. */
function titlePage(doc: JsPdf, report: Report): number {
  const { meta } = report
  const s = meta.study
  const w = doc.internal.pageSize.getWidth()
  let y = 150
  doc.setFont('helvetica', 'bold').setFontSize(24).setTextColor(...INK)
  for (const line of doc.splitTextToSize(pdfSafe(s.title || meta.circuitName || 'Study report'), w - 2 * MARGIN)) {
    doc.text(line, MARGIN, y)
    y += 28
  }
  doc.setFont('helvetica', 'normal').setFontSize(13).setTextColor(...MUTED)
  const sub = [s.caseName, `Circuit ${meta.circuitName}`].filter(Boolean).join(' - ')
  doc.text(pdfSafe(sub), MARGIN, y + 2)
  y += 26
  doc.setDrawColor(...INK).setLineWidth(1.2).line(MARGIN, y, w - MARGIN, y)
  y += 24
  doc.setFontSize(11).setTextColor(...INK)
  const rows: [string, string][] = [
    ['Prepared by', [s.engineer, s.company].filter(Boolean).join(', ') || '-'],
    ['Date', meta.date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })],
    ['Software', `OpenDSS Designer${meta.softwareVersion ? ` ${meta.softwareVersion}` : ''}`],
    ['Solver', meta.engineVersion ?? 'OpenDSS'],
  ]
  for (const [k, v] of rows) {
    doc.setFont('helvetica', 'bold').text(k, MARGIN, y)
    doc.setFont('helvetica', 'normal')
    const lines: string[] = doc.splitTextToSize(pdfSafe(v), w - 2 * MARGIN - 100)
    doc.text(lines, MARGIN + 100, y)
    y += 18 + (lines.length - 1) * 13
  }
  if (s.description.trim()) {
    y += 10
    doc.setFontSize(10.5).setTextColor(...MUTED)
    for (const line of doc.splitTextToSize(pdfSafe(s.description), w - 2 * MARGIN)) {
      doc.text(line, MARGIN, y)
      y += 14
    }
  }
  return y
}

type AutoTable = typeof import('jspdf-autotable').default

function drawTables(doc: JsPdf, autoTable: AutoTable, tables: Table[], startY: number): number {
  let y = startY
  const pageH = doc.internal.pageSize.getHeight()
  for (const t of tables) {
    // Keep a title with at least a few rows of its table.
    if (y + 60 > pageH - MARGIN - FOOT_H) {
      doc.addPage()
      y = MARGIN + HEAD_H
    }
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK)
    doc.text(pdfSafe(t.title), MARGIN, y + 4)
    y += 10
    if (t.rows.length) {
      const numeric = t.columns.map((c) => c.digits != null)
      const small = t.columns.length > WIDE
      const total = t.columns.reduce((a, c) => a + (c.width ?? (c.digits != null ? 1 : 1.4)), 0)
      const avail = doc.internal.pageSize.getWidth() - 2 * MARGIN
      const tableW = t.keyValue ? Math.min(avail, 420) : avail
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN, top: MARGIN + HEAD_H, bottom: MARGIN + FOOT_H },
        tableWidth: tableW,
        head: t.keyValue ? undefined : [t.columns.map((c) => pdfSafe(header(c)))],
        body: t.rows.map((r) => t.columns.map((c) => pdfSafe(formatCell(r[c.key], c)))),
        theme: 'grid',
        styles: {
          font: 'helvetica',
          fontSize: small ? 7 : 8.5,
          cellPadding: small ? 2.5 : 3.5,
          lineColor: [216, 220, 226],
          lineWidth: 0.4,
          textColor: INK,
          overflow: 'linebreak',
        },
        headStyles: { fillColor: [232, 235, 239], textColor: INK, fontStyle: 'bold', halign: 'center', valign: 'middle' },
        columnStyles: Object.fromEntries(
          t.columns.map((c, i) => [
            i,
            {
              halign: numeric[i] ? 'right' : 'left',
              cellWidth: (tableW * (c.width ?? (c.digits != null ? 1 : 1.4))) / total,
              ...(t.keyValue && i === 0 ? { fontStyle: 'bold' } : {}),
            },
          ]),
        ),
        didParseCell: (data) => {
          if (data.section !== 'body') return
          const flag = t.flags?.[data.row.index]
          if (flag) data.cell.styles.fillColor = TINT[flag]
        },
      })
      y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4
    }
    if (t.note) {
      doc.setFont('helvetica', 'italic').setFontSize(8).setTextColor(...MUTED)
      const lines = doc.splitTextToSize(pdfSafe(t.note), doc.internal.pageSize.getWidth() - 2 * MARGIN)
      if (y + lines.length * 10 + 8 > pageH - MARGIN - FOOT_H) {
        doc.addPage()
        y = MARGIN + HEAD_H
      }
      doc.text(lines, MARGIN, y + 8)
      y += lines.length * 10 + 4
    }
    y += 16
  }
  return y
}

async function drawFigure(doc: JsPdf, render: SvgRenderer, fig: Figure, y: number, maxH: number): Promise<number> {
  const w = doc.internal.pageSize.getWidth() - 2 * MARGIN
  const size = svgSize(fig.svg)
  const h = Math.min(maxH - 16, (w / size.w) * size.h)
  if (!fig.landscape) {
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK)
    doc.text(pdfSafe(fig.title), MARGIN, y + 4)
    y += 12
  }
  await render(doc, fig.svg, { x: MARGIN, y, w, h })
  return y + h + 18
}

/** Header and footer on every page but the title page. */
function chrome(doc: JsPdf, report: Report, title: string) {
  const n = doc.getNumberOfPages()
  const { meta } = report
  const left = [title, meta.study.caseName].filter(Boolean).map(pdfSafe).join(' - ')
  const made = `OpenDSS Designer${meta.softwareVersion ? ` ${meta.softwareVersion}` : ''} - ${meta.date.toLocaleDateString()}`
  for (let i = 1; i <= n; i++) {
    doc.setPage(i)
    const w = doc.internal.pageSize.getWidth()
    const h = doc.internal.pageSize.getHeight()
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED)
    if (i > 1) {
      doc.text(left, MARGIN, MARGIN)
      doc.text(pdfSafe(meta.circuitName), w - MARGIN, MARGIN, { align: 'right' })
      doc.setDrawColor(216, 220, 226).setLineWidth(0.5).line(MARGIN, MARGIN + 6, w - MARGIN, MARGIN + 6)
    }
    doc.text(made, MARGIN, h - MARGIN + 8)
    doc.text(`Page ${i} of ${n}`, w - MARGIN, h - MARGIN + 8, { align: 'right' })
  }
}

