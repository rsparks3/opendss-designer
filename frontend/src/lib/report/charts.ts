/** The report's charts as standalone SVG: fixed size, light paper, every
 *  style an attribute, so the PDF writer and the workbook's image both draw
 *  them without the app's stylesheet. Kept apart from the interactive Graph
 *  tab, which is built for a screen rather than a page. */
import type { LimitsJSON, SolveResult, TimeSeriesResult } from '../../types/circuit'
import { fmt, niceStep, ticks } from '../axis'
import { formatAmps, formatSeconds, logTicks, type TccDevice, type TccResult, type TccTrace } from '../tcc'

/** How the report names what the engine returns in lower case. */
export interface Naming {
  device: (d: TccDevice) => string
  bus: (key: string | null) => string
}

const PLAIN: Naming = { device: (d) => d.name, bus: (b) => b ?? '' }

/** A trace's own part of its label ("rec1 fast" -> "fast"). */
export function traceUnit(d: TccDevice, t: TccTrace): string {
  const label = t.label.trim()
  const own = label.toLowerCase().startsWith(d.name.toLowerCase()) ? label.slice(d.name.length).trim() : label
  return own || t.curve
}

export const CHART_W = 720
export const CHART_H = 380
const M = { l: 64, r: 24, t: 20, b: 46 }
const INK = '#1f2328'
const GRID = '#d8dce2'
const MUTED = '#57606a'
const LIMIT = '#d32f2f'
const FONT = 'font-family="Helvetica, Arial, sans-serif"'
/** Categorical colours, distinct in print and for colour-blind readers. */
export const SERIES_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2']

const f = (n: number) => (Math.round(n * 10) / 10).toString()
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function frame(body: string[], extraRight = 0): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_W + extraRight}" height="${CHART_H}" ` +
    `viewBox="0 0 ${CHART_W + extraRight} ${CHART_H}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>${body.join('')}</svg>`
  )
}

const text = (x: number, y: number, s: string, anchor = 'middle', size = 11, fill = MUTED, extra = '') =>
  `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" ${FONT} font-size="${size}" fill="${fill}"${extra}>${esc(s)}</text>`

const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1, dash = '') =>
  `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`

const polyline = (pts: [number, number][], stroke: string, width = 1.6) =>
  `<polyline points="${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round"/>`

interface Axis {
  lo: number
  hi: number
  log?: boolean
}

function scale(a: Axis, from: number, to: number) {
  if (a.log) {
    const l0 = Math.log10(a.lo)
    const l1 = Math.log10(a.hi)
    return (v: number) => from + ((Math.log10(Math.max(v, a.lo)) - l0) / (l1 - l0)) * (to - from)
  }
  return (v: number) => from + ((v - a.lo) / (a.hi - a.lo || 1)) * (to - from)
}

/** Voltage along the feeder: each bus's lowest and highest phase against
 *  its distance from the source, with the planning limits. */
export function profileSvg(solve: SolveResult, limits: LimitsJSON): string | null {
  const dist = solve.busDistances ?? {}
  const pts = Object.entries(solve.buses)
    .filter(([b, r]) => dist[b] != null && r.vmaxPu != null && r.vmaxPu > 0.05)
    .map(([b, r]) => ({ bus: b, d: dist[b], lo: r.vminPu ?? r.vmaxPu!, hi: r.vmaxPu! }))
  if (pts.length < 2) return null
  const xHi = Math.max(...pts.map((p) => p.d)) || 1
  const yLo = Math.min(limits.vminPu - 0.01, ...pts.map((p) => p.lo)) - 0.005
  const yHi = Math.max(limits.vmaxPu + 0.01, ...pts.map((p) => p.hi)) + 0.005
  const x = scale({ lo: 0, hi: xHi }, M.l, CHART_W - M.r)
  const y = scale({ lo: yLo, hi: yHi }, CHART_H - M.b, M.t)
  const body: string[] = []
  axes(body, ticks(0, xHi, 8), ticks(yLo, yHi, 6), x, y, 'Distance from source (km)', 'Voltage (pu)')
  for (const v of [limits.vminPu, limits.vmaxPu]) {
    body.push(line(M.l, y(v), CHART_W - M.r, y(v), LIMIT, 1.2, '6 4'))
  }
  const byBus = new Map(pts.map((p) => [p.bus, p]))
  for (const [a, b] of Object.values(solve.lineBuses)) {
    const p = byBus.get(a)
    const q = byBus.get(b)
    if (p && q) {
      body.push(line(x(p.d), y(p.lo), x(q.d), y(q.lo), SERIES_COLORS[0], 1.4))
      body.push(line(x(p.d), y(p.hi), x(q.d), y(q.hi), SERIES_COLORS[4], 1, '3 2'))
    }
  }
  for (const p of pts) {
    body.push(`<circle cx="${f(x(p.d))}" cy="${f(y(p.lo))}" r="2.6" fill="${SERIES_COLORS[0]}"/>`)
    if (p.hi - p.lo > 0.0005) body.push(`<circle cx="${f(x(p.d))}" cy="${f(y(p.hi))}" r="2" fill="${SERIES_COLORS[4]}"/>`)
  }
  legend(body, [
    ['Lowest phase', SERIES_COLORS[0]],
    ['Highest phase', SERIES_COLORS[4], '3 2'],
    ['Limits', LIMIT, '6 4'],
  ])
  return frame(body)
}

/** Every protective element's time-current curve on log-log paper, with the
 *  fault current available at each device. */
export function tccSvg(tcc: TccResult, naming: Naming = PLAIN): string | null {
  const traces = tcc.devices.flatMap((d) => d.traces.map((t) => ({ device: d, trace: t })))
  const pts = traces.flatMap(({ trace }) => trace.points)
  if (!pts.length) return null
  const faults = tcc.devices.flatMap((d) => [d.faultA3ph, d.faultA1ph]).filter((a): a is number => !!a && a > 0)
  const ampsLo = 10 ** Math.floor(Math.log10(Math.min(...pts.map((p) => p[0]))))
  const ampsHi = 10 ** Math.ceil(Math.log10(Math.max(...pts.map((p) => p[0]), ...faults)))
  const sLo = 0.01
  const sHi = 1000
  const legendW = 190
  const right = CHART_W - M.r
  const x = scale({ lo: ampsLo, hi: ampsHi, log: true }, M.l, right)
  const y = scale({ lo: sLo, hi: sHi, log: true }, CHART_H - M.b, M.t)
  const body: string[] = []
  for (const t of logTicks(ampsLo, ampsHi)) {
    body.push(line(x(t.v), M.t, x(t.v), CHART_H - M.b, GRID, t.major ? 0.9 : 0.4))
    if (t.major) body.push(text(x(t.v), CHART_H - M.b + 16, formatAmps(t.v)))
  }
  for (const t of logTicks(sLo, sHi)) {
    body.push(line(M.l, y(t.v), right, y(t.v), GRID, t.major ? 0.9 : 0.4))
    if (t.major) body.push(text(M.l - 6, y(t.v) + 4, formatSeconds(t.v), 'end'))
  }
  body.push(`<rect x="${M.l}" y="${M.t}" width="${right - M.l}" height="${CHART_H - M.b - M.t}" fill="none" stroke="${INK}" stroke-width="1"/>`)
  body.push(text((M.l + right) / 2, CHART_H - 8, 'Current (A)', 'middle', 12, INK))
  body.push(text(16, (M.t + CHART_H - M.b) / 2, 'Time (s)', 'middle', 12, INK, ` transform="rotate(-90 16 ${f((M.t + CHART_H - M.b) / 2)})"`))
  // One colour per device, as the Graph tab draws it; ground units dashed.
  const colorOf = (d: TccDevice) => SERIES_COLORS[tcc.devices.indexOf(d) % SERIES_COLORS.length]
  const entries: [string, string, boolean][] = []
  for (const { device, trace } of traces) {
    const color = colorOf(device)
    const drawn = trace.points.filter(([a, s]) => a >= ampsLo && a <= ampsHi && s >= sLo && s <= sHi)
    const ground = trace.fault === 'ground'
    if (drawn.length >= 2) {
      const pl = polyline(drawn.map(([a, s]) => [x(a), y(s)]), color, 1.8)
      body.push(ground ? pl.replace('/>', ' stroke-dasharray="5 3"/>') : pl)
    }
    entries.push([`${naming.device(device)} ${traceUnit(device, trace)}`, color, ground])
  }
  // The fault available at each device's bus, once per bus.
  const buses = new Map<string, number>()
  for (const d of tcc.devices) if (d.faultA3ph) buses.set(d.bus ?? d.name, d.faultA3ph)
  ;[...buses].forEach(([bus, amps], i) => {
    body.push(line(x(amps), M.t, x(amps), CHART_H - M.b, MUTED, 0.8, '2 3'))
    body.push(text(x(amps) + 3, M.t + 12 + i * 11, `3φ fault at ${naming.bus(bus)}`, 'start', 9))
  })
  // Legend to the right of the plot.
  entries.forEach(([label, color, ground], i) => {
    const ly = M.t + 8 + i * 16
    body.push(line(right + 12, ly, right + 34, ly, color, 2, ground ? '5 3' : ''))
    body.push(text(right + 40, ly + 4, label, 'start', 10, INK))
  })
  return frame(body, legendW)
}

/** Demand and losses over a time-series run, losses on their own axis. */
export function timeSeriesSvg(ts: TimeSeriesResult): string | null {
  if (ts.time.length < 2) return null
  const t0 = ts.time[0]
  const t1 = ts.time[ts.time.length - 1]
  const kw = ts.totals.kw
  const loss = ts.totals.lossKw
  const kwHi = Math.max(...kw, 1) * 1.08
  const lossHi = Math.max(...loss, 0.001) * 1.08
  const right = CHART_W - M.r - 40
  const x = scale({ lo: t0, hi: t1 }, M.l, right)
  const y = scale({ lo: 0, hi: kwHi }, CHART_H - M.b, M.t)
  const yl = scale({ lo: 0, hi: lossHi }, CHART_H - M.b, M.t)
  const body: string[] = []
  const xt = ticks(t0, t1, ts.mode === 'yearly' ? 12 : 12)
  axes(body, xt, ticks(0, kwHi, 6), x, y, 'Hour', 'Demand (kW)', right)
  for (const v of ticks(0, lossHi, 6)) {
    body.push(text(right + 6, yl(v) + 4, fmt(v, niceStep(lossHi / 6)), 'start', 11, SERIES_COLORS[1]))
  }
  body.push(text(CHART_W - 10, (M.t + CHART_H - M.b) / 2, 'Losses (kW)', 'middle', 12, SERIES_COLORS[1], ` transform="rotate(90 ${CHART_W - 10} ${f((M.t + CHART_H - M.b) / 2)})"`))
  body.push(polyline(ts.time.map((t, i) => [x(t), y(kw[i] ?? 0)]), SERIES_COLORS[0]))
  body.push(polyline(ts.time.map((t, i) => [x(t), yl(loss[i] ?? 0)]), SERIES_COLORS[1], 1.2))
  legend(body, [
    ['Demand at the source', SERIES_COLORS[0]],
    ['Losses', SERIES_COLORS[1]],
  ])
  return frame(body)
}

function axes(
  body: string[],
  xs: number[],
  ys: number[],
  x: (v: number) => number,
  y: (v: number) => number,
  xLabel: string,
  yLabel: string,
  right = CHART_W - M.r,
) {
  const xStep = xs.length > 1 ? xs[1] - xs[0] : 1
  const yStep = ys.length > 1 ? ys[1] - ys[0] : 1
  for (const v of xs) {
    body.push(line(x(v), M.t, x(v), CHART_H - M.b, GRID, 0.6))
    body.push(text(x(v), CHART_H - M.b + 16, fmt(v, xStep)))
  }
  for (const v of ys) {
    body.push(line(M.l, y(v), right, y(v), GRID, 0.6))
    body.push(text(M.l - 6, y(v) + 4, fmt(v, yStep), 'end'))
  }
  body.push(`<rect x="${M.l}" y="${M.t}" width="${f(right - M.l)}" height="${CHART_H - M.b - M.t}" fill="none" stroke="${INK}" stroke-width="1"/>`)
  body.push(text((M.l + right) / 2, CHART_H - 8, xLabel, 'middle', 12, INK))
  const cy = (M.t + CHART_H - M.b) / 2
  body.push(text(16, cy, yLabel, 'middle', 12, INK, ` transform="rotate(-90 16 ${f(cy)})"`))
}

function legend(body: string[], entries: [string, string, string?][]) {
  let lx = M.l + 10
  const ly = M.t + 14
  const w = entries.reduce((s, [label]) => s + 34 + label.length * 6, 0)
  body.push(`<rect x="${M.l + 4}" y="${M.t + 4}" width="${f(w)}" height="18" fill="#ffffff" fill-opacity="0.85"/>`)
  for (const [label, color, dash] of entries) {
    body.push(line(lx, ly, lx + 18, ly, color, 2, dash))
    body.push(text(lx + 24, ly + 4, label, 'start', 10, INK))
    lx += 34 + label.length * 6
  }
}
