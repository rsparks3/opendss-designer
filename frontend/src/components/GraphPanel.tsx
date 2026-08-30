import { useEffect, useMemo, useRef, useState } from 'react'
import { computeGraph, X_QUANTITIES, Y_QUANTITIES, type GraphRow } from '../lib/graph'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'

const ML = 60
const MR = 18
const MT = 30
const MB = 36

const SIZE_KEY = 'opendss-designer.graphSize'
const DEFAULT_SIZE = { w: 800, h: 340 }
const MIN_W = 360
const MAX_W = 1800
const MIN_H = 200
const MAX_H = 1000

function initialSize(): { w: number; h: number } {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? '')
    if (v && v.w >= MIN_W && v.w <= MAX_W && v.h >= MIN_H && v.h <= MAX_H) return v
  } catch {
    // unset or corrupt
  }
  return DEFAULT_SIZE
}

/** OpenDSS phase color convention: 1 = black, 2 = red, 3 = blue. */
const PHASE_COLORS: Record<number, string> = { 1: '#1a1a1a', 2: '#d32f2f', 3: '#1565c0' }

type Domain = { x: [number, number]; y: [number, number] }

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1))
  const norm = raw / mag
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag
}

function fmt(v: number, step: number): string {
  if (step < 0.005) return v.toFixed(4)
  if (step < 0.05) return v.toFixed(3)
  if (step < 0.5) return v.toFixed(2)
  if (step < 5) return v.toFixed(1)
  return v.toFixed(0)
}

function ticks(lo: number, hi: number, count = 5): number[] {
  const step = niceStep((hi - lo) / count)
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(t)
  return out
}

/** OpenDSS-style plot window: per-phase traces in the classic phase colors,
 *  bold red limit lines, framed white plot area, and zoom/pan controls
 *  (buttons, wheel, drag to pan, Shift+drag for a zoom box). */
export function GraphPanel() {
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
  const nodes = useCircuitStore((s) => s.nodes)
  const [xKey, setXKey] = useState('dist')
  const [yKey, setYKey] = useState('vphase')
  const [phaseOn, setPhaseOn] = useState<Record<number, boolean>>({ 1: true, 2: true, 3: true })
  const [domain, setDomain] = useState<Domain | null>(null) // null = auto-fit
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [hover, setHover] = useState<{ r: GraphRow; x: number; y: number } | null>(null)
  const [size, setSize] = useState(initialSize)
  const sizeRef = useRef(size)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ mode: 'pan' | 'box'; px: number; py: number; dom: Domain } | null>(null)

  const W = size.w
  const H = size.h
  const PLOT_W = W - ML - MR
  const PLOT_H = H - MT - MB

  // Corner grip: drag to change the chart's size (and so its aspect ratio).
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

  // A new quantity gets a fresh auto-fit.
  useEffect(() => setDomain(null), [xKey, yKey])

  const xq = X_QUANTITIES.find((q) => q.key === xKey)!
  const yq = Y_QUANTITIES.find((q) => q.key === yKey)!
  const isPhaseY = yKey === 'vphase'
  const isVoltageY = isPhaseY || yKey === 'vmin' || yKey === 'vmax'

  const data = useMemo(
    () =>
      result?.converged
        ? computeGraph(result, nodes.map((n) => ({ id: n.id, type: n.type })), xKey, yKey)
        : null,
    [result, nodes, xKey, yKey],
  )
  const rows = useMemo(
    () => (data ? data.rows.filter((r) => r.phase == null || phaseOn[r.phase]) : []),
    [data, phaseOn],
  )
  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows])

  const autoDomain = useMemo<Domain | null>(() => {
    if (rows.length < 2) return null
    const xs = rows.map((r) => r.x)
    const ys = rows.map((r) => r.y)
    let xLo = Math.min(...xs)
    let xHi = Math.max(...xs)
    let yLo = Math.min(...ys)
    let yHi = Math.max(...ys)
    if (isVoltageY) {
      yLo = Math.min(0.945, yLo - 0.005)
      yHi = Math.max(1.055, yHi + 0.005)
    }
    const xPad = (xHi - xLo) * 0.04 || Math.abs(xHi) * 0.04 || 0.5
    const yPad = (yHi - yLo) * 0.06 || Math.abs(yHi) * 0.06 || 0.5
    return {
      x: [xKey === 'dist' ? 0 : xLo - xPad, xHi + xPad],
      y: isVoltageY ? [yLo, yHi] : [yLo - yPad, yHi + yPad],
    }
  }, [rows, isVoltageY, xKey])

  const controls = (
    <div className="graph-controls">
      <label>
        Y
        <select aria-label="Y axis" value={yKey} onChange={(e) => setYKey(e.target.value)}>
          <optgroup label="Buses">
            {Y_QUANTITIES.filter((q) => q.kind === 'bus').map((q) => (
              <option key={q.key} value={q.key}>{q.label}</option>
            ))}
          </optgroup>
          <optgroup label="Elements">
            {Y_QUANTITIES.filter((q) => q.kind === 'element').map((q) => (
              <option key={q.key} value={q.key}>{q.label}</option>
            ))}
          </optgroup>
        </select>
      </label>
      <label>
        vs X
        <select aria-label="X axis" value={xKey} onChange={(e) => setXKey(e.target.value)}>
          {X_QUANTITIES.map((q) => (
            <option key={q.key} value={q.key}>{q.label}</option>
          ))}
        </select>
      </label>
      {isPhaseY && (
        <span className="phase-toggles">
          {[1, 2, 3].map((p) => (
            <label key={p} style={{ color: PHASE_COLORS[p] }}>
              <input
                type="checkbox"
                checked={phaseOn[p]}
                onChange={() => setPhaseOn({ ...phaseOn, [p]: !phaseOn[p] })}
              />
              ph{p}
            </label>
          ))}
        </span>
      )}
      <span className="graph-zoom">
        <button title="Zoom in" onClick={() => zoomAbout(0.7)}>＋</button>
        <button title="Zoom out" onClick={() => zoomAbout(1.4)}>－</button>
        <button title="Reset view (or double-click the plot)" onClick={() => setDomain(null)}>⤢ fit</button>
      </span>
      <span className="graph-hint">drag = pan · Shift+drag = zoom box · wheel = zoom</span>
    </div>
  )

  if (!result?.converged || !autoDomain) {
    return (
      <div className="vp-wrap">
        {controls}
        <div className="bp-empty">
          Solve the circuit to plot results (needs at least two data points).
        </div>
      </div>
    )
  }

  const dom = domain ?? autoDomain
  const [xLo, xHi] = dom.x
  const [yLo, yHi] = dom.y
  const x = (v: number) => ML + ((v - xLo) / (xHi - xLo)) * PLOT_W
  const y = (v: number) => MT + (1 - (v - yLo) / (yHi - yLo)) * PLOT_H
  const byId = new Map(rows.map((r) => [r.id, r]))

  // --- interactions ------------------------------------------------------
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
    if (!drag) return
    const { px, py } = toPx(e)
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

  const xTicks = ticks(xLo, xHi)
  const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : 1
  const yTicks = ticks(yLo, yHi)
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1
  const title =
    isVoltageY && xKey === 'dist' ? 'Voltage Profile' : `${yq.label} vs ${xq.label}`

  const seriesColor = (r: GraphRow) =>
    r.phase != null ? PHASE_COLORS[r.phase] ?? '#1a1a1a' : yq.kind === 'bus' ? '#1a1a1a' : '#1565c0'

  return (
    <div className="vp-wrap" style={{ opacity: stale ? 0.5 : 1 }}>
      {controls}
      <div className="vp-frame-box">
      <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`}
           className="vp-chart classic" role="img"
           aria-label={`${yq.label} versus ${xq.label} for the solved circuit`}
           onPointerDown={onPointerDown} onPointerMove={onPointerMove}
           onPointerUp={onPointerUp} onDoubleClick={() => setDomain(null)}
           onWheel={onWheel}>
        <defs>
          <clipPath id="plot-clip">
            <rect x={ML} y={MT} width={PLOT_W} height={PLOT_H} />
          </clipPath>
        </defs>
        <rect x={0} y={0} width={W} height={H} className="vp-paper" />
        {/* titles, OpenDSS-window style */}
        <text x={ML} y={MT - 10} className="vp-title">{yq.label}</text>
        <text x={W - MR} y={MT - 10} className="vp-title" textAnchor="end">{title}</text>
        {/* ticks + grid */}
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={ML} x2={W - MR} y1={y(t)} y2={y(t)} className="vp-grid" clipPath="url(#plot-clip)" />
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
              {fmt(t, xStep)}
            </text>
          </g>
        ))}
        <text x={ML + PLOT_W / 2} y={H - 4} className="vp-axis-label classic" textAnchor="middle">
          {xq.label === 'km from source' ? 'Distance (km)' : xq.label}
        </text>
        <g clipPath="url(#plot-clip)">
          {/* bold red limit lines, the classic ANSI band */}
          {isVoltageY &&
            [0.95, 1.05].map((t) => (
              <line key={t} x1={ML} x2={W - MR} y1={y(t)} y2={y(t)} className="vp-limit" />
            ))}
          {data!.segments.map((s, i) => {
            if (!visibleIds.has(s.from) || !visibleIds.has(s.to)) return null
            const a = byId.get(s.from)!
            const b = byId.get(s.to)!
            return (
              <line key={i} x1={x(a.x)} y1={y(a.y)} x2={x(b.x)} y2={y(b.y)}
                    stroke={seriesColor(a)}
                    className={s.dashed ? 'vp-trace dashed' : 'vp-trace'} />
            )
          })}
          {rows.map((r) => (
            <g key={r.id}>
              <circle cx={x(r.x)} cy={y(r.y)} r={9} fill="transparent"
                      onMouseEnter={(e) => setHover({ r, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHover(null)} />
              <circle cx={x(r.x)} cy={y(r.y)} r={hover?.r.id === r.id ? 4.5 : isPhaseY ? 2.4 : 3.2}
                      fill={!isPhaseY && r.violation ? '#d32f2f' : seriesColor(r)}
                      className="vp-dot" />
            </g>
          ))}
        </g>
        {/* frame on top of the data */}
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
      {hover && (
        <div className="result-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="rt-title">
            {hover.r.id}
            {hover.r.phase != null ? ` (phase ${hover.r.phase})` : ''}
          </div>
          <table>
            <tbody>
              <tr><td>{xq.label}</td><td>{hover.r.x.toFixed(3)}</td></tr>
              <tr><td>{yq.label}</td><td>{hover.r.y.toFixed(4)}</td></tr>
              {hover.r.id !== hover.r.bus && !hover.r.phase && (
                <tr><td>at bus</td><td>{hover.r.bus}</td></tr>
              )}
              {hover.r.violation && <tr><td>status</td><td>{hover.r.violation}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
