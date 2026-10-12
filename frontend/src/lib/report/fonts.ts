/** A Unicode typeface for the PDF, fetched only when a report needs one.
 *
 *  jsPDF's standard fonts cover Latin-1 and nothing else: a note in
 *  Greek, a bus named in Cyrillic or a Chinese study title would print as
 *  blanks. DejaVu Sans covers most scripts, and the three faces the report
 *  uses weigh about two megabytes together, so they are separate assets
 *  the browser downloads (and caches) the first time a report has text
 *  outside Latin-1, and never otherwise. jsPDF embeds only the glyphs a
 *  document uses, so the PDF itself stays small. */
import type { jsPDF as JsPdf } from 'jspdf'
import type { Report } from './model'
import boldUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url'
import italicUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans-Oblique.ttf?url'
import regularUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url'

export const UNICODE_FONT = 'DejaVuSans'

export interface FontFiles {
  normal: ArrayBuffer
  bold: ArrayBuffer
  italic: ArrayBuffer
}

export type FontLoader = () => Promise<FontFiles>

/** The three faces, from the app's own assets. */
export const fetchFontFiles: FontLoader = async () => {
  const get = async (url: string) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Font download failed (${res.status})`)
    return res.arrayBuffer()
  }
  const [normal, bold, italic] = await Promise.all([get(regularUrl), get(boldUrl), get(italicUrl)])
  return { normal, bold, italic }
}

/** Standard-font substitutes for the few symbols the report uses, so a
 *  Latin-1 report need not fetch a typeface for a φ. */
export const SUBSTITUTES: [RegExp, string][] = [
  [/φ/g, 'ph'],
  [/∠/g, 'Ang'],
  [/Ω/g, 'ohm'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/→/g, '->'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
]

/** What the standard fonts can print once the substitutes are applied:
 *  Latin-1 plus the few typographic marks WinAnsi carries. */
const PRINTABLE = /^[\u0000-ÿ–—•…€]*$/

/** Whether any text in the report falls outside the standard fonts even
 *  after the usual substitutions. Figures count: a note on the one-line is
 *  text too. */
export function needsUnicodeFont(report: Report): boolean {
  let text = JSON.stringify(report.meta) + JSON.stringify(report.sections)
  for (const [re, to] of SUBSTITUTES) text = text.replace(re, to)
  return !PRINTABLE.test(text)
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  // In chunks: spreading a megabyte into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Register the faces with a document under UNICODE_FONT. */
export function registerUnicodeFont(doc: JsPdf, files: FontFiles): void {
  const faces: [keyof FontFiles, string][] = [
    ['normal', 'normal'],
    ['bold', 'bold'],
    ['italic', 'italic'],
  ]
  for (const [key, style] of faces) {
    const file = `${UNICODE_FONT}-${style}.ttf`
    doc.addFileToVFS(file, toBase64(files[key]))
    doc.addFont(file, UNICODE_FONT, style)
  }
}
