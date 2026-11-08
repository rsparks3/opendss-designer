import { useState } from 'react'
import { runBatch } from '../lib/batch'
import { levelNamed, scenarioSize } from '../lib/scenarios'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import type { BatchCell } from '../types/circuit'

/**
 * The Scenarios tab: the base case and every alternative, which one is
 * open, and the batch matrix (every scenario at every load level) with the
 * worst voltage, worst loading, losses and violations of each cell.
 */
export function ScenariosPanel() {
  const scenarios = useCircuitStore((s) => s.scenarios)
  const active = useCircuitStore((s) => s.activeScenario)
  const levels = useCircuitStore((s) => s.loadLevels)
  const activeLevel = useCircuitStore((s) => s.activeLevel)
  const addScenario = useCircuitStore((s) => s.addScenario)
  const updateScenario = useCircuitStore((s) => s.updateScenario)
  const removeScenario = useCircuitStore((s) => s.removeScenario)
  const duplicateScenario = useCircuitStore((s) => s.duplicateScenario)
  const activateScenario = useCircuitStore((s) => s.activateScenario)
  const setActiveLevel = useCircuitStore((s) => s.setActiveLevel)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  const openDialog = useUiStore((s) => s.openDialog)
  const batch = useResultsStore((s) => s.batch)
  const running = useResultsStore((s) => s.batchRunning)
  const progress = useResultsStore((s) => s.batchProgress)
  const abort = useResultsStore((s) => s.batchAbort)
  const result = useResultsStore((s) => s.result)
  const pinBaseline = useResultsStore((s) => s.pinBaseline)
  const baseline = useResultsStore((s) => s.baseline)
  const [draft, setDraft] = useState('')

  const hasElements = nodes.some((n) => n.type !== 'note' && n.type !== 'zone')
  const name = (id: string | null) => (id ? scenarios.find((sc) => sc.id === id)?.name ?? id : 'Base case')
  const add = () => {
    const id = addScenario(draft || `Alternative ${scenarios.length + 1}`)
    setDraft('')
    return id
  }
  const locate = (id: string | null) => {
    if (!id) return
    const isEdge = edges.some((e) => e.id === id)
    selectOnly(isEdge ? 'edge' : 'node', id)
  }
  const elementName = (full: string | null, id: string | null) => {
    if (id) {
      const n = nodes.find((x) => x.id === id)
      const e = n ? undefined : edges.find((x) => x.id === id)
      const nm = n?.data.params.name ?? e?.data?.params.name
      if (typeof nm === 'string' && nm) return nm
    }
    return full ? full.split('.', 2)[1] ?? full : '—'
  }
  const f = (v: number | null | undefined, d: number) => (v == null ? '—' : v.toFixed(d))

  return (
    <div className="scenarios-panel">
      <div className="scenarios-side">
        <div className="scenarios-head">
          <b>Load level</b>
          <select
            aria-label="Load level"
            value={activeLevel ?? ''}
            onChange={(e) => setActiveLevel(e.target.value || null)}
          >
            <option value="">Rated (every load at its kW)</option>
            {(levels ?? []).map((l) => (
              <option key={l.name} value={l.name}>
                {l.name} · ×{l.loadmult}{l.rating === 'emergency' ? ', emergency rating' : ''}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => openDialog('project')} title="Add or edit load levels in Project properties">
            Edit levels…
          </button>
        </div>
        <div className="scenarios-head">
          <b>Scenarios</b>
        </div>
        <ul className="scenarios-list">
          <li className={active === null ? 'active' : ''}>
            <button type="button" className="scenarios-pick" onClick={() => activateScenario(null)}>
              Base case
            </button>
          </li>
          {scenarios.map((sc) => (
            <li key={sc.id} className={active === sc.id ? 'active' : ''}>
              <button type="button" className="scenarios-pick" onClick={() => activateScenario(sc.id)} title={sc.description || undefined}>
                {sc.name}
                <span className="scenarios-count">
                  {active === sc.id ? 'editing' : `${scenarioSize(sc)} change${scenarioSize(sc) === 1 ? '' : 's'}`}
                </span>
              </button>
              <button type="button" className="scenarios-mini" title="Duplicate" onClick={() => duplicateScenario(sc.id)}>⧉</button>
              <button type="button" className="scenarios-mini" title="Delete this scenario" onClick={() => removeScenario(sc.id)}>✕</button>
            </li>
          ))}
        </ul>
        <div className="scenarios-add">
          <input
            aria-label="New scenario name"
            placeholder="New scenario name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button type="button" onClick={add} disabled={!hasElements}>+ Add</button>
        </div>
        {active && (
          <div className="library-note">
            Editing <b>{name(active)}</b>: every change on the drawing belongs to this scenario until you
            go back to the base case. Elements can be changed, added, removed, opened or taken out of
            service.
            <label className="scenarios-desc">
              Description
              <textarea
                rows={2}
                value={scenarios.find((sc) => sc.id === active)?.description ?? ''}
                onChange={(e) => updateScenario(active, { description: e.target.value })}
              />
            </label>
          </div>
        )}
        <div className="scenarios-compare">
          <button
            type="button"
            disabled={!result?.converged}
            onClick={() => pinBaseline(`${name(active)} at ${levelNamed(levels, activeLevel).name}`)}
            title="Keep this solve as the 'before'; the Compare overlay and tab show the next solve against it"
          >
            Pin solve as baseline
          </button>
          {baseline && <span className="scenarios-count">baseline: {baseline.label}</span>}
        </div>
      </div>
      <div className="scenarios-main">
        <div className="scenarios-head">
          <b>Batch</b>
          <span className="scenarios-count">
            {1 + scenarios.length} case{scenarios.length ? 's' : ''} × {levels?.length || 1} level{(levels?.length ?? 0) === 1 ? '' : 's'}
          </span>
          {running ? (
            <button type="button" onClick={() => abort?.abort()}>
              ✕ {progress ? `${progress.done} / ${progress.total}` : 'Starting…'}
            </button>
          ) : (
            <button type="button" disabled={!hasElements} onClick={() => void runBatch()} title="Solve every scenario at every load level">
              ▶ Run all
            </button>
          )}
          {batch && <span className="scenarios-count">run {new Date(batch.ranAt).toLocaleTimeString()}</span>}
        </div>
        {!batch ? (
          <div className="bp-empty">
            Run all solves the base case and every scenario at every load level and lists the worst voltage,
            the worst loading, the losses and the number of violations of each, so alternatives compare in one
            table. Define levels in Project properties and scenarios on the left.
          </div>
        ) : (
          <table className="bp-table scenarios-matrix">
            <thead>
              <tr>
                <th>Case</th>
                <th>Level</th>
                <th>Source kW</th>
                <th>Min V (pu)</th>
                <th>at</th>
                <th>Max V (pu)</th>
                <th>Max loading</th>
                <th>element</th>
                <th>Losses (kW)</th>
                <th>Under / over V</th>
                <th>Overloads / warnings</th>
              </tr>
            </thead>
            <tbody>
              {batch.result.cells.map((c: BatchCell, i) => (
                <tr key={i} className={!c.converged ? 'error' : c.undervoltages + c.overvoltages + c.overloads ? 'warning' : ''}>
                  <td className="bp-ro">{c.scenarioName}</td>
                  <td className="bp-ro">{c.levelName}{c.rating === 'emergency' ? ' (emerg.)' : ''}</td>
                  <td className="bp-ro">{c.converged ? f(c.sourceKw, 0) : c.errors[0] ?? 'did not converge'}</td>
                  <td className="bp-ro">{f(c.minVpu, 3)}</td>
                  <td className="bp-ro">{c.minVBus ?? '—'}</td>
                  <td className="bp-ro">{f(c.maxVpu, 3)}</td>
                  <td className="bp-ro">{c.maxLoadingPct == null ? '—' : `${c.maxLoadingPct.toFixed(0)} %`}</td>
                  <td className="bp-ro">
                    {c.maxLoadingId ? (
                      <button className="bp-locate" title="Select on diagram" onClick={() => locate(c.maxLoadingId)}>⌖</button>
                    ) : null}{' '}
                    {elementName(c.maxLoadingElement, c.maxLoadingId)}
                  </td>
                  <td className="bp-ro">{f(c.lossKw, 1)}</td>
                  <td className="bp-ro">{c.undervoltages} / {c.overvoltages}</td>
                  <td className="bp-ro">{c.overloads} / {c.loadingWarnings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
