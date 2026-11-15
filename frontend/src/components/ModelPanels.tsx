import { useState } from 'react'
import { download } from '../lib/fileActions'
import { fmtKw, fmtPu, runStudy } from '../lib/studies'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { QaResult, TlmResult } from '../types/circuit'
import { LockedNote } from './LockedNote'

function useLocate() {
  const edges = useCircuitStore((s) => s.edges)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  return (nodeId?: string | null, edgeId?: string | null) => {
    if (nodeId) selectOnly('node', nodeId)
    else if (edgeId) selectOnly(edges.some((e) => e.id === edgeId) ? 'edge' : 'node', edgeId)
  }
}

/** Model QA: the one-click check a utility runs on a converted model. */
export function QaPanel() {
  const qa = useResultsStore((s) => s.studies.qa as QaResult | undefined)
  const running = useResultsStore((s) => s.studyRunning.qa)
  const nodes = useCircuitStore((s) => s.nodes)
  const name = useCircuitStore((s) => s.name)
  const locate = useLocate()
  const [onlyWarnings, setOnlyWarnings] = useState(false)
  const hasElements = nodes.some((n) => n.type !== 'note' && n.type !== 'zone')
  const list = qa ? qa.findings.filter((f) => !onlyWarnings || f.severity === 'warning') : []
  const csv = () => {
    if (!qa) return
    const rows = [['severity', 'code', 'message'], ...qa.findings.map((f) => [f.severity, f.code, f.message])]
    download(`${name || 'circuit'}-model-qa.csv`, rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n', 'text/csv')
  }
  return (
    <div className="study">
      <div className="scenarios-head">
        <b>Model QA</b>
        <button type="button" className="solve-btn" disabled={!hasElements || !!running} onClick={() => void runStudy('qa', '/api/qa', {}, false)}>
          {running ? 'Checking…' : '▶ Check the model'}
        </button>
        {qa && <button type="button" onClick={csv}>CSV</button>}
        {qa && (
          <label className="prefs-radio">
            <input type="checkbox" checked={onlyWarnings} onChange={(e) => setOnlyWarnings(e.target.checked)} /> warnings only
          </label>
        )}
      </div>
      {!qa ? (
        <div className="bp-empty">
          Beyond the live validation: ratings and impedances left at the editor's placeholders, lengths that cannot be
          right, loads without customers or a class, voltage bases no winding matches, loops in a radial feeder, open
          points not marked as ties, elements out of service or with no place on the map — with a completeness score
          per element class. The first thing to run on a converted model.
        </div>
      ) : (
        <>
          <div className="reliability-indices">
            <span className="reliability-index"><b>Completeness</b> {qa.score} %</span>
            <span className="reliability-index"><b>{qa.warnings}</b> warning{qa.warnings === 1 ? '' : 's'} · {qa.infos} note{qa.infos === 1 ? '' : 's'} · {qa.elements} elements{qa.loops ? ` · ${qa.loops} loop${qa.loops === 1 ? '' : 's'}` : ''}</span>
            <span className="reliability-index"><b>Voltage bases</b> {qa.voltageBases.length ? qa.voltageBases.join(', ') + ' kV' : 'from the elements'}</span>
          </div>
          <table className="bp-table">
            <thead>
              <tr><th>Class</th><th>Count</th><th>Complete</th><th>Missing</th></tr>
            </thead>
            <tbody>
              {qa.completeness.map((c) => (
                <tr key={c.class} className={c.pct < 70 ? 'warning' : ''}>
                  <td className="bp-ro">{c.class}</td>
                  <td className="bp-ro">{c.count}</td>
                  <td className="bp-ro">{c.pct} %</td>
                  <td className="bp-ro">{Object.entries(c.missing).map(([f, n]) => `${f} (${n})`).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > 0 && (
            <ul className="problems-list">
              {list.map((f, i) => (
                <li key={i} className={f.severity} onClick={() => locate(f.nodeId, f.edgeId)} style={{ cursor: f.nodeId || f.edgeId ? 'pointer' : 'default' }}>
                  {f.message} <span className="scenarios-count">{f.code}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** Service transformers: loading, loss of life, and the customer's voltage. */
export function TlmPanel() {
  const tlm = useResultsStore((s) => s.studies.tlm as TlmResult | undefined)
  const running = useResultsStore((s) => s.studyRunning.tlm)
  const progress = useResultsStore((s) => s.studyProgress.tlm)
  const abort = useResultsStore((s) => s.studyAbort.tlm)
  const nodes = useCircuitStore((s) => s.nodes)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  const [mode, setMode] = useState<'daily' | 'yearly'>('daily')
  const [ambient, setAmbient] = useState(30)
  const hasElements = nodes.some((n) => n.type !== 'note' && n.type !== 'zone')
  return (
    <div className="study">
      <LockedNote feature="studies" />
      <div className="scenarios-head">
        <b>Service transformers</b>
        <select aria-label="Horizon" value={mode} onChange={(e) => setMode(e.target.value as 'daily' | 'yearly')}>
          <option value="daily">a day</option>
          <option value="yearly">a year</option>
        </select>
        <label>
          ambient
          <input className="hosting-num" type="number" step={1} aria-label="Ambient C" value={ambient} onChange={(e) => setAmbient(Number(e.target.value))} /> °C
        </label>
        {running ? (
          <button type="button" onClick={() => abort?.abort()}>✕ {progress ? `${progress.done} / ${progress.total}` : 'Running…'}</button>
        ) : (
          <button type="button" className="solve-btn" disabled={!hasElements} onClick={() => void runStudy('tlm', '/api/jobs/transformer-loading', { mode, ambientC: ambient }, true)}>
            ▶ Run
          </button>
        )}
      </div>
      {!tlm ? (
        <div className="bp-empty">
          Every service transformer (a split-phase unit, or any with a secondary under 1 kV) over a day or a year of the
          loadshapes: peak loading, hours over 100 % and 150 % of rating, hottest-spot temperature and the loss of
          insulation life by IEEE C57.91; and the lowest voltage at every load under 1 kV against 114 V at the meter.
          Where the electrification question is asked.
        </div>
      ) : (
        <>
          <div className="reliability-indices">
            <span className="reliability-index"><b>{tlm.summary.transformers}</b> service transformers · {tlm.summary.overloaded} overloaded · {tlm.summary.aging} aging faster than rated</span>
            <span className="reliability-index"><b>{tlm.summary.services}</b> secondary loads · {tlm.summary.lowVoltage} below 114 V · {tlm.summary.highVoltage} above 126 V</span>
            <span className="reliability-index">{tlm.mode === 'daily' ? 'A day' : 'A year'} at {tlm.stepMin} min, {tlm.ambientC} °C ambient · {tlm.loadLevel.name}</span>
          </div>
          <table className="bp-table">
            <thead>
              <tr><th /><th>Transformer</th><th>kVA</th><th>Peak</th><th>at hour</th><th>Hours &gt; 100 %</th><th>Hours &gt; 150 %</th><th>Hottest spot</th><th>Aging factor</th><th>Loss of life /yr</th></tr>
            </thead>
            <tbody>
              {tlm.transformers.map((t) => (
                <tr key={t.id} className={t.flag === 'overloaded' ? 'violation' : t.flag === 'aging' ? 'warning' : ''}>
                  <td><button className="bp-locate" title="Select on diagram" onClick={() => selectOnly('node', t.id)}>⌖</button></td>
                  <td className="bp-ro">{t.name}</td>
                  <td className="bp-ro">{t.kva}</td>
                  <td className="bp-ro">{t.peakPct.toFixed(0)} %</td>
                  <td className="bp-ro">{t.peakHour}</td>
                  <td className="bp-ro">{t.hoursOver100}</td>
                  <td className="bp-ro">{t.hoursOver150}</td>
                  <td className="bp-ro">{t.maxHotSpotC} °C</td>
                  <td className="bp-ro">{t.equivalentAging ?? '—'}</td>
                  <td className="bp-ro">{t.lossOfLifePctPerYear} %</td>
                </tr>
              ))}
            </tbody>
          </table>
          {tlm.services.length > 0 && (
            <table className="bp-table">
              <thead>
                <tr><th /><th>Load</th><th>kV</th><th>Lowest</th><th>at hour</th><th>Highest</th><th>Flag</th></tr>
              </thead>
              <tbody>
                {tlm.services.map((s) => (
                  <tr key={s.id} className={s.flag ? 'violation' : ''}>
                    <td><button className="bp-locate" title="Select on diagram" onClick={() => selectOnly('node', s.id)}>⌖</button></td>
                    <td className="bp-ro">{s.name}</td>
                    <td className="bp-ro">{s.kv}</td>
                    <td className="bp-ro">{s.minV120} V ({fmtPu(s.minVpu)} pu)</td>
                    <td className="bp-ro">{s.minHour}</td>
                    <td className="bp-ro">{s.maxV120} V</td>
                    <td className="bp-ro">{s.flag === 'low' ? 'below 114 V' : s.flag === 'high' ? 'above 126 V' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="library-note">
            Loss of life by IEEE C57.91 Clause 7 (65 °C-rise unit, loss ratio 5, exponents 0.8), scaled to a year from the run; {fmtKw(0).length ? '' : ''}an aging factor of 1 is rated life.
          </div>
        </>
      )}
    </div>
  )
}
