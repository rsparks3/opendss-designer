import { useEffect, useMemo, useRef, useState } from 'react'
import { formatFactors, parseFactors, zoneLoads } from '../lib/allocation'
import { buildTopology } from '../lib/trace'
import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import type { AllocationJSON } from '../types/circuit'
import { LockedNote } from './LockedNote'

interface ZoneResult {
  ok: boolean
  error?: string
  allocation?: AllocationJSON
  factor?: number
  kvarFactor?: number | null
  achievedKw?: number
  achievedKvar?: number
  targetKvar?: number | null
  measuredBeforeKw?: number
  iterations?: number
  converged?: boolean
  loads?: number
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? `${res.status}`)
  return (await res.json()) as T
}

/**
 * Right-click a meter point → Allocate to a metered value: scale every load
 * below it until the solve agrees with the measurement. The factor is
 * stored with the project and applied when the circuit compiles, so the
 * loads keep the values entered; Bake writes it into them instead.
 */
export function ZoneAllocationDialog({ onClose }: { onClose: () => void }) {
  const meterId = useUiStore((s) => s.allocationMeter)
  const allocations = useCircuitStore((s) => s.allocations)
  const setAllocations = useCircuitStore((s) => s.setAllocations)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const base = useCircuitStore((s) => s.scenarioBase)
  const setFlash = useResultsStore((s) => s.setFlash)
  const existing = allocations.find((a) => a.meterElementId === meterId)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  const [targetKW, setTargetKW] = useState(existing ? String(existing.targetKW) : '')
  const [reactive, setReactive] = useState<'none' | 'kvar' | 'pf'>(existing?.targetKvar != null ? 'kvar' : existing?.targetPF != null ? 'pf' : 'none')
  const [reactiveValue, setReactiveValue] = useState(String(existing?.targetKvar ?? existing?.targetPF ?? ''))
  const [factors, setFactors] = useState(formatFactors(existing?.demandFactors))
  const [source, setSource] = useState(existing?.source ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ZoneResult | null>(null)

  const drawing = base ?? { nodes, edges }
  const meterName = String(
    drawing.nodes.find((n) => n.id === meterId)?.data.params.name ?? drawing.edges.find((e) => e.id === meterId)?.data?.params.name ?? meterId,
  )
  const zone = useMemo(() => {
    if (!meterId) return { all: 0, fixed: 0 }
    const topo = buildTopology(drawing.nodes, drawing.edges)
    const ids = zoneLoads(topo, meterId)
    return { all: ids.length, fixed: ids.filter((id) => topo.nodes.get(id)?.data.params.fixed === true).length }
  }, [meterId, drawing.nodes, drawing.edges])

  if (!meterId) return null
  const id = existing?.id ?? `al_${meterId}`.slice(0, 64)
  const spec = (): AllocationJSON => ({
    id,
    meterElementId: meterId,
    targetKW: Number(targetKW),
    targetKvar: reactive === 'kvar' && reactiveValue.trim() ? Number(reactiveValue) : null,
    targetPF: reactive === 'pf' && reactiveValue.trim() ? Number(reactiveValue) : null,
    demandFactors: parseFactors(factors),
    source,
  })
  const valid = Number(targetKW) > 0 && (reactive !== 'pf' || (Number(reactiveValue) > 0 && Number(reactiveValue) <= 1))

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await post<ZoneResult>('/api/allocate/zone', { circuit: toCircuitJSON(useCircuitStore.getState()), allocation: spec() })
      if (!r.ok) setError(r.error ?? 'The allocation could not be run.')
      setResult(r)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const store = (a: AllocationJSON) => setAllocations([...allocations.filter((x) => x.id !== a.id), a])
  const apply = () => {
    if (!result?.allocation) return
    store(result.allocation)
    setFlash(`Allocation stored: ${result.loads} loads × ${result.factor?.toFixed(4)} when the circuit is solved.`, 'info')
    onClose()
  }
  const clear = () => {
    setAllocations(allocations.filter((a) => a.id !== id))
    setFlash('Allocation cleared: the loads are back to their entered values.', 'info')
    onClose()
  }
  const bake = async () => {
    const chosen = result?.allocation ?? existing
    if (!chosen?.lastFactor) return
    // Baking writes load values: into the base case, whatever is open.
    useCircuitStore.getState().activateScenario(null)
    const st = useCircuitStore.getState()
    const doc = { ...toCircuitJSON(st), allocations: [...st.allocations.filter((a) => a.id !== chosen.id), chosen] }
    try {
      const r = await post<{ ok: boolean; error?: string; overrides?: Record<string, Record<string, unknown>> }>(
        '/api/allocate/bake', { circuit: doc, allocationId: chosen.id })
      if (!r.ok || !r.overrides) throw new Error(r.error ?? 'Could not bake the allocation.')
      for (const [lid, patch] of Object.entries(r.overrides)) useCircuitStore.getState().updateNodeParams(lid, patch)
      setAllocations(useCircuitStore.getState().allocations.filter((a) => a.id !== chosen.id))
      setFlash(`${Object.keys(r.overrides).length} loads now carry the allocated values; the allocation is removed.`, 'info')
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" role="dialog" aria-label="Allocate to a metered value" tabIndex={-1} ref={box}
           onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-title">Allocate to a metered value · {meterName}</div>
        <LockedNote feature="studies" />
        <div className="library-note">
          Scales the {zone.all - zone.fixed} load{zone.all - zone.fixed === 1 ? '' : 's'} below {meterName}
          {zone.fixed ? ` (${zone.fixed} fixed, left alone)` : ''} so the solved power there matches the meter. The
          factor is stored and applied at every solve; the loads keep the values entered.
        </div>
        {existing?.lastFactor != null && !result && (
          <div className="library-note">
            Stored: ×{existing.lastFactor.toFixed(4)}{existing.lastKvarFactor != null ? ` (kvar ×${existing.lastKvarFactor.toFixed(4)})` : ''},
            {' '}{existing.lastAchievedKW} kW achieved in {existing.lastIterations} iteration{existing.lastIterations === 1 ? '' : 's'}
            {existing.lastConverged ? '' : ' (did not converge)'}.
          </div>
        )}
        <div className="alloc-grid">
          <label>
            Measured kW
            <input type="number" aria-label="Measured kW" value={targetKW} onChange={(e) => setTargetKW(e.target.value)} placeholder="e.g. 4200" />
          </label>
          <label>
            Reactive power
            <select aria-label="Reactive target" value={reactive} onChange={(e) => setReactive(e.target.value as typeof reactive)}>
              <option value="none">keep each load's power factor</option>
              <option value="kvar">measured kvar</option>
              <option value="pf">measured power factor</option>
            </select>
          </label>
          {reactive !== 'none' && (
            <label>
              {reactive === 'kvar' ? 'Measured kvar' : 'Measured PF'}
              <input type="number" aria-label="Reactive value" value={reactiveValue} onChange={(e) => setReactiveValue(e.target.value)} />
            </label>
          )}
          <label>
            Demand factors (priority or tag = factor)
            <input aria-label="Demand factors" value={factors} onChange={(e) => setFactors(e.target.value)} placeholder="nonessential=0.8, hvac=0.9" />
          </label>
          <label>
            Source of the measurement
            <input aria-label="Measurement source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Substation meter, July 2026 peak" />
          </label>
        </div>
        <div className="project-buttons">
          <button type="button" className="modal-primary" disabled={busy || !valid} onClick={() => void run()}>
            {busy ? 'Allocating…' : 'Run'}
          </button>
          {error && <span className="modal-error">{error}</span>}
        </div>
        {result?.ok && (
          <div className="screen-result">
            <div className="reliability-indices">
              <span className="reliability-index"><b>Factor</b> ×{result.factor?.toFixed(4)}{result.kvarFactor != null ? ` · kvar ×${result.kvarFactor.toFixed(4)}` : ''}</span>
              <span className="reliability-index"><b>Measured</b> {result.measuredBeforeKw} → {result.achievedKw} kW (target {Number(targetKW)})</span>
              {result.targetKvar != null && <span className="reliability-index"><b>kvar</b> {result.achievedKvar} (target {result.targetKvar})</span>}
              <span className="reliability-index">
                {result.converged ? `within 0.5 % in ${result.iterations} iteration${result.iterations === 1 ? '' : 's'}` : `did not reach 0.5 % in ${result.iterations} iterations`}
                {' '}· {result.loads} loads
              </span>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="modal-primary" disabled={!result?.ok} onClick={apply}>Apply</button>
          <button type="button" disabled={!(result?.ok || existing?.lastFactor)} onClick={() => void bake()}
                  title="Write the scaled values into the loads (base case) and remove the allocation">Bake into loads</button>
          <button type="button" disabled={!existing} onClick={clear}>Clear</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
