/** The one-line as a real SVG, and a PNG rendered from it.
 *
 *  The canvas is what it is on screen: symbols are inline SVGs inside React
 *  Flow's node divs, edges are SVG paths in flow coordinates, and labels,
 *  badges and chips are HTML. Rather than screenshot that (a foreignObject
 *  wrapper that PowerPoint and Visio open as a blank), this reads the
 *  rendered DOM and writes each piece back out as native SVG: paths copied
 *  with their computed stroke, symbol SVGs copied with their computed styles
 *  inlined, HTML text as <text> and coloured boxes as <rect>. Colours come
 *  from computed style, so whatever overlay is on -- voltage badges, loading
 *  pies, phase tints -- is exported exactly as drawn. The result opens in a
 *  browser, Inkscape, Visio and PowerPoint as editable vectors.
 *
 *  Geometry is taken from getBoundingClientRect and mapped back into flow
 *  coordinates through the viewport's zoom, so the export is independent of
 *  how far the user has zoomed or panned.
 */
import { LOW_V, NEUTRAL, OK, VIOLATION, WARN } from './colorScale'
import { PHASE_LEGEND } from './phasing'
import type { OverlayMode } from '../store/resultsStore'

export interface LegendEntry {
  label: string
  color: string
}

export interface ExportOptions {
  /** Title line under the drawing: circuit name, overlay, date. */
  caption?: string
  /** Colour key drawn above the diagram. */
  legend?: LegendEntry[]
  /** Flow units of white space around the drawing. */
  padding?: number
}

/** What the colours mean for the overlay that is on, so a report reader
 *  does not have to guess. Fault has kA badges that speak for themselves. */
export function legendFor(overlay: OverlayMode): LegendEntry[] {
  switch (overlay) {
    case 'voltage':
      return [
        { label: '< 0.95 pu', color: LOW_V },
        { label: '0.95–1.05 pu', color: OK },
        { label: '> 1.05 pu', color: VIOLATION },
        { label: 'de-energised', color: NEUTRAL },
      ]
    case 'loading':
      return [
        { label: '< 80 %', color: OK },
        { label: '80–100 %', color: WARN },
        { label: '≥ 100 %', color: VIOLATION },
      ]
    case 'phases':
      return PHASE_LEGEND
    default:
      return []
  }
}

export const OVERLAY_LABELS: Record<OverlayMode, string> = {
  voltage: 'Voltages',
  loading: 'Loading',
  power: 'Power',
  fault: 'Fault current',
  phases: 'Phases',
  off: '',
}

/** `circuit-phases.svg`: the name the user gave plus the overlay, so two
 *  exports of one circuit do not overwrite each other. */
export function imageFileName(name: string, overlay: OverlayMode, ext: 'svg' | 'png'): string {
  const base = (name || 'circuit').trim().replace(/[\\/:*?"<>|]+/g, '-')
  return overlay === 'off' ? `${base}.${ext}` : `${base}-${overlay}.${ext}`
}

/** The rotation a CSS transform applies, in degrees. Only the symbol wrapper
 *  rotates (0/90/180/270); everything else is translate-only, which reads
 *  as 0. */
export function rotationOf(transform: string): number {
  const m = /matrix\(([^)]+)\)/.exec(transform)
  if (!m) return 0
  const [a, b] = m[1].split(',').map(Number)
  const deg = (Math.atan2(b, a) * 180) / Math.PI
  return Math.abs(deg) < 0.01 ? 0 : deg
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

interface Box {
  x: number
  y: number
  w: number
  h: number
}

class Bounds {
  minX = Infinity
  minY = Infinity
  maxX = -Infinity
  maxY = -Infinity
  add(b: Box) {
    if (!(b.w > 0) && !(b.h > 0)) return
    this.minX = Math.min(this.minX, b.x)
    this.minY = Math.min(this.minY, b.y)
    this.maxX = Math.max(this.maxX, b.x + b.w)
    this.maxY = Math.max(this.maxY, b.y + b.h)
  }
  get empty() {
    return this.minX === Infinity
  }
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString()

/** SVG presentation attributes worth carrying over from computed style,
 *  with what a bare SVG assumes for each, so a value that is the default
 *  (or inherited from the parent) need not be written. */
const SVG_STYLE_DEFAULTS: Record<string, string> = {
  stroke: 'none',
  'stroke-width': '1',
  'stroke-dasharray': 'none',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  fill: 'rgb(0, 0, 0)',
  'fill-opacity': '1',
  'stroke-opacity': '1',
  opacity: '1',
  'font-family': '',
  'font-size': '',
  'font-weight': '400',
}

/** "1.8px" -> "1.8": presentation attributes take user units. */
const unitless = (v: string) => v.replace(/px$/, '')

/** Copy an on-screen <svg> with computed style inlined wherever it differs
 *  from what the element would inherit, so the copy looks the same without
 *  the page's stylesheet and stays about as small as the original. Class
 *  names go; they would mean nothing outside the app. */
function inlineSvg(src: SVGSVGElement): SVGSVGElement {
  const clone = src.cloneNode(true) as SVGSVGElement
  const srcAll = [src, ...src.querySelectorAll('*')]
  const cloneAll = [clone, ...clone.querySelectorAll('*')]
  srcAll.forEach((orig, i) => {
    const target = cloneAll[i]
    const cs = getComputedStyle(orig)
    const parent = orig === src ? null : getComputedStyle(orig.parentElement as Element)
    for (const prop of Object.keys(SVG_STYLE_DEFAULTS)) {
      const v = unitless(cs.getPropertyValue(prop))
      const inherited = parent ? unitless(parent.getPropertyValue(prop)) : SVG_STYLE_DEFAULTS[prop]
      // Only the outermost element pins fonts, and only text needs them.
      if (prop.startsWith('font') && orig.tagName !== 'text') continue
      if (v === inherited) continue
      target.setAttribute(prop, v)
    }
    target.removeAttribute('class')
    target.removeAttribute('style')
  })
  return clone
}

/** Elements of the canvas that are chrome, not drawing. */
const SKIP = ['react-flow__handle', 'react-flow__resize-control']

export function diagramToSvg(pane: HTMLElement, opts: ExportOptions = {}): string {
  const viewport = pane.querySelector('.react-flow__viewport') as HTMLElement | null
  if (!viewport) throw new Error('No diagram to export')
  const vpRect = viewport.getBoundingClientRect()
  const zoom = Number(/scale\(([^)]+)\)/.exec(viewport.style.transform)?.[1]) || 1
  const toFlow = (r: DOMRect): Box => ({
    x: (r.left - vpRect.left) / zoom,
    y: (r.top - vpRect.top) / zoom,
    w: r.width / zoom,
    h: r.height / zoom,
  })

  const parts: string[] = []
  const bounds = new Bounds()
  const serializer = new XMLSerializer()

  // --- edges: paths already in flow coordinates ---------------------------
  for (const path of viewport.querySelectorAll<SVGPathElement>('.react-flow__edge-path')) {
    const cs = getComputedStyle(path)
    const dash = cs.strokeDasharray !== 'none' ? ` stroke-dasharray="${cs.strokeDasharray}"` : ''
    parts.push(
      `<path d="${path.getAttribute('d') ?? ''}" fill="none" stroke="${cs.stroke}" ` +
        `stroke-width="${unitless(cs.strokeWidth)}"${dash}/>`,
    )
    const bb = path.getBBox()
    bounds.add({ x: bb.x, y: bb.y, w: bb.width, h: bb.height })
  }

  // --- HTML: labels, badges, chips, busbars; symbols as nested <svg> -------
  const walk = (el: Element, rotation: number, opacity: number) => {
    if (SKIP.some((c) => el.classList.contains(c))) return
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    const own = Number(cs.opacity)
    const alpha = opacity * (Number.isFinite(own) ? own : 1)
    if (alpha <= 0.01) return
    const opacityAttr = alpha < 0.999 ? ` opacity="${fmt(alpha)}"` : ''

    if (el instanceof SVGSVGElement) {
      // Its own width/height are the unrotated size; the client rect is the
      // rotated box, whose centre is the rotation centre.
      const r = toFlow(el.getBoundingClientRect())
      const w = Number(el.getAttribute('width')) || r.w
      const h = Number(el.getAttribute('height')) || r.h
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      const copy = inlineSvg(el)
      copy.setAttribute('x', fmt(cx - w / 2))
      copy.setAttribute('y', fmt(cy - h / 2))
      copy.setAttribute('width', fmt(w))
      copy.setAttribute('height', fmt(h))
      copy.removeAttribute('xmlns')
      const rot = rotation ? ` transform="rotate(${fmt(rotation)} ${fmt(cx)} ${fmt(cy)})"` : ''
      parts.push(`<g${rot}${opacityAttr}>${serializer.serializeToString(copy)}</g>`)
      bounds.add(r)
      return
    }

    const rotHere = rotation + rotationOf(cs.transform)

    // A coloured box behind whatever the element holds.
    const bg = cs.backgroundColor
    const border = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'
    if ((bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') || border) {
      const r = toFlow(el.getBoundingClientRect())
      const radius = cs.borderTopLeftRadius
      const rx = radius.endsWith('%')
        ? (Math.min(r.w, r.h) * parseFloat(radius)) / 100
        : parseFloat(radius) || 0
      const fill = bg && bg !== 'transparent' ? bg : 'none'
      const stroke = border
        ? ` stroke="${cs.borderTopColor}" stroke-width="${parseFloat(cs.borderTopWidth)}"`
        : ''
      parts.push(
        `<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}" ` +
          `rx="${fmt(rx)}" fill="${fill}"${stroke}${opacityAttr}/>`,
      )
      bounds.add(r)
    }

    // The element's own text, one <text> per run of adjacent text nodes
    // ("600" and " kW" are two nodes of one label), placed by the exact box
    // the browser laid the run out in.
    const nodes = [...el.childNodes]
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType !== Node.TEXT_NODE) continue
      let j = i
      while (j + 1 < nodes.length && nodes[j + 1].nodeType === Node.TEXT_NODE) j++
      const range = document.createRange()
      range.setStartBefore(nodes[i])
      range.setEndAfter(nodes[j])
      const text = range.toString().replace(/\s+/g, ' ').trim()
      i = j
      if (!text) continue
      const r = toFlow(range.getBoundingClientRect())
      if (!(r.w > 0)) continue
      const size = parseFloat(cs.fontSize)
      const spacing =
        cs.letterSpacing && cs.letterSpacing !== 'normal'
          ? ` letter-spacing="${cs.letterSpacing}"`
          : ''
      parts.push(
        `<text x="${fmt(r.x + r.w / 2)}" y="${fmt(r.y + r.h / 2)}" text-anchor="middle" ` +
          `dominant-baseline="central" font-family="${esc(cs.fontFamily)}" font-size="${fmt(size)}" ` +
          `font-weight="${cs.fontWeight}" fill="${cs.color}"${spacing}${opacityAttr}>` +
          `${esc(text)}</text>`,
      )
      bounds.add(r)
    }

    for (const child of el.children) walk(child, rotHere, alpha)
  }

  const labels = viewport.querySelector('.react-flow__edgelabel-renderer')
  if (labels) for (const child of labels.children) walk(child, 0, 1)
  for (const node of viewport.querySelectorAll('.react-flow__node')) walk(node, 0, 1)

  if (bounds.empty) throw new Error('No diagram to export')

  // --- frame: padding, legend above, caption below ------------------------
  const pad = opts.padding ?? 24
  let minX = bounds.minX - pad
  let minY = bounds.minY - pad
  let maxX = bounds.maxX + pad
  let maxY = bounds.maxY + pad
  const chrome: string[] = []
  const font = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"'

  if (opts.legend?.length) {
    const rowH = 22
    minY -= rowH
    let x = minX + pad
    const y = minY + pad / 2 + rowH / 2
    for (const e of opts.legend) {
      chrome.push(
        `<rect x="${fmt(x)}" y="${fmt(y - 2)}" width="16" height="4" rx="2" fill="${e.color}"/>`,
        `<text x="${fmt(x + 22)}" y="${fmt(y)}" dominant-baseline="central" ${font} ` +
          `font-size="12" fill="#333">${esc(e.label)}</text>`,
      )
      x += 22 + e.label.length * 6.8 + 18
    }
    maxX = Math.max(maxX, x + pad)
  }
  if (opts.caption) {
    const rowH = 20
    chrome.push(
      `<text x="${fmt(minX + pad)}" y="${fmt(maxY + rowH / 2)}" dominant-baseline="central" ` +
        `${font} font-size="12" fill="#667">${esc(opts.caption)}</text>`,
    )
    maxY += rowH + pad / 2
  }

  const w = maxX - minX
  const h = maxY - minY
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}" height="${fmt(h)}" ` +
    `viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(w)} ${fmt(h)}">\n` +
    `<rect x="${fmt(minX)}" y="${fmt(minY)}" width="${fmt(w)}" height="${fmt(h)}" fill="#ffffff"/>\n` +
    chrome.join('\n') +
    '\n' +
    parts.join('\n') +
    '\n</svg>\n'
  )
}

/** Rasterise an SVG string. `scale` is device pixels per flow unit: 2 gives
 *  a crisp figure in a report at ordinary sizes, without a giant file. */
export function svgToPng(svg: string, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const size = /<svg [^>]*width="([\d.]+)" height="([\d.]+)"/.exec(svg)
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    const img = new Image()
    img.onload = () => {
      try {
        const w = Math.ceil((size ? Number(size[1]) : img.width) * scale)
        const h = Math.ceil((size ? Number(size[2]) : img.height) * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas is not available')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png')
      } catch (err) {
        reject(err)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('The browser could not render the SVG'))
    }
    img.src = url
  })
}
