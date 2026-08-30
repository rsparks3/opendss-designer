import { useMemo, useState } from 'react'
import { computeGraph, X_QUANTITIES, Y_QUANTITIES, type GraphRow } from '../lib/graph'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'

const W = 800
const H = 240
const ML = 56
const MR = 14
const MT = 12
const MB = 30

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1))
  const norm = raw / mag
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag
}

function fmt(v: number, step: number): string {
  if (step < 0.05) return v.toFixed(3)
  if (step < 0.5) return v.toFixed(2)
  if (step < 5) return v.toFixed(1)
  return v.toFixed(0)
}

function ticks(lo: number, hi: number, count = 4): number[] {
  const step = niceStep((hi - lo) / count)
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(t)
  return out
}

/** Pick-your-axes chart over the solve results: bus quantities (voltage)
 *  draw the feeder topology as segments; element quantities (P/Q flow,
 *  current, loading, losses) plot each element at its source-side bus. */
export function GraphPanel() {
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
  const nodes = useCircuitStore((s) => s.nodes)
  const [xKey, setXKey] = useState('dist')
  const [yKey, setYKey] = useState('vmin')
  const [hover, setHover] = useState<{ r: GraphRow; x: number; y: number } | null>(null)

  const data = useMemo(
    () =>
      result?.converged
        ? computeGraph(result, nodes.map((n) => ({ id: n.id, type: n.type })), xKey, yKey)
        : null,
    [result, nodes, xKey, yKey],
  )

  const xq = X_QUANTITIES.find((q) => q.key === xKey)!
  const yq = Y_QUANTITIES.find((q) => q.key === yKey)!
  const isVoltageY = yKey === 'vmin' || yKey === 'vmax'

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
    </div>
  )

  if (!result?.converged || !data || data.rows.length < 2) {
    return (
      <div className="vp-wrap">
        {controls}
        <div className="bp-empty">
          Solve the circuit to plot results (needs at least two data points).
        </div>
      </div>
    )
  }

  const xs = data.rows.map((r) => r.x)
  const ys = data.rows.map((r) => r.y)
  let xLo = Math.min(...xs)
  let xHi = Math.max(...xs)
  let yLo = Math.min(...ys)
  let yHi = Math.max(...ys)
  if (isVoltageY) {
    yLo = Math.min(0.94, yLo - 0.005)
    yHi = Math.max(1.06, yHi + 0.005)
  }
  const xPad = (xHi - xLo) * 0.04 || Math.abs(xHi) * 0.04 || 0.5
  const yPad = (yHi - yLo) * 0.08 || Math.abs(yHi) * 0.08 || 0.5
  xLo = xKey === 'dist' ? 0 : xLo - xPad
  xHi += xPad
  if (!isVoltageY) {
    yLo -= yPad
    yHi += yPad
  }
  const x = (v: number) => ML + ((v - xLo) / (xHi - xLo)) * (W - ML - MR)
  const y = (v: number) => MT + (1 - (v - yLo) / (yHi - yLo)) * (H - MT - MB)
  const byBus = new Map(data.rows.map((r) => [r.id, r]))

  const xTicks = ticks(xLo, xHi)
  const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : 1
  const yTicks = isVoltageY ? [0.95, 1.0, 1.05].filter((t) => t > yLo && t < yHi) : ticks(yLo, yHi)
  const yStep = isVoltageY ? 0.01 : yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1

  return (
    <div className="vp-wrap" style={{ opacity: stale ? 0.5 : 1 }}>
      {controls}
      <svg viewBox={`0 0 ${W} ${H}`} className="vp-chart" role="img"
           aria-label={`${yq.label} versus ${xq.label} for the solved circuit`}>
        {isVoltageY && (
          <rect x={ML} y={y(Math.min(1.05, yHi))} width={W - ML - MR}
                height={y(Math.max(0.95, yLo)) - y(Math.min(1.05, yHi))} className="vp-band" />
        )}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={ML} x2={W - MR} y1={y(t)} y2={y(t)}
                  className={isVoltageY && t !== 1 ? 'vp-ref' : 'vp-grid'} />
            <text x={ML - 6} y={y(t) + 3.5} className="vp-tick" textAnchor="end">
              {fmt(t, yStep)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={H - MB} y2={H - MB + 4} className="vp-grid" />
            <text x={x(t)} y={H - MB + 15} className="vp-tick" textAnchor="middle">
              {fmt(t, xStep)}
            </text>
          </g>
        ))}
        <text x={(ML + W - MR) / 2} y={H - 3} className="vp-axis-label" textAnchor="middle">
          {xq.label}
        </text>
        <text x={12} y={(MT + H - MB) / 2} className="vp-axis-label"
              textAnchor="middle" transform={`rotate(-90 12 ${(MT + H - MB) / 2})`}>
          {yq.label}
        </text>
        {data.segments.map((s, i) => {
          const a = byBus.get(s.from)
          const b = byBus.get(s.to)
          if (!a || !b) return null
          return (
            <line key={i} x1={x(a.x)} y1={y(a.y)} x2={x(b.x)} y2={y(b.y)}
                  className={s.dashed ? 'vp-segment dashed' : 'vp-segment'} />
          )
        })}
        {data.rows.map((r) => (
          <g key={r.id}>
            <circle cx={x(r.x)} cy={y(r.y)} r={10} fill="transparent"
                    onMouseEnter={(e) => setHover({ r, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setHover(null)} />
            <circle cx={x(r.x)} cy={y(r.y)} r={hover?.r.id === r.id ? 5 : 3.5}
                    className={r.violation ? 'vp-point violation' : 'vp-point'} />
          </g>
        ))}
      </svg>
      {hover && (
        <div className="result-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="rt-title">{hover.r.id}</div>
          <table>
            <tbody>
              <tr><td>{xq.label}</td><td>{hover.r.x.toFixed(3)}</td></tr>
              <tr><td>{yq.label}</td><td>{hover.r.y.toFixed(3)}</td></tr>
              {hover.r.id !== hover.r.bus && (
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
