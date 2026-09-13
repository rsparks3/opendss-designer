import { useMemo, useState } from 'react'
import { formatAmps, formatSeconds, logTicks } from '../lib/tcc'
import { beginGesture, endGesture, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { TccCurveJSON } from '../types/circuit'

const PREVIEW_W = 380
const PREVIEW_H = 190
const PAD = { l: 46, r: 10, t: 10, b: 24 }

/** A curve every device can start from: a plain inverse shape, in multiples of
 *  pickup. Users replace the numbers with their manufacturer's. */
const STARTER: TccCurveJSON = {
  multiples: [1.5, 2, 3, 5, 10, 20],
  seconds: [10, 4, 1.5, 0.5, 0.15, 0.06],
  source: 'typed in',
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}${i}`)) i++
  return `${base}${i}`
}

/** Two columns of numbers, one point per line: "multiple, seconds". The same
 *  shape the engine's own curves have, so a manufacturer's table can be pasted
 *  in with only the units to think about. */
function parsePoints(text: string): { multiples: number[]; seconds: number[]; bad: number } {
  const multiples: number[] = []
  const seconds: number[] = []
  let bad = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [a, b] = trimmed.split(/[,\s;\t]+/)
    const m = Number(a)
    const s = Number(b)
    if (!Number.isFinite(m) || !Number.isFinite(s) || m <= 0 || s <= 0) {
      bad += 1
      continue
    }
    multiples.push(m)
    seconds.push(s)
  }
  return { multiples, seconds, bad }
}

const toText = (c: TccCurveJSON) =>
  c.multiples.map((m, i) => `${m}, ${c.seconds[i] ?? ''}`).join('\n')

/** Log-log preview of one curve, in multiples of pickup rather than amps:
 *  a curve belongs to no device until one points at it. */
function Preview({ curve }: { curve: TccCurveJSON }) {
  const pts = curve.multiples
    .map((m, i) => [m, curve.seconds[i]] as [number, number])
    .filter(([m, s]) => Number.isFinite(m) && Number.isFinite(s) && m > 0 && s > 0)
  if (pts.length < 2) {
    return <div className="bp-empty">Two points or more to draw a curve.</div>
  }
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const xLo = Math.min(...xs) / 1.3
  const xHi = Math.max(...xs) * 1.3
  const yLo = Math.min(...ys) / 2
  const yHi = Math.max(...ys) * 2
  const w = PREVIEW_W - PAD.l - PAD.r
  const h = PREVIEW_H - PAD.t - PAD.b
  const x = (v: number) =>
    PAD.l + ((Math.log10(v) - Math.log10(xLo)) / (Math.log10(xHi) - Math.log10(xLo))) * w
  const y = (v: number) =>
    PAD.t + (1 - (Math.log10(v) - Math.log10(yLo)) / (Math.log10(yHi) - Math.log10(yLo))) * h
  return (
    <svg className="vp-chart" viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
         width={PREVIEW_W} height={PREVIEW_H}>
      <rect x={0} y={0} width={PREVIEW_W} height={PREVIEW_H} className="vp-paper" />
      {logTicks(yLo, yHi).filter((t) => t.major).map(({ v }) => (
        <g key={`y${v}`}>
          <line x1={PAD.l} x2={PAD.l + w} y1={y(v)} y2={y(v)} className="vp-grid major" />
          <text x={PAD.l - 6} y={y(v) + 3} className="vp-tick classic" textAnchor="end">
            {formatSeconds(v)}
          </text>
        </g>
      ))}
      {/* A curve spans well under a decade of pickup multiples, so labelling
          only the decades can leave the axis with a single number on it. */}
      {logTicks(xLo, xHi).filter(({ v, major }) => {
        const mantissa = v / 10 ** Math.floor(Math.log10(v))
        return major || mantissa === 2 || mantissa === 5
      }).map(({ v }) => (
        <g key={`x${v}`}>
          <line x1={x(v)} x2={x(v)} y1={PAD.t} y2={PAD.t + h} className="vp-grid major" />
          <text x={x(v)} y={PREVIEW_H - 8} className="vp-tick classic" textAnchor="middle">
            {formatAmps(v)}×
          </text>
        </g>
      ))}
      <path
        d={pts.map(([m, s], i) => `${i ? 'L' : 'M'}${x(m).toFixed(2)},${y(s).toFixed(2)}`).join(' ')}
        className="vp-trace" stroke="#1565c0" fill="none"
      />
      <rect x={PAD.l} y={PAD.t} width={w} height={h} className="vp-frame" />
    </svg>
  )
}

/** The circuit's own time-current curves. The engine ships ten; these are the
 *  ones you type in from a manufacturer's sheet, and any device can use them. */
export function CurvesPanel() {
  const curves = useCircuitStore((s) => s.tccCurves)
  const setCurve = useCircuitStore((s) => s.setTccCurve)
  const removeCurve = useCircuitStore((s) => s.removeTccCurve)
  const nodes = useCircuitStore((s) => s.nodes)
  const setFlash = useResultsStore((s) => s.setFlash)
  const names = Object.keys(curves)
  const [selected, setSelected] = useState<string | null>(names[0] ?? null)
  const active = selected && curves[selected] ? selected : (names[0] ?? null)
  const [text, setText] = useState<string | null>(null)

  // Which devices point at the selected curve — deleting one they use would
  // send them back to a default curve, so say so before it happens.
  const usedBy = useMemo(() => {
    if (!active) return []
    const keys = ['fusecurve', 'phasefast', 'phasedelayed', 'groundfast',
                  'grounddelayed', 'phasecurve', 'groundcurve']
    return nodes
      .filter((n) => keys.some((k) => n.data.params[k] === active))
      .map((n) => String(n.data.params.name ?? n.id))
  }, [nodes, active])

  const add = () => {
    const name = uniqueName('curve1', new Set(names))
    beginGesture()
    setCurve(name, { ...STARTER })
    endGesture()
    setSelected(name)
    setText(null)
  }

  const commit = (raw: string) => {
    if (!active) return
    const { multiples, seconds, bad } = parsePoints(raw)
    if (multiples.length < 2) {
      setFlash('A curve needs at least two points: multiple of pickup, seconds.')
      return
    }
    beginGesture()
    setCurve(active, { multiples, seconds, source: curves[active]?.source ?? 'typed in' })
    endGesture()
    setText(null)
    if (bad) setFlash(`${bad} line${bad === 1 ? '' : 's'} skipped — each needs two positive numbers.`, 'info')
  }

  return (
    <div className="curves-panel">
      <div className="curves-list">
        <button className="curves-add" onClick={add}>+ New curve</button>
        {names.length === 0 && (
          <div className="bp-empty">
            No curves of your own yet. The engine's ten (tlink, klink, a, d, the
            IEEE inverse family) are always available on every device.
          </div>
        )}
        {names.map((n) => (
          <button
            key={n}
            className={`curves-item${n === active ? ' active' : ''}`}
            onClick={() => {
              setSelected(n)
              setText(null)
            }}
          >
            {n}
            <span className="curves-count">{curves[n].multiples.length} pts</span>
          </button>
        ))}
      </div>
      {active && curves[active] && (
        <div className="curves-editor">
          <div className="curves-head">
            <input
              className="curves-name"
              value={active}
              onChange={(e) => {
                const next = e.target.value.trim()
                if (!next || next === active || curves[next]) return
                beginGesture()
                setCurve(next, curves[active])
                removeCurve(active)
                endGesture()
                setSelected(next)
              }}
              aria-label="Curve name"
            />
            <button
              className="curves-delete"
              onClick={() => {
                removeCurve(active)
                setSelected(null)
              }}
              title={usedBy.length
                ? `${usedBy.join(', ')} would fall back to a default curve`
                : 'Delete this curve'}
            >
              Delete
            </button>
          </div>
          <div className="curves-body">
            <label className="curves-points">
              <span>Multiple of pickup, seconds — one point per line</span>
              <textarea
                value={text ?? toText(curves[active])}
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onBlur={(e) => commit(e.target.value)}
              />
            </label>
            <div>
              <Preview curve={
                text
                  ? { ...parsePoints(text), source: null }
                  : curves[active]
              } />
              {usedBy.length > 0 && (
                <div className="curves-used">Used by {usedBy.join(', ')}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
