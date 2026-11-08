import { useMemo, useState } from 'react'
import { download } from '../lib/fileActions'
import { chooseOverlay } from '../lib/fileActions'
import {
  DEFAULT_HC_OPTIONS,
  formatKw,
  HC_CRITERIA,
  HC_LABELS,
  hostingCsv,
  hostingGeoJson,
  runHostingCapacity,
} from '../lib/hostingCapacity'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { HostingCapacityOptions } from '../types/circuit'

/**
 * The Hosting tab: what to evaluate (DER or load, which criteria, which
 * method, which hours), the run, and the result bus by bus with the
 * binding criterion, exportable as GeoJSON or CSV.
 */
export function HostingCapacityPanel() {
  const hosting = useResultsStore((s) => s.hosting)
  const running = useResultsStore((s) => s.hcRunning)
  const progress = useResultsStore((s) => s.hcProgress)
  const abort = useResultsStore((s) => s.hcAbort)
  const overlay = useResultsStore((s) => s.overlay)
  const nodes = useCircuitStore((s) => s.nodes)
  const crs = useCircuitStore((s) => s.crs)
  const name = useCircuitStore((s) => s.name)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  const [opts, setOpts] = useState<HostingCapacityOptions>(() => ({ ...DEFAULT_HC_OPTIONS, criteria: { ...DEFAULT_HC_OPTIONS.criteria } }))
  const [hoursText, setHoursText] = useState('')
  const [sortBy, setSortBy] = useState<'kw' | 'bus'>('kw')
  const hasShapes = nodes.some((n) => !!n.data.params.loadshape)
  const hasElements = nodes.some((n) => n.type !== 'note' && n.type !== 'zone')

  const set = <K extends keyof HostingCapacityOptions>(key: K, value: HostingCapacityOptions[K]) => setOpts({ ...opts, [key]: value })
  const toggle = (key: string) => setOpts({ ...opts, criteria: { ...opts.criteria, [key]: !opts.criteria[key] } })
  const run = () => {
    const hours = hoursText
      .split(/[,\s]+/)
      .map((t) => Number(t))
      .filter((h) => Number.isInteger(h) && h >= 0 && h < 24)
    void runHostingCapacity({ ...opts, hours: hours.length && hasShapes ? hours : null })
  }

  const rows = useMemo(() => {
    if (!hosting) return []
    const list = Object.entries(hosting.buses).map(([bus, r]) => ({ bus, ...r }))
    return sortBy === 'kw'
      ? list.sort((a, b) => a.kw - b.kw)
      : list.sort((a, b) => (hosting.busNames[a.bus] ?? a.bus).localeCompare(hosting.busNames[b.bus] ?? b.bus))
  }, [hosting, sortBy])

  const locateBus = (bus: string) => {
    if (!hosting) return
    const id = Object.entries(hosting.nodeBuses).find(([, buses]) => buses[0] === bus)?.[0]
    if (id) selectOnly('node', id)
  }

  return (
    <div className="hosting-panel">
      <div className="hosting-options">
        <div className="scenarios-head">
          <b>Hosting capacity</b>
          <label className="prefs-radio">
            <input type="radio" checked={opts.kind === 'der'} onChange={() => set('kind', 'der')} /> DER (generation)
          </label>
          <label className="prefs-radio">
            <input type="radio" checked={opts.kind === 'load'} onChange={() => set('kind', 'load')} /> Load (EV, electrification)
          </label>
        </div>
        <div className="scenarios-head">
          <span>Method</span>
          <select aria-label="Method" value={opts.method} onChange={(e) => set('method', e.target.value as HostingCapacityOptions['method'])}>
            <option value="iterative">Iterative (bisection at every bus)</option>
            <option value="sensitivity">Sensitivity (one probe per bus, then confirm)</option>
          </select>
          {opts.kind === 'der' && (
            <>
              <span>Unit</span>
              <select aria-label="DER type" value={opts.derType} onChange={(e) => set('derType', e.target.value as HostingCapacityOptions['derType'])}>
                <option value="inverter">inverter (1.2 × rated fault contribution)</option>
                <option value="synchronous">synchronous machine (5 ×)</option>
              </select>
            </>
          )}
          <label className="prefs-radio">
            <input type="checkbox" checked={opts.threePhaseOnly} onChange={(e) => set('threePhaseOnly', e.target.checked)} /> three-phase buses only
          </label>
          <label>
            above
            <input className="hosting-num" type="number" step={0.1} aria-label="Minimum kV" value={opts.minKv} onChange={(e) => set('minKv', Number(e.target.value))} /> kV
          </label>
        </div>
        <div className="hosting-criteria">
          {HC_CRITERIA.filter((c) => (opts.kind === 'der' ? c.der : c.load)).map((c) => (
            <label key={c.key} className="prefs-radio" title={c.help}>
              <input type="checkbox" checked={!!opts.criteria[c.key]} onChange={() => toggle(c.key)} /> {c.label}
              {c.key === 'deviation' && opts.criteria.deviation && (
                <input className="hosting-num" type="number" step={0.5} aria-label="Deviation %" value={opts.deviationPct} onChange={(e) => set('deviationPct', Number(e.target.value))} />
              )}
              {c.key === 'thermal' && opts.criteria.thermal && (
                <input className="hosting-num" type="number" step={5} aria-label="Thermal %" value={opts.thermalPct} onChange={(e) => set('thermalPct', Number(e.target.value))} />
              )}
              {c.key === 'substationReverse' && opts.criteria.substationReverse && (
                <input className="hosting-num" type="number" step={100} aria-label="Allowed export kW" value={opts.substationExportKw} onChange={(e) => set('substationExportKw', Number(e.target.value))} />
              )}
              {c.key === 'faultCurrent' && opts.criteria.faultCurrent && (
                <input className="hosting-num" type="number" step={1} aria-label="Fault increase %" value={opts.faultIncreasePct} onChange={(e) => set('faultIncreasePct', Number(e.target.value))} />
              )}
              {c.key === 'interrupting' && opts.criteria.interrupting && (
                <input className="hosting-num" type="number" step={0.5} aria-label="Interrupting %" value={opts.interruptingPct} onChange={(e) => set('interruptingPct', Number(e.target.value))} />
              )}
              {c.key === 'islanding' && opts.criteria.islanding && (
                <input className="hosting-num" type="number" step={0.05} aria-label="Islanding ratio" value={opts.islandingRatio} onChange={(e) => set('islandingRatio', Number(e.target.value))} />
              )}
            </label>
          ))}
        </div>
        <div className="scenarios-head">
          <label>
            Search up to
            <input className="hosting-num wide" type="number" step={1000} aria-label="Maximum kW" value={opts.maxKw} onChange={(e) => set('maxKw', Number(e.target.value))} /> kW
          </label>
          <label>
            within
            <input className="hosting-num" type="number" step={5} aria-label="Tolerance kW" value={opts.toleranceKw} onChange={(e) => set('toleranceKw', Number(e.target.value))} /> kW
          </label>
          <label title={hasShapes ? 'Evaluate at these hours of the day, using the loadshapes; the capacity reported is the worst hour' : 'Assign loadshapes to evaluate by hour'}>
            Hours
            <input className="hosting-hours" placeholder={hasShapes ? 'e.g. 2, 12, 18 (blank: the load level)' : 'needs loadshapes'} disabled={!hasShapes} value={hoursText} onChange={(e) => setHoursText(e.target.value)} />
          </label>
          {running ? (
            <button type="button" onClick={() => abort?.abort()}>
              ✕ {progress ? `${progress.done} / ${progress.total}${progress.message ? ` · ${progress.message}` : ''}` : 'Starting…'}
            </button>
          ) : (
            <button type="button" className="solve-btn" disabled={!hasElements} onClick={run}>
              ▶ Run
            </button>
          )}
        </div>
      </div>
      {!hosting ? (
        <div className="bp-empty">
          How much DER (or new load) each bus can take before a criterion binds. A trial unit is placed at
          every candidate bus and grown until a limit is reached; the result colours the drawing and the map
          and exports to GeoJSON for a hosting-capacity map. Anything already over a limit in the base case
          is excluded and listed. Method, criteria and limits are described in the docs under
          <i> Hosting capacity</i>.
        </div>
      ) : (
        <>
          <div className="reliability-indices">
            <span className="reliability-index">
              <b>{hosting.kind === 'der' ? 'DER' : 'Load'} hosting capacity</b> {hosting.summary.evaluated} buses ·{' '}
              {formatKw(hosting.summary.minKw)} to {formatKw(hosting.summary.maxKw)} (median {formatKw(hosting.summary.medianKw)})
            </span>
            <span className="reliability-index">
              <b>Binds on</b>{' '}
              {Object.entries(hosting.summary.bindingCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => `${HC_LABELS[k] ?? k} ×${n}`)
                .join(', ') || '—'}
            </span>
            <span className="reliability-index">
              <b>Run</b> {hosting.method}, {hosting.loadLevel.name}
              {hosting.hours.length ? `, hours ${hosting.hours.join(', ')}` : ''} · {hosting.summary.solves} solves in {hosting.summary.seconds} s
            </span>
            {overlay !== 'hosting' && (
              <button type="button" onClick={() => chooseOverlay('hosting')} title="Colour every bus by its capacity">
                Show on the drawing
              </button>
            )}
            <button type="button" onClick={() => download(`${name || 'circuit'}-hosting-capacity.geojson`, hostingGeoJson(hosting, crs), 'application/geo+json')} title="Points with capacity and binding criterion, for a GIS or a public map">
              GeoJSON
            </button>
            <button type="button" onClick={() => download(`${name || 'circuit'}-hosting-capacity.csv`, hostingCsv(hosting), 'text/csv')}>
              CSV
            </button>
            <label className="prefs-radio">
              sort by{' '}
              <select aria-label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as 'kw' | 'bus')}>
                <option value="kw">capacity</option>
                <option value="bus">bus</option>
              </select>
            </label>
          </div>
          {Object.values(hosting.exclusions).some((l) => l.length > 0) && (
            <div className="reliability-warning">
              Already over a limit in the base case and left out of that criterion:{' '}
              {Object.entries(hosting.exclusions)
                .filter(([, l]) => l.length)
                .map(([k, l]) => `${k}: ${l.slice(0, 6).join(', ')}${l.length > 6 ? ` (+${l.length - 6})` : ''}`)
                .join('; ')}
            </div>
          )}
          <table className="bp-table">
            <thead>
              <tr>
                <th />
                <th>Bus</th>
                <th>kV</th>
                <th>Capacity</th>
                <th>Binds on</th>
                {hosting.method === 'sensitivity' &&
                  HC_CRITERIA.filter((c) => hosting.criteria[c.key] && (hosting.kind === 'der' ? c.der : c.load)).map((c) => (
                    <th key={c.key} title={`Estimated capacity if ${c.label.toLowerCase()} alone bound`}>{c.label}</th>
                  ))}
                {hosting.hours.map((h) => (
                  <th key={h}>h {h}</th>
                ))}
                <th>Section load</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.bus}>
                  <td>
                    <button className="bp-locate" title="Select on diagram" onClick={() => locateBus(r.bus)}>⌖</button>
                  </td>
                  <td className="bp-ro">{hosting.busNames[r.bus] ?? r.bus}</td>
                  <td className="bp-ro">{r.kvBase}</td>
                  <td className="bp-ro">
                    {formatKw(r.kw)}
                    {r.capped ? ' +' : ''}
                  </td>
                  <td className="bp-ro">{HC_LABELS[r.binding ?? ''] ?? r.binding ?? '—'}</td>
                  {hosting.method === 'sensitivity' &&
                    HC_CRITERIA.filter((c) => hosting.criteria[c.key] && (hosting.kind === 'der' ? c.der : c.load)).map((c) => (
                      <td key={c.key} className="bp-ro">{formatKw(r.byCriterion[c.key])}</td>
                    ))}
                  {hosting.hours.map((h) => (
                    <td key={h} className="bp-ro">{formatKw(r.kwByHour?.[String(h)])}</td>
                  ))}
                  <td className="bp-ro">{r.sectionLoadKw ? formatKw(r.sectionLoadKw) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="library-note">
            A capacity marked + reached the search cap without binding. Fault-current and interrupting
            criteria use the unit's contribution against a base fault study; voltage change on trip is the
            difference between solves with and without the unit.
          </div>
        </>
      )}
    </div>
  )
}
