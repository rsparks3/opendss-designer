import { useState } from 'react'
import { runBatch } from '../lib/batch'
import { levelNamed, scenarioSize } from '../lib/scenarios'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import type { BatchCell } from '../types/circuit'
import { LockedNote } from './LockedNote'
import { compareTable, type CompareMetric, type CompareTable } from '../lib/scenarioCompare'

/** One column per scenario, the worst value of each row picked out. */
function CompareView({ table, metric, onLocate }: { table: CompareTable; metric: CompareMetric; onLocate: (id: string) => void }) {
  const fmt = (v: number | null) =>
    v == null ? '—' : metric === 'voltage' ? (v < 0.05 ? 'dark' : v.toFixed(3)) : metric === 'loading' ? `${v.toFixed(0)} %` : `${v.toFixed(0)} kW`
  if (!table.rows.length) return <div className="bp-empty">Nothing to compare at this level: run all again.</div>
  return (
    <table className="bp-table scenarios-matrix scenarios-compare-table">
      <thead>
        <tr>
          <th>{metric === 'unserved' ? 'Priority' : metric === 'voltage' ? 'Bus (lowest phase)' : 'Element'}</th>
          {table.columns.map((c) => <th key={String(c.id)}>{c.name}</th>)}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((r) => (
          <tr key={r.key}>
            <td className="bp-ro">
              {r.elementId && <button className="bp-locate" title="Select on diagram" onClick={() => onLocate(r.elementId!)}>⌖</button>}{' '}
              {r.label}
            </td>
            {r.values.map((v, i) => (
              <td key={i} className={`bp-ro${r.worst === i ? ' worst' : ''}`}>{fmt(v)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

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
  const [renaming, setRenaming] = useState<string | null>(null)
  const [view, setView] = useState<'matrix' | CompareMetric>('matrix')
  const [compareLevel, setCompareLevel] = useState<string | null>(null)
  const [promoting, setPromoting] = useState<string | null>(null)
  const moveScenario = useCircuitStore((s) => s.moveScenario)
  const promoteScenario = useCircuitStore((s) => s.promoteScenario)

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
        <LockedNote feature="studies" />
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
          {scenarios.map((sc, i) => (
            <li key={sc.id} className={active === sc.id ? 'active' : ''}>
              {renaming === sc.id ? (
                <input
                  className="scenarios-rename"
                  aria-label="Scenario name"
                  autoFocus
                  defaultValue={sc.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v) updateScenario(sc.id, { name: v })
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <button type="button" className="scenarios-pick" onClick={() => activateScenario(sc.id)}
                        onDoubleClick={() => setRenaming(sc.id)} title={sc.description || 'Double-click to rename'}>
                  {sc.name}
                  <span className="scenarios-count">
                    {active === sc.id ? 'editing' : `${scenarioSize(sc)} change${scenarioSize(sc) === 1 ? '' : 's'}`}
                  </span>
                </button>
              )}
              <button type="button" className="scenarios-mini" title="Rename" onClick={() => setRenaming(sc.id)}>✎</button>
              <button type="button" className="scenarios-mini" title="Move up" disabled={i === 0} onClick={() => moveScenario(sc.id, -1)}>↑</button>
              <button type="button" className="scenarios-mini" title="Move down" disabled={i === scenarios.length - 1} onClick={() => moveScenario(sc.id, 1)}>↓</button>
              <button type="button" className="scenarios-mini" title="Duplicate" onClick={() => duplicateScenario(sc.id)}>⧉</button>
              <button
                type="button"
                className={`scenarios-mini${promoting === sc.id ? ' danger' : ''}`}
                title={promoting === sc.id
                  ? 'Click again to make this the base case (the other scenarios are kept, rebased; this cannot be undone)'
                  : 'Promote to base case'}
                onClick={() => {
                  if (promoting !== sc.id) return setPromoting(sc.id)
                  setPromoting(null)
                  promoteScenario(sc.id)
                }}
                onBlur={() => setPromoting(null)}
              >
                {promoting === sc.id ? 'Make base?' : '⤒'}
              </button>
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
        <div className="scenarios-add">
          <button
            type="button"
            disabled={!nodes.some((n) => n.type === 'generator')}
            title={nodes.some((n) => n.type === 'generator')
              ? 'A scenario with every utility source out of service and every generator in service and isochronous'
              : 'Add a generator first: with the utility gone, nothing else carries load'}
            onClick={() => {
              if (useCircuitStore.getState().addUtilityOutageScenario()) useResultsStore.getState().setOverlay('islands')
            }}
          >
            ⚡ Utility outage
          </button>
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
          {batch && (
            <span className="scenarios-view">
              <select aria-label="Batch view" value={view} onChange={(e) => setView(e.target.value as typeof view)}>
                <option value="matrix">Summary matrix</option>
                <option value="unserved">Compare: unserved load</option>
                <option value="voltage">Compare: bus voltage</option>
                <option value="loading">Compare: element loading</option>
              </select>
              {view !== 'matrix' && batch.result.levels.length > 1 && (
                <select aria-label="Level to compare" value={String(compareLevel ?? '')}
                        onChange={(e) => setCompareLevel(e.target.value || null)}>
                  {batch.result.levels.map((l) => <option key={String(l)} value={String(l ?? '')}>{l ?? 'Rated'}</option>)}
                </select>
              )}
            </span>
          )}
        </div>
        {!batch ? (
          <div className="bp-empty">
            Run all solves the base case and every scenario at every load level and lists the worst voltage,
            the worst loading, the losses and the number of violations of each, so alternatives compare in one
            table. Define levels in Project properties and scenarios on the left.
          </div>
        ) : view !== 'matrix' ? (
          <CompareView table={compareTable(batch.result, compareLevel ?? batch.result.levels[0] ?? null, view,
            (id) => elementName(null, id))} metric={view} onLocate={locate} />
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
