import { useMemo, useState } from 'react'
import {
  STARTER,
  formatMatrix,
  isMatrixCode,
  linesOnCode,
  parseMatrix,
} from '../lib/lineCodeText'
import { beginGesture, endGesture, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { LineCodeJSON } from '../types/circuit'

const UNITS = ['km', 'm', 'mi', 'kft', 'ft', 'none']

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}${i}`)) i++
  return `${base}${i}`
}

/** Keep the top-left of a matrix when the phase count changes; new
 *  positions copy the last diagonal / off-diagonal value so a 2-phase code
 *  grown to 3 stays a plausible conductor until the numbers are typed. */
function resize(m: number[][] | null | undefined, n: number): number[][] | null {
  if (!m || !m.length) return null
  const old = m.length
  const diag = m[old - 1][old - 1]
  const off = old > 1 ? m[old - 1][old - 2] : 0
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i < old && j < old ? m[i][j] : i === j ? diag : off)),
  )
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function describe(spec: LineCodeJSON): string {
  return `${spec.nphases}φ · ${spec.units}${isMatrixCode(spec) ? ' · matrix' : ' · sequence'}`
}

/** One matrix as a text field: shown as OpenDSS writes it, parsed back the
 *  same way, and refused (with the reason) rather than half-applied. */
function MatrixField({
  label,
  unit,
  value,
  n,
  optional,
  onCommit,
}: {
  label: string
  unit: string
  value: number[][] | null | undefined
  n: number
  optional?: boolean
  onCommit: (m: number[][] | null) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const setFlash = useResultsStore((s) => s.setFlash)
  const commit = (raw: string) => {
    setText(null)
    const trimmed = raw.trim()
    if (!trimmed) {
      if (optional) onCommit(null)
      else setFlash(`${label} needs ${n} row${n === 1 ? '' : 's'}: the lower triangle, rows separated by |.`)
      return
    }
    const m = parseMatrix(trimmed, n)
    if (!m) {
      setFlash(
        `${label}: expected ${n} row${n === 1 ? '' : 's'} separated by |, ` +
          `each with one more number than the last (e.g. "0.35 | 0.16 0.34 | 0.16 0.15 0.34").`,
      )
      return
    }
    onCommit(m)
  }
  return (
    <label className="lc-matrix">
      <span>
        {label} <em>({unit}{optional ? ', optional' : ''})</em>
      </span>
      <input
        value={text ?? formatMatrix(value)}
        spellCheck={false}
        placeholder={n === 1 ? 'r' : 'diag | off diag | …'}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

function NumberField({
  label,
  unit,
  value,
  onCommit,
}: {
  label: string
  unit?: string
  value: number | null | undefined
  onCommit: (v: number | null) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <label className="prop-row">
      <span>
        {label}
        {unit ? ` (${unit})` : ''}
      </span>
      <input
        type="number"
        step="any"
        value={text ?? (value ?? '')}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          setText(null)
          const v = e.target.value.trim()
          onCommit(v === '' ? null : Number(v))
        }}
      />
    </label>
  )
}

/** The circuit's conductor library. Every line that names one of these takes
 *  its impedance from it, matrix and all, which is how a real feeder is
 *  written and the only way its mutual coupling survives. */
export function LineCodesPanel() {
  const codes = useCircuitStore((s) => s.lineCodes)
  const setCode = useCircuitStore((s) => s.setLineCode)
  const removeCode = useCircuitStore((s) => s.removeLineCode)
  const renameCode = useCircuitStore((s) => s.renameLineCode)
  const edges = useCircuitStore((s) => s.edges)
  const names = Object.keys(codes)
  const [selected, setSelected] = useState<string | null>(names[0] ?? null)
  const active = selected && codes[selected] ? selected : (names[0] ?? null)
  const spec = active ? codes[active] : null
  const [nameText, setNameText] = useState<string | null>(null)

  const usedBy = useMemo(() => (active ? linesOnCode(edges, active) : []), [edges, active])
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const e of edges) {
      const code = e.type === 'line' ? e.data?.params.linecode : null
      if (typeof code === 'string') out[code] = (out[code] ?? 0) + 1
    }
    return out
  }, [edges])

  const update = (patch: Partial<LineCodeJSON>) => {
    if (!active || !spec) return
    beginGesture()
    setCode(active, { ...spec, ...patch })
    endGesture()
  }

  const add = () => {
    const name = uniqueName('code1', new Set(names))
    beginGesture()
    setCode(name, { ...STARTER })
    endGesture()
    setSelected(name)
  }

  const setPhases = (n: number) => {
    if (!spec) return
    update({
      nphases: n,
      rmatrix: resize(spec.rmatrix, n),
      xmatrix: resize(spec.xmatrix, n),
      cmatrix: resize(spec.cmatrix, n),
    })
  }

  const toMatrix = () => {
    if (!spec) return
    update({ rmatrix: STARTER.rmatrix, xmatrix: STARTER.xmatrix, cmatrix: null, nphases: 3 })
  }
  const toSequence = () => {
    if (!spec) return
    update({
      rmatrix: null,
      xmatrix: null,
      cmatrix: null,
      r1: spec.r1 ?? 0.12,
      x1: spec.x1 ?? 0.38,
      r0: spec.r0 ?? 0.4,
      x0: spec.x0 ?? 1.2,
    })
  }

  return (
    <div className="curves-panel linecodes-panel">
      <div className="curves-list">
        <button className="curves-add" onClick={add}>+ New line code</button>
        {names.length === 0 && (
          <div className="bp-empty">
            No line codes yet. A code is a conductor definition lines share by
            name: an imported feeder brings its own, and a line drawn by hand
            can pick one here instead of typing R and X. The presets in the
            properties panel stay available for simple sequence values.
          </div>
        )}
        {names.map((n) => (
          <button
            key={n}
            className={`curves-item${n === active ? ' active' : ''}`}
            onClick={() => {
              setSelected(n)
              setNameText(null)
            }}
            title={describe(codes[n])}
          >
            {n}
            <span className="curves-count">
              {counts[n] ? `${counts[n]} line${counts[n] === 1 ? '' : 's'}` : 'unused'}
            </span>
          </button>
        ))}
      </div>
      {active && spec && (
        <div className="curves-editor">
          <div className="curves-head">
            <input
              className="curves-name"
              value={nameText ?? active}
              onChange={(e) => setNameText(e.target.value)}
              onBlur={() => {
                const next = (nameText ?? '').trim()
                setNameText(null)
                if (!next || next === active || codes[next]) return
                renameCode(active, next)
                setSelected(next)
              }}
              aria-label="Line code name"
            />
            <span className="lc-source">{spec.source ?? ''}</span>
            <button
              className="curves-delete"
              onClick={() => {
                removeCode(active)
                setSelected(null)
              }}
              title={
                usedBy.length
                  ? `${usedBy.join(', ')} would fall back to their own R/X values`
                  : 'Delete this line code'
              }
            >
              Delete
            </button>
          </div>
          <div className="lc-body">
            <div className="lc-row">
              <label className="prop-row">
                <span>Phases</span>
                <select value={spec.nphases} onChange={(e) => setPhases(Number(e.target.value))}>
                  {[1, 2, 3].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label className="prop-row">
                <span>Units</span>
                <select value={spec.units} onChange={(e) => update({ units: e.target.value })}>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </label>
              <NumberField
                label="Rating"
                unit="A"
                value={num(spec.normamps)}
                onCommit={(v) => update({ normamps: v })}
              />
              <span className="lc-mode">
                <button
                  className={isMatrixCode(spec) ? 'active' : ''}
                  onClick={toMatrix}
                  disabled={isMatrixCode(spec)}
                  title="Full phase impedance matrix, as a feeder model gives it"
                >
                  Matrix
                </button>
                <button
                  className={!isMatrixCode(spec) ? 'active' : ''}
                  onClick={toSequence}
                  disabled={!isMatrixCode(spec)}
                  title="Sequence values; the engine builds a balanced matrix from them"
                >
                  Sequence
                </button>
              </span>
            </div>
            {isMatrixCode(spec) ? (
              <div className="lc-matrices">
                <MatrixField
                  label="R"
                  unit={`Ω/${spec.units}`}
                  value={spec.rmatrix}
                  n={spec.nphases}
                  onCommit={(m) => update({ rmatrix: m })}
                />
                <MatrixField
                  label="X"
                  unit={`Ω/${spec.units}`}
                  value={spec.xmatrix}
                  n={spec.nphases}
                  onCommit={(m) => update({ xmatrix: m })}
                />
                <MatrixField
                  label="C"
                  unit={`nF/${spec.units}`}
                  value={spec.cmatrix}
                  n={spec.nphases}
                  optional
                  onCommit={(m) => update({ cmatrix: m })}
                />
                <div className="lc-hint">
                  Lower triangle, rows separated by |, exactly as a .dss file
                  writes <code>rmatrix=</code>. Paste from the file or the
                  conductor table.
                </div>
              </div>
            ) : (
              <div className="lc-row lc-seq">
                <NumberField label="R1" unit={`Ω/${spec.units}`} value={num(spec.r1)} onCommit={(v) => update({ r1: v })} />
                <NumberField label="X1" unit={`Ω/${spec.units}`} value={num(spec.x1)} onCommit={(v) => update({ x1: v })} />
                <NumberField label="R0" unit={`Ω/${spec.units}`} value={num(spec.r0)} onCommit={(v) => update({ r0: v })} />
                <NumberField label="X0" unit={`Ω/${spec.units}`} value={num(spec.x0)} onCommit={(v) => update({ x0: v })} />
                <NumberField label="C1" unit={`nF/${spec.units}`} value={num(spec.c1)} onCommit={(v) => update({ c1: v })} />
                <NumberField label="C0" unit={`nF/${spec.units}`} value={num(spec.c0)} onCommit={(v) => update({ c0: v })} />
              </div>
            )}
            <div className="curves-used">
              {usedBy.length
                ? `Used by ${usedBy.join(', ')}`
                : 'No line uses this code yet. Pick it under Conductor in a line’s properties.'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
