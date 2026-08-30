import { useMemo, useState } from 'react'
import { computeProfile, type ProfilePoint } from '../lib/profile'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'

const W = 800
const H = 220
const ML = 48
const MR = 14
const MT = 12
const MB = 30

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag
}

/** Distance-vs-voltage plot along the feeder: one point per bus (its lowest
 *  phase voltage), line edges as solid segments, transformer/breaker drops
 *  dashed, with the ANSI 0.95/1.05 pu band marked. */
export function VoltageProfile() {
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
  const nodes = useCircuitStore((s) => s.nodes)
  const [hover, setHover] = useState<{ p: ProfilePoint; x: number; y: number } | null>(null)

  const data = useMemo(
    () =>
      result?.converged
        ? computeProfile(result, nodes.map((n) => ({ id: n.id, type: n.type })))
        : null,
    [result, nodes],
  )
  if (!result?.converged || !data || data.points.length < 2) {
    return (
      <div className="bp-empty">
        Solve the circuit to see the voltage profile (needs at least two buses).
      </div>
    )
  }

  const xMax = Math.max(...data.points.map((p) => p.distKm), 0.001) * 1.02
  const vLo = Math.min(...data.points.map((p) => p.vminPu))
  const vHi = Math.max(...data.points.map((p) => p.vmaxPu))
  const y0 = Math.min(0.94, vLo - 0.005)
  const y1 = Math.max(1.06, vHi + 0.005)
  const x = (d: number) => ML + (d / xMax) * (W - ML - MR)
  const y = (v: number) => MT + (1 - (v - y0) / (y1 - y0)) * (H - MT - MB)
  const byBus = new Map(data.points.map((p) => [p.bus, p]))

  const step = niceStep(xMax / 4)
  const xTicks: number[] = []
  for (let t = 0; t <= xMax; t += step) xTicks.push(Number(t.toFixed(6)))
  const yTicks = [0.95, 1.0, 1.05].filter((t) => t > y0 && t < y1)

  return (
    <div className="vp-wrap" style={{ opacity: stale ? 0.5 : 1 }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="vp-chart" role="img"
           aria-label="Voltage profile: per-bus voltage versus distance from the source">
        {/* limit band + gridlines */}
        <rect x={ML} y={y(1.05)} width={W - ML - MR} height={y(0.95) - y(1.05)} className="vp-band" />
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={ML} x2={W - MR} y1={y(t)} y2={y(t)} className={t === 1 ? 'vp-grid' : 'vp-ref'} />
            <text x={ML - 6} y={y(t) + 3.5} className="vp-tick" textAnchor="end">
              {t.toFixed(2)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={H - MB} y2={H - MB + 4} className="vp-grid" />
            <text x={x(t)} y={H - MB + 15} className="vp-tick" textAnchor="middle">
              {t.toFixed(step < 1 ? 1 : 0)}
            </text>
          </g>
        ))}
        <text x={(ML + W - MR) / 2} y={H - 3} className="vp-axis-label" textAnchor="middle">
          km from source
        </text>
        <text x={12} y={(MT + H - MB) / 2} className="vp-axis-label"
              textAnchor="middle" transform={`rotate(-90 12 ${(MT + H - MB) / 2})`}>
          V (pu)
        </text>
        {/* segments */}
        {data.segments.map((s, i) => {
          const a = byBus.get(s.from)!
          const b = byBus.get(s.to)!
          return (
            <line key={i} x1={x(a.distKm)} y1={y(a.vminPu)} x2={x(b.distKm)} y2={y(b.vminPu)}
                  className={s.dashed ? 'vp-segment dashed' : 'vp-segment'} />
          )
        })}
        {/* bus points, with an enlarged invisible hit target */}
        {data.points.map((p) => (
          <g key={p.bus}>
            <circle cx={x(p.distKm)} cy={y(p.vminPu)} r={10} fill="transparent"
                    onMouseEnter={(e) => setHover({ p, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setHover(null)} />
            <circle cx={x(p.distKm)} cy={y(p.vminPu)} r={hover?.p.bus === p.bus ? 5 : 3.5}
                    className={p.violation ? 'vp-point violation' : 'vp-point'} />
          </g>
        ))}
      </svg>
      {hover && (
        <div className="result-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="rt-title">bus {hover.p.bus}</div>
          <table>
            <tbody>
              <tr><td>distance</td><td>{hover.p.distKm.toFixed(3)} km</td></tr>
              <tr><td>V min</td><td>{hover.p.vminPu.toFixed(4)} pu</td></tr>
              <tr><td>V max</td><td>{hover.p.vmaxPu.toFixed(4)} pu</td></tr>
              {hover.p.violation && (
                <tr><td>status</td><td>{hover.p.violation}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
