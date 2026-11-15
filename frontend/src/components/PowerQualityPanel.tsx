import { useMemo, useState } from 'react'
import { fmtPct, runStudy } from '../lib/studies'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { HarmonicsResult, RvcResult } from '../types/circuit'
import { LockedNote } from './LockedNote'

/** Studies → Power quality: harmonic distortion at every bus and the
 *  voltage step of a motor start or a DER trip. */
export function PowerQualityPanel() {
  const harm = useResultsStore((s) => s.studies.harmonics as HarmonicsResult | undefined)
  const rvc = useResultsStore((s) => s.studies.rvc as RvcResult | undefined)
  const running = useResultsStore((s) => s.studyRunning)
  const progress = useResultsStore((s) => s.studyProgress)
  const abort = useResultsStore((s) => s.studyAbort)
  const result = useResultsStore((s) => s.result)
  const nodes = useCircuitStore((s) => s.nodes)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  const [orders, setOrders] = useState('3, 5, 7, 9, 11, 13')
  const [kind, setKind] = useState<'motorStart' | 'derTrip'>('motorStart')
  const [bus, setBus] = useState('')
  const [kva, setKva] = useState(500)
  const [pf, setPf] = useState(0.3)
  const [lrc, setLrc] = useState(6)
  const [limit, setLimit] = useState(3)
  const [der, setDer] = useState('')
  const hasElements = nodes.some((n) => n.type !== 'note' && n.type !== 'zone')
  const buses = useMemo(() => {
    const seen = new Map<string, string>()
    for (const n of nodes) {
      const b = result?.nodeBuses[n.id]?.[0]
      if (b && !seen.has(b)) seen.set(b, n.type === 'busbar' ? String(n.data.params.name ?? b) : `${result?.busNames[b] ?? b} (${String(n.data.params.name ?? n.type)})`)
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]))
  }, [nodes, result])
  const ders = nodes.filter((n) => n.type === 'generator' || n.type === 'pvsystem' || n.type === 'storage')
  const chosenBus = bus || buses[0]?.[0] || ''
  const chosenDer = der || ders[0]?.id || ''
  const locateBus = (b: string) => {
    const id = Object.entries(harm?.nodeBuses ?? result?.nodeBuses ?? {}).find(([, bs]) => bs[0] === b)?.[0]
    if (id) selectOnly('node', id)
  }
  const runHarm = () => {
    const hs = orders.split(/[,\s]+/).map(Number).filter((h) => Number.isInteger(h) && h >= 2 && h <= 50)
    void runStudy('harmonics', '/api/jobs/harmonics', { orders: hs.length ? hs : undefined }, true)
  }
  const runRvc = () =>
    void runStudy('rvc', '/api/rvc', { bus: chosenBus, kind, kva, pf, lrcMultiple: lrc, limitPct: limit, derId: kind === 'derTrip' ? chosenDer : null }, false)
  const rows = useMemo(() => (harm ? Object.entries(harm.buses).sort((a, b) => b[1].thdPct - a[1].thdPct) : []), [harm])
  return (
    <div className="study">
      <LockedNote feature="studies" />
      <div className="scenarios-head">
        <b>Harmonics</b>
        <label>
          orders
          <input aria-label="Harmonic orders" value={orders} onChange={(e) => setOrders(e.target.value)} style={{ width: 160, marginLeft: 4 }} />
        </label>
        {running.harmonics ? (
          <button type="button" onClick={() => abort.harmonics?.abort()}>✕ {progress.harmonics ? `${progress.harmonics.done} / ${progress.harmonics.total}` : 'Running…'}</button>
        ) : (
          <button type="button" className="solve-btn" disabled={!hasElements} onClick={runHarm}>▶ Run the harmonic study</button>
        )}
      </div>
      {!harm ? (
        <div className="bp-empty">
          The circuit solved at each harmonic order in turn, every load, generator and PV system injecting by its
          spectrum (the engine's defaults unless a project spectrum is named), and the voltage THD at every bus with the
          worst single harmonic against IEEE 519 (5 % THD, 3 % individual below 69 kV).
        </div>
      ) : (
        <>
          <div className="reliability-indices">
            <span className="reliability-index"><b>{harm.summary.buses}</b> buses · {harm.summary.overLimit} over the limits</span>
            <span className="reliability-index"><b>Worst THD</b> {fmtPct(harm.summary.worstThdPct, 2)} at {harm.summary.worstBus ? harm.busNames[harm.summary.worstBus] ?? harm.summary.worstBus : '—'}</span>
            <span className="reliability-index">orders {harm.orders.join(', ')} · limits {harm.limits.thdPct} % THD, {harm.limits.individualPct} % individual</span>
          </div>
          <table className="bp-table">
            <thead>
              <tr><th /><th>Bus</th><th>THD</th><th>Worst harmonic</th>{harm.orders.map((h) => <th key={h}>h{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map(([b, r]) => (
                <tr key={b} className={r.over ? 'violation' : ''}>
                  <td><button className="bp-locate" title="Select on diagram" onClick={() => locateBus(b)}>⌖</button></td>
                  <td className="bp-ro">{harm.busNames[b] ?? b}</td>
                  <td className="bp-ro">{fmtPct(r.thdPct, 2)}</td>
                  <td className="bp-ro">{r.worstHarmonic ? `h${r.worstHarmonic} at ${fmtPct(r.worstPct, 2)}` : '—'}</td>
                  {harm.orders.map((h) => <td key={h} className="bp-ro">{fmtPct(r.spectrum[String(h)], 2)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="scenarios-head" style={{ marginTop: 10 }}>
        <b>Rapid voltage change</b>
        <select aria-label="Event" value={kind} onChange={(e) => setKind(e.target.value as 'motorStart' | 'derTrip')}>
          <option value="motorStart">motor start</option>
          <option value="derTrip">DER trip</option>
        </select>
        {kind === 'motorStart' ? (
          <>
            <select aria-label="Bus" value={chosenBus} onChange={(e) => setBus(e.target.value)}>
              {buses.map(([b, label]) => <option key={b} value={b}>{label}</option>)}
              {!buses.length && <option value="">solve first to list buses</option>}
            </select>
            <label>
              motor
              <input className="hosting-num" type="number" step={50} aria-label="Motor kVA" value={kva} onChange={(e) => setKva(Number(e.target.value))} /> kVA
            </label>
            <label>
              ×
              <input className="hosting-num" type="number" step={0.5} aria-label="Locked-rotor multiple" value={lrc} onChange={(e) => setLrc(Number(e.target.value))} /> locked rotor at pf
            </label>
            <input className="hosting-num" type="number" step={0.05} aria-label="Starting power factor" value={pf} onChange={(e) => setPf(Number(e.target.value))} />
          </>
        ) : (
          <select aria-label="DER" value={chosenDer} onChange={(e) => setDer(e.target.value)}>
            {ders.map((n) => <option key={n.id} value={n.id}>{String(n.data.params.name ?? n.id)}</option>)}
            {!ders.length && <option value="">no generator, PV or storage</option>}
          </select>
        )}
        <label>
          limit
          <input className="hosting-num" type="number" step={0.5} aria-label="RVC limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))} /> %
        </label>
        <button type="button" className="solve-btn" disabled={!!running.rvc || (kind === 'motorStart' ? !chosenBus : !chosenDer)} onClick={runRvc}>
          {running.rvc ? 'Solving…' : '▶ Solve the step'}
        </button>
      </div>
      {rvc && (
        <div className="reliability-indices">
          <span className={`reliability-index${rvc.pass === false ? ' err-count' : ''}`}><b>{rvc.pass ? 'Within' : 'Over'} {rvc.limitPct} %</b> · {rvc.label}</span>
          <span className="reliability-index"><b>At the bus</b> {rvc.stepAtBusPct == null ? '—' : `${rvc.stepAtBusPct > 0 ? '+' : ''}${rvc.stepAtBusPct.toFixed(2)} %`}</span>
          <span className="reliability-index"><b>Worst</b> {rvc.worstStepPct == null ? '—' : `${rvc.worstStepPct > 0 ? '+' : ''}${rvc.worstStepPct.toFixed(2)} %`} at {rvc.worstBus ? rvc.busNames[rvc.worstBus] ?? rvc.worstBus : '—'} · {rvc.busesOver} buses over</span>
        </div>
      )}
    </div>
  )
}
