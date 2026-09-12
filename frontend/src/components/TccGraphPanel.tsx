import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import {
  formatAmps,
  formatSeconds,
  logTicks,
  operateSeconds,
  type TccDevice,
  type TccResult,
  type TccTrace,
} from '../lib/tcc'
import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'

const ML = 62
const MR = 150 // room for the legend
const MT = 26
const MB = 42

const SIZE_KEY = 'opendss-designer.tccSize'
const DEFAULT_SIZE = { w: 760, h: 340 }
const MIN_W = 420
const MAX_W = 1800
const MIN_H = 220
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

// One colour per device, in the order they come back. Distinct at a glance and
// readable on the white plot; the fault line for a device reuses its colour.
const COLORS = ['#1565c0', '#d32f2f', '#2e7d32', '#6a1b9a', '#ef6c00', '#00838f',
                '#c2185b', '#455a64']

type Hover = { x: number; y: number; amps: number; secs: number }

/** Time-current curves for every protective device, on the log-log paper a
 *  coordination study is read off: current across, time down, and a vertical
 *  line where each device's own fault current lands. */
export function TccGraphPanel() {
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const setFlash = useResultsStore((s) => s.setFlash)
  const [data, setData] = useState<TccResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [stale, setStale] = useState(false)
  const [hidden, setHidden] = useState<Record<string, boolean>>({})
  const [hover, setHover] = useState<Hover | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const first = useRef(true)
  const [size, setSize] = useState(initialSize)
  const sizeRef = useRef(size)

  const W = size.w
  const H = size.h
  const PLOT_W = W - ML - MR
  const PLOT_H = H - MT - MB

  // Corner grip, same gesture as the other charts.
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

  const counts = useMemo(() => {
    const curved = nodes.filter(
      (n) => n.type === 'fuse' || n.type === 'recloser' || n.type === 'relay').length
    return { curved, switches: curved + nodes.filter((n) => n.type === 'breaker').length }
  }, [nodes])

  // Editing the circuit invalidates the plot; re-running is one click, not
  // automatic, because it costs a fault-study solve.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setStale(true)
  }, [nodes, edges])

  const run = async () => {
    setLoading(true)
    try {
      const result = await api.tcc(toCircuitJSON(useCircuitStore.getState()))
      setData(result)
      setStale(false)
      // Coordination findings belong in the Problems list with everything
      // else that is wrong with the circuit, not buried in this tab. They live
      // in their own slot: validation rewrites `issues` on every edit and
      // would otherwise wipe them the moment it next runs.
      useResultsStore.getState().setProtectionIssues(result.issues)
      if (!result.converged) {
        const why = result.issues.find((i) => i.severity === 'error')?.message
        setFlash(why ? `Curves unavailable: ${why}` : 'The fault study did not converge.', 'error', 8000)
      }
    } catch (err) {
      setFlash(`Curve study failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (counts.switches > 0 && !data && !loading) void run()
    // Run once on open; afterwards the Re-run button drives it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const devices = data?.devices ?? []
  const visible = devices.filter((d) => !hidden[d.name])
  // Breakers, and any protective device whose curve could not be read: the
  // plot has nothing to show for them, so they get a line in a table instead.
  const plotted = new Set(devices.map((d) => d.nodeId))
  const plainSwitches = (data?.switches ?? []).filter((s) => !plotted.has(s.nodeId))

  const domain = useMemo(() => {
    const xs: number[] = []
    const ys: number[] = []
    for (const d of visible) {
      for (const t of d.traces) {
        for (const [a, s] of t.points) {
          xs.push(a)
          ys.push(s)
        }
      }
      if (d.faultA3ph) xs.push(d.faultA3ph)
      if (d.faultA1ph) xs.push(d.faultA1ph)
    }
    if (xs.length < 2) return null
    return {
      x: [Math.min(...xs) / 1.6, Math.max(...xs) * 1.6] as [number, number],
      y: [Math.min(Math.min(...ys) / 2, 0.01), Math.max(Math.max(...ys) * 2, 1)] as [number, number],
    }
  }, [visible])

  const controls = (
    <div className="graph-controls">
      <button onClick={() => void run()} disabled={loading || counts.switches === 0}>
        {loading ? 'Running…' : stale ? 'Re-run (circuit changed)' : 'Re-run'}
      </button>
      <span className="graph-hint">
        {counts.curved === 0
          ? 'Add a fuse, recloser or relay to plot its curve'
          : 'Current across, operating time down · the dashed line is the fault current at that device'}
      </span>
    </div>
  )

  const switchTable = plainSwitches.length > 0 && (
    <div className="tcc-switches">
      <div className="tcc-switches-title">
        Switches with no curve — nothing to plot, but they still have to break the fault
      </div>
      <table>
        <thead>
          <tr><th>Device</th><th>At bus</th><th>3φ fault</th><th>Interrupting</th></tr>
        </thead>
        <tbody>
          {plainSwitches.map((s) => {
            const over =
              s.faultA3ph != null && s.interruptingKa != null &&
              s.faultA3ph > s.interruptingKa * 1000
            return (
              <tr key={s.nodeId}>
                <td>{s.name} <span className="tcc-kind">{s.kind}</span></td>
                <td>{s.bus}</td>
                <td className={over ? 'over' : undefined}>
                  {s.faultA3ph == null ? '—' : `${(s.faultA3ph / 1000).toFixed(1)} kA`}
                </td>
                <td>{s.interruptingKa == null ? '—' : `${s.interruptingKa} kA`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  if (!domain) {
    return (
      <div className="vp-wrap">
        {controls}
        <div className="bp-empty">
          {counts.switches === 0
            ? 'No protective devices or switches in this circuit yet.'
            : loading
              ? 'Reading curves from the engine…'
              : counts.curved === 0
                ? 'Nothing here carries a time-current curve. A breaker is a switch you operate '
                  + 'yourself — for a breaker that trips on overcurrent, use a relay.'
                : 'No curves to plot.'}
        </div>
        {switchTable}
      </div>
    )
  }

  const [xLo, xHi] = domain.x
  const [yLo, yHi] = domain.y
  const lx = (v: number) =>
    ML + ((Math.log10(v) - Math.log10(xLo)) / (Math.log10(xHi) - Math.log10(xLo))) * PLOT_W
  const ly = (v: number) =>
    MT + (1 - (Math.log10(v) - Math.log10(yLo)) / (Math.log10(yHi) - Math.log10(yLo))) * PLOT_H

  const colorOf = (name: string) =>
    COLORS[devices.findIndex((d) => d.name === name) % COLORS.length]

  const path = (t: TccTrace) =>
    t.points.map(([a, s], i) => `${i ? 'L' : 'M'}${lx(a).toFixed(2)},${ly(s).toFixed(2)}`).join(' ')

  /** Past its last point a curve holds flat — that is what the engine does
   *  when it decides whether a device trips, and the fault current is often
   *  out there, so the plot has to reach it. Drawn faintly: it is the curve's
   *  behaviour, not the curve's data. */
  const tail = (t: TccTrace) => {
    const [lastA, lastS] = t.points[t.points.length - 1]
    if (lastA >= xHi) return null
    return `M${lx(lastA).toFixed(2)},${ly(lastS).toFixed(2)} L${lx(xHi).toFixed(2)},${ly(lastS).toFixed(2)}`
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const py = ((e.clientY - rect.top) / rect.height) * H
    if (px < ML || px > ML + PLOT_W || py < MT || py > MT + PLOT_H) {
      setHover(null)
      return
    }
    const amps = 10 ** (Math.log10(xLo) + ((px - ML) / PLOT_W) * (Math.log10(xHi) - Math.log10(xLo)))
    const secs = 10 ** (Math.log10(yHi) - ((py - MT) / PLOT_H) * (Math.log10(yHi) - Math.log10(yLo)))
    setHover({ x: e.clientX, y: e.clientY, amps, secs })
  }

  return (
    <div className="vp-wrap">
      {controls}
      <div className="vp-frame-box">
        <svg
          ref={svgRef}
          className="vp-chart classic"
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id="tcc-clip">
              <rect x={ML} y={MT} width={PLOT_W} height={PLOT_H} />
            </clipPath>
          </defs>
          <rect x={0} y={0} width={W} height={H} className="vp-paper" />
          <text x={ML} y={MT - 8} className="vp-title">Time (s)</text>

          {logTicks(yLo, yHi).map(({ v, major }) => (
            <g key={`y${v}`}>
              <line x1={ML} x2={ML + PLOT_W} y1={ly(v)} y2={ly(v)}
                    className={major ? 'vp-grid major' : 'vp-grid'} clipPath="url(#tcc-clip)" />
              {major && (
                <text x={ML - 8} y={ly(v) + 3.5} className="vp-tick classic" textAnchor="end">
                  {formatSeconds(v)}
                </text>
              )}
            </g>
          ))}
          {logTicks(xLo, xHi).map(({ v, major }) => (
            <g key={`x${v}`}>
              <line x1={lx(v)} x2={lx(v)} y1={MT} y2={MT + PLOT_H}
                    className={major ? 'vp-grid major' : 'vp-grid'} clipPath="url(#tcc-clip)" />
              {major && (
                <text x={lx(v)} y={MT + PLOT_H + 16} className="vp-tick classic" textAnchor="middle">
                  {formatAmps(v)}
                </text>
              )}
            </g>
          ))}
          <text x={ML + PLOT_W / 2} y={H - 6} className="vp-axis-label classic" textAnchor="middle">
            Current (A)
          </text>

          <g clipPath="url(#tcc-clip)">
            {visible.map((d) =>
              d.traces.map((t) => (
                <g key={`${d.name}-${t.label}`}>
                  <path d={path(t)} fill="none" stroke={colorOf(d.name)}
                        className={t.label.includes('ground') ? 'vp-trace dashed' : 'vp-trace'} />
                  {tail(t) && (
                    <path d={tail(t)!} fill="none" stroke={colorOf(d.name)} className="tcc-tail" />
                  )}
                </g>
              )),
            )}
            {visible.map((d, i) =>
              d.faultA3ph ? (
                <g key={`f-${d.name}`}>
                  <line x1={lx(d.faultA3ph)} x2={lx(d.faultA3ph)} y1={MT} y2={MT + PLOT_H}
                        stroke={colorOf(d.name)} className="tcc-fault" />
                  {/* Devices on one feeder see almost the same fault current, so
                      their lines sit on top of each other; stagger the labels. */}
                  <text x={lx(d.faultA3ph) - 4} y={MT + 12 + i * 13} className="tcc-fault-label"
                        fill={colorOf(d.name)} textAnchor="end">
                    {formatAmps(d.faultA3ph)} A
                  </text>
                </g>
              ) : null,
            )}
          </g>
          <rect x={ML} y={MT} width={PLOT_W} height={PLOT_H} className="vp-frame" />

          {/* Legend: click a device to take it off the plot. */}
          {devices.map((d, i) => (
            <g key={d.name} className="tcc-legend-row"
               onClick={() => setHidden({ ...hidden, [d.name]: !hidden[d.name] })}>
              <rect x={ML + PLOT_W + 10} y={MT + i * 34 - 2} width={MR - 18} height={32}
                    fill="transparent" />
              <line x1={ML + PLOT_W + 14} x2={ML + PLOT_W + 30} y1={MT + i * 34 + 8}
                    y2={MT + i * 34 + 8} stroke={colorOf(d.name)}
                    className="vp-trace" opacity={hidden[d.name] ? 0.25 : 1} />
              <text x={ML + PLOT_W + 36} y={MT + i * 34 + 11} className="tcc-legend"
                    opacity={hidden[d.name] ? 0.4 : 1}>
                {d.name}
              </text>
              <text x={ML + PLOT_W + 14} y={MT + i * 34 + 24} className="tcc-legend sub"
                    opacity={hidden[d.name] ? 0.4 : 1}>
                {d.kind}
                {d.faultA3ph ? ` · ${formatAmps(d.faultA3ph)} A` : ''}
              </text>
            </g>
          ))}
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
      {switchTable}
      {hover && (
        <div className="result-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="rt-title">
            {formatAmps(hover.amps)} A · {formatSeconds(hover.secs)} s
          </div>
          <table>
            <tbody>
              {visible.flatMap((d) =>
                d.traces.map((t) => {
                  const secs = operateSeconds(t, hover.amps)
                  return (
                    <tr key={`${d.name}-${t.label}`}>
                      <td>{t.label}</td>
                      <td>{secs == null ? 'no trip' : `${formatSeconds(secs)} s`}</td>
                    </tr>
                  )
                }),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Devices ordered as they appear in the result, for callers that want the
 *  same colours elsewhere. */
export function tccColor(devices: TccDevice[], name: string): string {
  return COLORS[devices.findIndex((d) => d.name === name) % COLORS.length]
}
