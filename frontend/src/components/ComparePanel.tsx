import { useMemo, useState } from 'react'
import { chooseOverlay } from '../lib/fileActions'
import { compareResults, type CompareRow } from '../lib/compare'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'

/** The Compare tab: the current solve against the pinned baseline, bus by
 *  bus and element by element, largest change first. */
export function ComparePanel() {
  const baseline = useResultsStore((s) => s.baseline)
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
  const overlay = useResultsStore((s) => s.overlay)
  const clearBaseline = useResultsStore((s) => s.clearBaseline)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const scenarios = useCircuitStore((s) => s.scenarios)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  const [kind, setKind] = useState<'buses' | 'elements'>('buses')
  const [onlyChanged, setOnlyChanged] = useState(true)

  const rows = useMemo(
    () => (baseline && result?.converged ? compareResults(baseline.result, result) : null),
    [baseline, result],
  )
  if (!baseline) {
    return (
      <div className="bp-empty">
        <p>
          Pin a solve as the baseline (Scenarios tab, or Analysis → Pin solve as baseline), then change the
          circuit, pick another scenario or load level and solve again: this tab lists every bus and element
          whose result changed, largest change first, and the Compare overlay draws the differences.
        </p>
      </div>
    )
  }
  if (!rows) {
    return <div className="bp-empty">Baseline <b>{baseline.label}</b> is pinned. Solve the circuit to compare against it.</div>
  }
  const list = (kind === 'buses' ? rows.buses : rows.elements).filter((r) => !onlyChanged || r.changed)
  const nameOf = (r: CompareRow) => {
    if (r.id) {
      const n = nodes.find((x) => x.id === r.id)
      const e = n ? undefined : edges.find((x) => x.id === r.id)
      const nm = n?.data.params.name ?? e?.data?.params.name
      if (typeof nm === 'string' && nm) return nm
    }
    return r.label
  }
  const locate = (r: CompareRow) => {
    if (!r.id) return
    const isEdge = edges.some((e) => e.id === r.id)
    selectOnly(isEdge ? 'edge' : 'node', r.id)
  }
  const d = (v: number | null, digits: number, unit = '') =>
    v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}${unit}`
  return (
    <div className="compare-panel">
      <div className="reliability-indices">
        <span className="reliability-index">
          <b>Baseline</b> {baseline.label}
        </span>
        <span className="reliability-index">
          <b>Now</b> {result?.scenario ? (scenarios.find((s) => s.id === result.scenario)?.name ?? result.scenario) : 'Base case'} at{' '}
          {result?.loadLevel?.name ?? 'Rated'}{stale ? ' (stale)' : ''}
        </span>
        <span className="reliability-index">
          <b>Losses</b> {d(rows.lossKw, 1, ' kW')}
        </span>
        <span className="reliability-index">
          <b>Min V</b> {d(rows.minV, 4, ' pu')} · <b>Max loading</b> {d(rows.maxLoading, 1, ' %')}
        </span>
        <span className="reliability-index">
          <b>Violations</b> {rows.violationsBefore} → {rows.violationsAfter}
        </span>
        {overlay !== 'compare' && (
          <button type="button" onClick={() => chooseOverlay('compare')} title="Draw the differences on the one-line">
            Show on the drawing
          </button>
        )}
        <button type="button" onClick={clearBaseline}>Unpin</button>
      </div>
      <div className="scenarios-head">
        <label className="prefs-radio">
          <input type="radio" checked={kind === 'buses'} onChange={() => setKind('buses')} /> Buses ({rows.buses.filter((r) => r.changed).length} changed)
        </label>
        <label className="prefs-radio">
          <input type="radio" checked={kind === 'elements'} onChange={() => setKind('elements')} /> Elements ({rows.elements.filter((r) => r.changed).length} changed)
        </label>
        <label className="prefs-radio">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only what changed
        </label>
      </div>
      <table className="bp-table">
        <thead>
          {kind === 'buses' ? (
            <tr>
              <th />
              <th>Bus</th>
              <th>Before (pu)</th>
              <th>After (pu)</th>
              <th>Δ V (pu)</th>
              <th>Status</th>
            </tr>
          ) : (
            <tr>
              <th />
              <th>Element</th>
              <th>Loading before</th>
              <th>Loading after</th>
              <th>Δ loading</th>
              <th>Δ kW</th>
              <th>Δ losses (kW)</th>
            </tr>
          )}
        </thead>
        <tbody>
          {list.slice(0, 500).map((r) => (
            <tr key={r.key} className={r.flag ?? ''}>
              <td>
                {r.id && (
                  <button className="bp-locate" title="Select on diagram" onClick={() => locate(r)}>⌖</button>
                )}
              </td>
              <td className="bp-ro">{nameOf(r)}</td>
              {kind === 'buses' ? (
                <>
                  <td className="bp-ro">{r.before == null ? '—' : r.before.toFixed(4)}</td>
                  <td className="bp-ro">{r.after == null ? '—' : r.after.toFixed(4)}</td>
                  <td className="bp-ro">{d(r.delta, 4)}</td>
                  <td className="bp-ro">{r.status}</td>
                </>
              ) : (
                <>
                  <td className="bp-ro">{r.before == null ? '—' : `${r.before.toFixed(1)} %`}</td>
                  <td className="bp-ro">{r.after == null ? '—' : `${r.after.toFixed(1)} %`}</td>
                  <td className="bp-ro">{d(r.delta, 1, ' %')}</td>
                  <td className="bp-ro">{d(r.deltaKw ?? null, 1)}</td>
                  <td className="bp-ro">{d(r.deltaLossKw ?? null, 2)}</td>
                </>
              )}
            </tr>
          ))}
          {list.length === 0 && (
            <tr>
              <td colSpan={7} className="bp-ro">Nothing changed between the two solves.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
