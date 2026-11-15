import { useEffect, useMemo, useRef, useState } from 'react'
import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { AllocationResult, LoadShapeJSON } from '../types/circuit'
import { LockedNote } from './LockedNote'

type Mode = 'kwh' | 'kw' | 'intervals'

function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, '')))
}

/** Analysis → Allocate loads from meter data…: billing kWh, demand kW or
 *  AMI intervals matched to the loads, optionally scaled to the metered
 *  feeder head, applied as a scenario or to the base case. */
export function AllocationDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<Mode>('kwh')
  const [keyBy, setKeyBy] = useState<'name' | 'bus' | 'class'>('name')
  const [keyCol, setKeyCol] = useState(0)
  const [valueCol, setValueCol] = useState(1)
  const [hasHeader, setHasHeader] = useState(true)
  const [hours, setHours] = useState(730)
  const [lf, setLf] = useState('0.5')
  const [target, setTarget] = useState('')
  const [intervalMin, setIntervalMin] = useState(60)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AllocationResult | null>(null)
  const addScenario = useCircuitStore((s) => s.addScenario)
  const updateNodeParams = useCircuitStore((s) => s.updateNodeParams)
  const setLoadShape = useCircuitStore((s) => s.setLoadShape)
  const setFlash = useResultsStore((s) => s.setFlash)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  const rows = useMemo(() => parseCsv(text), [text])
  const header = hasHeader && rows.length ? rows[0] : null
  const body = hasHeader ? rows.slice(1) : rows
  const columns = rows[0]?.length ?? 0

  const payload = () => {
    if (mode === 'intervals') {
      return body.map((r) => ({ key: r[keyCol], values: r.filter((_, i) => i !== keyCol).map(Number).filter((v) => Number.isFinite(v)) }))
    }
    return body.map((r) => ({ key: r[keyCol], [mode === 'kwh' ? 'kwh' : 'kw']: Number(r[valueCol]) })).filter((r) => Number.isFinite(r.kwh ?? r.kw))
  }
  const loadFactor = () => {
    const t = lf.trim()
    if (t.includes('=')) {
      const out: Record<string, number> = {}
      for (const part of t.split(/[,;]+/)) {
        const [c, v] = part.split('=').map((x) => x.trim())
        if (c && Number.isFinite(Number(v))) out[c.toLowerCase()] = Number(v)
      }
      return out
    }
    return Number(t) || 0.5
  }
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/allocate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circuit: toCircuitJSON(useCircuitStore.getState()),
          rows: payload(),
          options: { keyBy, hours, loadFactor: loadFactor(), targetHeadKw: target.trim() ? Number(target) : null, intervalMin },
        }),
      })
      if (!res.ok) throw new Error((await res.json()).detail ?? `${res.status}`)
      const r = (await res.json()) as AllocationResult
      if (!r.converged) setError(r.issues.find((i) => i.severity === 'error')?.message ?? 'The allocated model does not converge.')
      setResult(r)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const apply = (asScenario: boolean) => {
    if (!result) return
    for (const [name, spec] of Object.entries(result.loadShapes)) setLoadShape(name, spec as LoadShapeJSON)
    if (asScenario) addScenario(`Allocated loads${result.targetHeadKw ? ` to ${result.targetHeadKw} kW` : ''}`)
    for (const [id, patch] of Object.entries(result.overrides)) updateNodeParams(id, patch)
    setFlash(`${Object.keys(result.overrides).length} loads set${asScenario ? ' in a new scenario' : ''}.`, 'info')
    onClose()
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box wide" role="dialog" aria-label="Allocate loads" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-title">Allocate loads from meter data</div>
        <LockedNote feature="studies" />
        <textarea
          className="alloc-text"
          aria-label="Meter data"
          placeholder={mode === 'intervals' ? 'load, kW at each interval…\nL1, 2.1, 2.4, 3.0, …' : mode === 'kwh' ? 'load, kWh for the period\nL1, 1460\nL2, 980' : 'load, kW\nL1, 4.2'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="alloc-grid">
          <label>
            The rows hold
            <select aria-label="Data kind" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="kwh">kWh for a period (billing)</option>
              <option value="kw">kW demand</option>
              <option value="intervals">kW intervals (AMI)</option>
            </select>
          </label>
          <label>
            Matched to loads by
            <select aria-label="Key by" value={keyBy} onChange={(e) => setKeyBy(e.target.value as 'name' | 'bus' | 'class')}>
              <option value="name">name</option>
              <option value="bus">bus</option>
              <option value="class">class (split evenly)</option>
            </select>
          </label>
          <label>
            Key column
            <select aria-label="Key column" value={keyCol} onChange={(e) => setKeyCol(Number(e.target.value))}>
              {Array.from({ length: columns }, (_, i) => (
                <option key={i} value={i}>{header?.[i] ?? `column ${i + 1}`}</option>
              ))}
            </select>
          </label>
          {mode !== 'intervals' && (
            <label>
              Value column
              <select aria-label="Value column" value={valueCol} onChange={(e) => setValueCol(Number(e.target.value))}>
                {Array.from({ length: columns }, (_, i) => (
                  <option key={i} value={i}>{header?.[i] ?? `column ${i + 1}`}</option>
                ))}
              </select>
            </label>
          )}
          <label className="prefs-radio">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> first row is a header
          </label>
          {mode === 'kwh' && (
            <>
              <label>
                Hours in the period
                <input type="number" aria-label="Hours" value={hours} onChange={(e) => setHours(Number(e.target.value))} />
              </label>
              <label>
                Load factor (a number, or class=LF, …)
                <input aria-label="Load factor" value={lf} onChange={(e) => setLf(e.target.value)} />
              </label>
            </>
          )}
          {mode === 'intervals' && (
            <label>
              Minutes per interval
              <select aria-label="Interval" value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))}>
                <option value={60}>60</option>
                <option value={15}>15</option>
              </select>
            </label>
          )}
          <label>
            Metered feeder head (kW, optional)
            <input type="number" aria-label="Target head kW" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="scale the model to this" />
          </label>
        </div>
        <div className="project-buttons">
          <button type="button" className="modal-primary" disabled={busy || !body.length} onClick={() => void run()}>
            {busy ? 'Allocating…' : 'Preview the allocation'}
          </button>
          {error && <span className="modal-error">{error}</span>}
        </div>
        {result && (
          <div className="screen-result">
            <div className="reliability-indices">
              <span className="reliability-index"><b>{result.matched.length}</b> loads set · {result.totalKw.toFixed(0)} kW in all</span>
              <span className="reliability-index"><b>Head</b> {result.headKwBefore ?? '—'} → {result.headKwAfter ?? '—'} kW{result.scale ? ` (×${result.scale})` : ''}</span>
              {result.unmatched.length > 0 && <span className="reliability-index"><b>{result.unmatched.length}</b> keys matched nothing: {result.unmatched.slice(0, 5).join(', ')}{result.unmatched.length > 5 ? '…' : ''}</span>}
              {result.noData.length > 0 && <span className="reliability-index"><b>{result.noData.length}</b> loads had no data: {result.noData.slice(0, 5).join(', ')}{result.noData.length > 5 ? '…' : ''}</span>}
            </div>
            <table className="bp-table">
              <thead><tr><th>Load</th><th>Before</th><th>After</th><th>From</th></tr></thead>
              <tbody>
                {result.matched.slice(0, 200).map((m) => (
                  <tr key={m.id}>
                    <td className="bp-ro">{m.name}</td>
                    <td className="bp-ro">{m.before == null ? '—' : `${m.before} kW`}</td>
                    <td className="bp-ro">{m.kw} kW</td>
                    <td className="bp-ro">{m.from}{m.points ? ` (${m.points} points)` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="project-buttons">
              <button type="button" className="modal-primary" onClick={() => apply(true)}>Apply as a new scenario</button>
              <button type="button" onClick={() => apply(false)}>Apply to the open circuit</button>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
