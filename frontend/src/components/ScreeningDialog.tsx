import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import type { ScreenOptions, ScreenResult } from '../types/circuit'
import { LockedNote } from './LockedNote'

const DEFAULTS: ScreenOptions = {
  kw: 500,
  pf: 1,
  kva: null,
  derType: 'inverter',
  export: true,
  aggregatePct: 15,
  minLoadPct: 100,
  faultIncreasePct: 10,
  interruptingPct: 87.5,
  deviationPct: 3,
  thermalPct: 100,
  inverterCategory: 'B',
}

/** Analysis → Screen a DER…: one application at a point of common coupling
 *  through the interconnection screens, with the standard report. */
export function ScreeningDialog({ onClose }: { onClose: () => void }) {
  const nodes = useCircuitStore((s) => s.nodes)
  const result = useResultsStore((s) => s.result)
  const target = useUiStore((s) => s.screenTarget)
  const setScreening = useResultsStore((s) => s.setScreening)
  const screening = useResultsStore((s) => s.screening)
  const [opts, setOpts] = useState<ScreenOptions>(DEFAULTS)
  const [bus, setBus] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [out, setOut] = useState<ScreenResult | null>(screening)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  // Buses to pick from: every bus a node sits on, named as the drawing
  // names them, from the last solve (the engine's bus names) or the nodes.
  const choices = useMemo(() => {
    const seen = new Map<string, string>()
    const nodeBuses = result?.nodeBuses ?? {}
    for (const n of nodes) {
      if (n.type === 'note' || n.type === 'zone') continue
      const b = nodeBuses[n.id]?.[0]
      if (!b || seen.has(b)) continue
      const label = n.type === 'busbar' ? String(n.data.params.name ?? b) : `${result?.busNames[b] ?? b} (${String(n.data.params.name ?? n.type)})`
      seen.set(b, label)
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]))
  }, [nodes, result])
  useEffect(() => {
    if (!bus && choices.length) {
      const fromTarget = target ? (result?.nodeBuses[target]?.[0] ?? null) : null
      setBus(fromTarget && choices.some(([b]) => b === fromTarget) ? fromTarget : choices[0][0])
    }
  }, [choices, bus, target, result])

  const set = <K extends keyof ScreenOptions>(key: K, value: ScreenOptions[K]) => setOpts({ ...opts, [key]: value })
  const run = async () => {
    if (!bus) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.screen(toCircuitJSON(useCircuitStore.getState()), bus, opts)
      if (!r.converged) {
        setError(r.issues.find((i) => i.severity === 'error')?.message ?? 'The screens could not be run.')
      } else {
        setOut(r)
        setScreening(r)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const verdict = (p: boolean | null) => (p === null ? '—' : p ? 'pass' : 'FAIL')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box wide" role="dialog" aria-label="Screen a DER" tabIndex={-1} ref={box}
           onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <LockedNote feature="studies" />
        <div className="modal-title">Screen a DER interconnection</div>
        {!result?.converged && (
          <div className="library-note">Solve the circuit once so the buses can be listed by name.</div>
        )}
        <div className="project-grid">
          <label>
            Point of common coupling
            <select aria-label="Point of common coupling" value={bus} onChange={(e) => setBus(e.target.value)}>
              {choices.map(([b, label]) => (
                <option key={b} value={b}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Size (kW)
            <input type="number" step={10} aria-label="Size kW" value={opts.kw} onChange={(e) => set('kw', Number(e.target.value))} />
          </label>
          <label>
            Power factor
            <input type="number" step={0.01} aria-label="Power factor" value={opts.pf} onChange={(e) => set('pf', Number(e.target.value))} />
          </label>
          <label>
            Inverter rating (kVA, blank = kW/pf)
            <input type="number" step={10} aria-label="kVA" value={opts.kva ?? ''} onChange={(e) => set('kva', e.target.value ? Number(e.target.value) : null)} />
          </label>
          <label>
            Unit
            <select aria-label="Unit type" value={opts.derType} onChange={(e) => set('derType', e.target.value as ScreenOptions['derType'])}>
              <option value="inverter">inverter</option>
              <option value="synchronous">synchronous machine</option>
            </select>
          </label>
          <label className="prefs-radio">
            <input type="checkbox" checked={opts.export} onChange={(e) => set('export', e.target.checked)} /> exports to the grid
          </label>
        </div>
        <details>
          <summary>Screen limits</summary>
          <div className="project-grid">
            <label>Aggregate (% of section peak)<input type="number" value={opts.aggregatePct} onChange={(e) => set('aggregatePct', Number(e.target.value))} /></label>
            <label>Supplemental (% of minimum load)<input type="number" value={opts.minLoadPct} onChange={(e) => set('minLoadPct', Number(e.target.value))} /></label>
            <label>Fault-current increase (%)<input type="number" value={opts.faultIncreasePct} onChange={(e) => set('faultIncreasePct', Number(e.target.value))} /></label>
            <label>Interrupting duty (%)<input type="number" value={opts.interruptingPct} onChange={(e) => set('interruptingPct', Number(e.target.value))} /></label>
            <label>Rapid voltage change (%)<input type="number" value={opts.deviationPct} onChange={(e) => set('deviationPct', Number(e.target.value))} /></label>
            <label>Loading (%)<input type="number" value={opts.thermalPct} onChange={(e) => set('thermalPct', Number(e.target.value))} /></label>
            <label>
              IEEE 1547 category
              <select value={opts.inverterCategory} onChange={(e) => set('inverterCategory', e.target.value as 'A' | 'B')}>
                <option value="A">A</option>
                <option value="B">B</option>
              </select>
            </label>
          </div>
        </details>
        <div className="project-buttons">
          <button type="button" className="modal-primary" disabled={busy || !bus} onClick={() => void run()}>
            {busy ? 'Running the screens…' : 'Run the screens'}
          </button>
          {error && <span className="modal-error">{error}</span>}
        </div>
        {out && (
          <div className="screen-result">
            <div className={`screen-outcome ${out.outcome}`}>
              {out.outcome === 'pass' ? 'Passes the screens' : out.outcome === 'supplemental' ? 'Needs supplemental review' : 'Fails the screens'}
              {' · '}{out.unit.kw} kW {out.unit.derType} at {out.busName} ({out.kvBase} kV, {out.phases}φ) · {out.loadLevel.name}
            </div>
            <table className="bp-table">
              <thead>
                <tr>
                  <th>Screen</th>
                  <th>Value</th>
                  <th>Limit</th>
                  <th>Result</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {out.screens.map((s) => (
                  <tr key={s.key} className={s.pass === false ? 'violation' : ''}>
                    <td className="bp-ro">{s.label}</td>
                    <td className="bp-ro">{s.value == null ? '—' : `${s.value} ${s.unit}`}</td>
                    <td className="bp-ro">{s.limit == null ? '—' : `${s.limit} ${s.unit}`}</td>
                    <td className="bp-ro">{verdict(s.pass)}</td>
                    <td className="bp-ro">{s.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="library-note">
              Section: {out.section.peakLoadKw} kW peak load, {out.section.minLoadKw} kW minimum (×{out.section.minLoadMult}),
              {' '}{out.section.existingDerKw} kW of DER already connected. The report's <i>Interconnection screening</i> section
              prints this table.
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
