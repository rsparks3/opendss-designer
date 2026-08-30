import { useEffect, useMemo, useRef, useState } from 'react'
import { fmt, ticks } from '../lib/axis'
import {
  computeTimeSeries,
  defaultTsEntities,
  TS_QUANTITIES,
  tsEntities,
  type TimeSeriesLine,
} from '../lib/graph'
import { decimate } from '../lib/shapeCsv'
import { useResultsStore } from '../store/resultsStore'
import type { TimeSeriesResult } from '../types/circuit'

const ML = 60
const MR = 18
const MT = 30
const MB = 36

const SIZE_KEY = 'opendss-designer.graphSize' // shared with the snapshot chart
const DEFAULT_SIZE = { w: 800, h: 340 }
const MIN_W = 360
const MAX_W = 1800
const MIN_H = 200
const MAX_H = 1000
const MAX_SERIES = 8

/** Trace colors: the classic OpenDSS phase trio first, then distinct extras. */
const TRACE_COLORS = ['#1a1a1a', '#d32f2f', '#1565c0', '#2e7d32', '#ef6c00',
  '#6a1b9a', '#5d4037', '#00838f']

/** Hour of year at each month start (non-leap), for yearly-axis labels. */
const MONTH_STARTS = [0, 744, 1416, 2160, 2880, 3624, 4344, 5088, 5832, 6552, 7296, 8016]
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type Domain = { x: [number, number]; y: [number, number] }

function initialSize(): { w: number; h: number } {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? '')
    if (v && v.w >= MIN_W && v.w <= MAX_W && v.h >= MIN_H && v.h <= MAX_H) return v
  } catch {
    // unset or corrupt
  }
  return DEFAULT_SIZE
}

function fmtHour(h: number, mode: 'daily' | 'yearly'): string {
  if (mode === 'daily') return `${h.toFixed(2)} h`
  const m = MONTH_STARTS.filter((s) => s <= h).length - 1
  const day = Math.floor((h - MONTH_STARTS[Math.max(m, 0)]) / 24) + 1
  return `${MONTH_NAMES[Math.max(m, 0)]} ${day}, h ${h.toFixed(1)}`
}

function SummaryTable({ ts }: { ts: TimeSeriesResult }) {
  const s = ts.summary
  if (!s) return null
  const busName = (b: string) => ts.busNames[b] ?? b
  return (
    <table className="ts-summary">
      <tbody>
        <tr>
          <td>Energy served</td>
          <td>{(s.energyKwh / 1000).toFixed(1)} MWh</td>
          <td>Losses</td>
          <td>
            {(s.lossesKwh / 1000).toFixed(2)} MWh
            {s.energyKwh > 0 ? ` (${((100 * s.lossesKwh) / s.energyKwh).toFixed(2)}%)` : ''}
          </td>
          <td>Peak</td>
          <td>
            {(s.peakKw / 1000).toFixed(2)} MW @ {fmtHour(s.peakHour, ts.mode)}
          </td>
        </tr>
        <tr>
          <td>Min V</td>
          <td>
            {s.minVpu ? `${s.minVpu.value} pu @ ${busName(s.minVpu.bus)}, ${fmtHour(s.minVpu.hour, ts.mode)}` : '—'}
          </td>
          <td>Max V</td>
          <td>
            {s.maxVpu ? `${s.maxVpu.value} pu @ ${busName(s.maxVpu.bus)}, ${fmtHour(s.maxVpu.hour, ts.mode)}` : '—'}
          </td>
          <td>Steps</td>
          <td>
            {ts.steps} × {ts.stepMin} min
            {ts.nonConvergedSteps.length > 0 && (
              <span className="ts-warn"> · {ts.nonConvergedSteps.length} not converged</span>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

/** Time-mode chart: quantities over simulation hours, one polyline per
 *  selected bus/element, with the snapshot chart's zoom/pan interactions. */
export function TimeGraphPanel({ ts }: { ts: TimeSeriesResult }) {
  const stale = useResultsStore((s) => s.stale)
  const [quantity, setQuantity] = useState('totalkw')
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [domain, setDomain] = useState<Domain | null>(null)
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [hover, setHover] = useState<{
    line: TimeSeriesLine
    px: number
    py: number
    pt: { x: number; y: number }
  } | null>(null)
  const [size, setSize] = useState(initialSize)
  const sizeRef = useRef(size)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ mode: 'pan' | 'box'; px: number; py: number; dom: Domain } | null>(null)

  const W = size.w
  const H = size.h
  const PLOT_W = W - ML - MR
  const PLOT_H = H - MT - MB

  const q = TS_QUANTITIES.find((x) => x.key === quantity)!
  const isVoltage = quantity === 'vmin' || quantity === 'vmax'
  const entities = useMemo(() => tsEntities(ts, q.kind), [ts, q.kind])
  const selected = useMemo(
    () => picked[q.kind] ?? defaultTsEntities(ts, q.kind),
    [picked, q.kind, ts],
  )
  useEffect(() => setDomain(null), [quantity, selected])

  const lines = useMemo(
    () => computeTimeSeries(ts, quantity, selected),
    [ts, quantity, selected],
  )

  const autoDomain = useMemo<Domain | null>(() => {
    let xLo = Infinity
    let xHi = -Infinity
    let yLo = Infinity
    let yHi = -Infinity
    for (const l of lines) {
      for (const p of l.points) {
        if (p.x < xLo) xLo = p.x
        if (p.x > xHi) xHi = p.x
        if (p.y < yLo) yLo = p.y
        if (p.y > yHi) yHi = p.y
      }
    }
    if (!Number.isFinite(xLo) || xHi <= xLo) return null
    if (isVoltage) {
      yLo = Math.min(0.945, yLo - 0.005)
      yHi = Math.max(1.055, yHi + 0.005)
    } else {
      const pad = (yHi - yLo) * 0.06 || Math.abs(yHi) * 0.06 || 0.5
      yLo -= pad
      yHi += pad
    }
    return { x: [xLo, xHi], y: [yLo, yHi] }
  }, [lines, isVoltage])

  const startSizeDrag = (down: React.PointerEvent) => {
    down.preventDefault()
    down.stopPropagation()
    const startX = down.clientX
    const startY = down.clientY
    const start = sizeRef.current
    const move = (e: PointerEvent) => {
      const next = {
        w: Math.min(Math.max(start.w + (e.clientX - startX), MIN_W), MAX_W),
        h: Math.min(Math.max(start.h + (e.clientY - startY), MIN_H), MAX_H),
      }
      sizeRef.current = next
      setSize(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify(sizeRef.current))
      } catch {
        // storage unavailable
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const togglePick = (id: string) => {
    const cur = selected
    const next = cur.includes(id)
      ? cur.filter((x) => x !== id)
      : cur.length >= MAX_SERIES
        ? cur
        : [...cur, id]
    setPicked({ ...picked, [q.kind]: next })
  }

  const controls = (
    <div className="graph-controls">
      <label>
        Quantity
        <select aria-label="Quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)}>
          <optgroup label="System">
            {TS_QUANTITIES.filter((x) => x.kind === 'system').map((x) => (
              <option key={x.key} value={x.key}>{x.label}</option>
            ))}
          </optgroup>
          <optgroup label="Buses">
            {TS_QUANTITIES.filter((x) => x.kind === 'bus').map((x) => (
              <option key={x.key} value={x.key}>{x.label}</option>
            ))}
          </optgroup>
          <optgroup label="Elements">
            {TS_QUANTITIES.filter((x) => x.kind === 'element').map((x) => (
              <option key={x.key} value={x.key}>{x.label}</option>
            ))}
          </optgroup>
        </select>
      </label>
      {q.kind !== 'system' && (
        <details className="ts-picker">
          <summary>
            {q.kind === 'bus' ? 'Buses' : 'Elements'} ({selected.length})
          </summary>
          <div className="ts-picker-list">
            {entities.map((e) => (
              <label key={e.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(e.id)}
                  disabled={!selected.includes(e.id) && selected.length >= MAX_SERIES}
                  onChange={() => togglePick(e.id)}
                />
                {e.label}
              </label>
            ))}
          </div>
        </details>
      )}
      <span className="graph-zoom">
        <button title="Zoom in" onClick={() => zoomAbout(0.7)}>＋</button>
        <button title="Zoom out" onClick={() => zoomAbout(1.4)}>－</button>
        <button title="Reset view (or double-click the plot)" onClick={() => setDomain(null)}>⤢ fit</button>
      </span>
      <span className="graph-hint">drag = pan · Shift+drag = zoom box · wheel = zoom</span>
    </div>
  )

  if (!autoDomain) {
    return (
      <div className="vp-wrap">
        {controls}
        <div className="bp-empty">No plottable data in this run.</div>
      </div>
    )
  }

  const dom = domain ?? autoDomain
  const [xLo, xHi] = dom.x
  const [yLo, yHi] = dom.y
  const x = (v: number) => ML + ((v - xLo) / (xHi - xLo)) * PLOT_W
  const y = (v: number) => MT + (1 - (v - yLo) / (yHi - yLo)) * PLOT_H

  // Clip to the domain, decimate to ~2 px resolution, project to pixels.
  const drawn = lines.map((line) => {
    const inView = line.points.filter((p) => p.x >= xLo && p.x <= xHi)
    const dec = decimate(inView, 2 * PLOT_W)
    return {
      line,
      color: TRACE_COLORS[line.colorIdx % TRACE_COLORS.length],
      pts: dec.map((p) => ({ sx: x(p.x), sy: y(p.y), src: p })),
    }
  })

  function toPx(e: { clientX: number; clientY: number }): { px: number; py: number } {
    const rect = svgRef.current!.getBoundingClientRect()
    return { px: ((e.clientX - rect.left) / rect.width) * W, py: ((e.clientY - rect.top) / rect.height) * H }
  }
  function zoomAbout(factor: number, cx?: number, cy?: number) {
    const d = domain ?? autoDomain
    if (!d) return
    const fx = cx ?? (d.x[0] + d.x[1]) / 2
    const fy = cy ?? (d.y[0] + d.y[1]) / 2
    setDomain({
      x: [fx - (fx - d.x[0]) * factor, fx + (d.x[1] - fx) * factor],
      y: [fy - (fy - d.y[0]) * factor, fy + (d.y[1] - fy) * factor],
    })
  }
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    const { px, py } = toPx(e)
    dragRef.current = { mode: e.shiftKey ? 'box' : 'pan', px, py, dom }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    const { px, py } = toPx(e)
    if (drag) {
      setHover(null)
      if (drag.mode === 'box') {
        setBox({ x0: drag.px, y0: drag.py, x1: px, y1: py })
      } else {
        const dx = ((px - drag.px) / PLOT_W) * (drag.dom.x[1] - drag.dom.x[0])
        const dy = ((py - drag.py) / PLOT_H) * (drag.dom.y[1] - drag.dom.y[0])
        setDomain({
          x: [drag.dom.x[0] - dx, drag.dom.x[1] - dx],
          y: [drag.dom.y[0] + dy, drag.dom.y[1] + dy],
        })
      }
      return
    }
    // Nearest visible point across the drawn (decimated) series.
    let best: typeof hover = null
    let bestD = 20 ** 2 // only within 20px
    for (const l of drawn) {
      for (const p of l.pts) {
        const d = (p.sx - px) ** 2 + (p.sy - py) ** 2
        if (d < bestD) {
          bestD = d
          best = { line: l.line, px: e.clientX, py: e.clientY, pt: p.src }
        }
      }
    }
    setHover(best)
  }
  const onPointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.mode === 'box' && box && Math.abs(box.x1 - box.x0) > 8 && Math.abs(box.y1 - box.y0) > 8) {
      const dataX = (px: number) => xLo + ((px - ML) / PLOT_W) * (xHi - xLo)
      const dataY = (py: number) => yHi - ((py - MT) / PLOT_H) * (yHi - yLo)
      setDomain({
        x: [dataX(Math.min(box.x0, box.x1)), dataX(Math.max(box.x0, box.x1))],
        y: [dataY(Math.max(box.y0, box.y1)), dataY(Math.min(box.y0, box.y1))],
      })
    }
    setBox(null)
  }
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const { px, py } = toPx(e)
    const cx = xLo + ((px - ML) / PLOT_W) * (xHi - xLo)
    const cy = yHi - ((py - MT) / PLOT_H) * (yHi - yLo)
    zoomAbout(e.deltaY > 0 ? 1.15 : 0.87, cx, cy)
  }

  const yearly = ts.mode === 'yearly'
  const useMonths = yearly && xHi - xLo > 1000
  const xTicks = useMonths
    ? MONTH_STARTS.filter((h) => h >= xLo && h <= xHi)
    : ticks(xLo, xHi)
  const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : 1
  const yTicks = ticks(yLo, yHi)
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1

  return (
    <div className="vp-wrap" style={{ opacity: stale ? 0.5 : 1 }}>
      {controls}
      <SummaryTable ts={ts} />
      <div className="vp-frame-box">
        <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
             className="vp-chart classic" role="img"
             aria-label={`${q.label} over ${ts.mode} simulation time`}
             onPointerDown={onPointerDown} onPointerMove={onPointerMove}
             onPointerUp={onPointerUp} onPointerLeave={() => setHover(null)}
             onDoubleClick={() => setDomain(null)} onWheel={onWheel}>
          <defs>
            <clipPath id="ts-plot-clip">
              <rect x={ML} y={MT} width={PLOT_W} height={PLOT_H} />
            </clipPath>
          </defs>
          <rect x={0} y={0} width={W} height={H} className="vp-paper" />
          <text x={ML} y={MT - 10} className="vp-title">{q.label}</text>
          <text x={W - MR} y={MT - 10} className="vp-title" textAnchor="end">
            {ts.mode === 'daily' ? 'Daily simulation' : 'Yearly simulation'}
            {ts.downsampled ? ' (envelope)' : ''}
          </text>
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={ML} x2={W - MR} y1={y(t)} y2={y(t)} className="vp-grid" clipPath="url(#ts-plot-clip)" />
              <line x1={ML - 4} x2={ML} y1={y(t)} y2={y(t)} className="vp-frame-tick" />
              <text x={ML - 8} y={y(t) + 3.5} className="vp-tick classic" textAnchor="end">
                {fmt(t, yStep)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={x(t)} x2={x(t)} y1={H - MB} y2={H - MB + 4} className="vp-frame-tick" />
              <text x={x(t)} y={H - MB + 16} className="vp-tick classic" textAnchor="middle">
                {useMonths ? MONTH_NAMES[MONTH_STARTS.indexOf(t)] : fmt(t, xStep)}
              </text>
            </g>
          ))}
          <text x={ML + PLOT_W / 2} y={H - 4} className="vp-axis-label classic" textAnchor="middle">
            {useMonths ? 'Month' : yearly ? 'Hour of year' : 'Hour'}
          </text>
          <g clipPath="url(#ts-plot-clip)">
            {isVoltage &&
              [0.95, 1.05].map((t) => (
                <line key={t} x1={ML} x2={W - MR} y1={y(t)} y2={y(t)} className="vp-limit" />
              ))}
            {drawn.map((d) => (
              <polyline
                key={d.line.id}
                points={d.pts.map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ')}
                fill="none"
                stroke={d.color}
                className="vp-trace"
              />
            ))}
            {hover && (
              <circle cx={x(hover.pt.x)} cy={y(hover.pt.y)} r={4.5}
                      fill={TRACE_COLORS[hover.line.colorIdx % TRACE_COLORS.length]}
                      className="vp-dot" />
            )}
          </g>
          <rect x={ML} y={MT} width={PLOT_W} height={PLOT_H} className="vp-frame" />
          {box && (
            <rect x={Math.min(box.x0, box.x1)} y={Math.min(box.y0, box.y1)}
                  width={Math.abs(box.x1 - box.x0)} height={Math.abs(box.y1 - box.y0)}
                  className="vp-zoombox" />
          )}
        </svg>
        <div
          className="vp-resize-grip"
          title="Drag to resize the chart · double-click to reset"
          onPointerDown={startSizeDrag}
          onDoubleClick={() => {
            sizeRef.current = DEFAULT_SIZE
            setSize(DEFAULT_SIZE)
            try {
              localStorage.removeItem(SIZE_KEY)
            } catch {
              // storage unavailable
            }
          }}
        >
          ◢
        </div>
      </div>
      {lines.length > 1 && (
        <div className="ts-legend">
          {drawn.map((d) => (
            <span key={d.line.id} style={{ color: d.color }}>
              ━ {ts.busNames[d.line.label] ?? d.line.label}
            </span>
          ))}
        </div>
      )}
      {hover && (
        <div className="result-tooltip" style={{ left: hover.px + 14, top: hover.py + 14 }}>
          <div className="rt-title">{ts.busNames[hover.line.label] ?? hover.line.label}</div>
          <table>
            <tbody>
              <tr><td>time</td><td>{fmtHour(hover.pt.x, ts.mode)}</td></tr>
              <tr><td>{q.label}</td><td>{hover.pt.y.toFixed(isVoltage ? 4 : 1)}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
