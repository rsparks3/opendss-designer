import { useState } from 'react'
import { fmtPct, runStudy } from '../lib/studies'
import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { FaultLineResult, FuseSavingResult, ReachResult, RecloserPlacementResult } from '../types/circuit'

const amps = (a: number | null | undefined) => (a == null ? '—' : a >= 1000 ? `${(a / 1000).toFixed(2)} kA` : `${a.toFixed(0)} A`)
const secs = (s: number | null | undefined) => (s == null ? '—' : `${s.toFixed(3)} s`)

/** Studies → Protection: reach, fuse saving, a fault anywhere on a line,
 *  and where a recloser would do the most good. */
export function ProtectionPanel() {
  const reach = useResultsStore((s) => s.studies.reach as ReachResult | undefined)
  const fuseSaving = useResultsStore((s) => s.studies.fusesaving as FuseSavingResult | undefined)
  const placement = useResultsStore((s) => s.studies.recplacement as RecloserPlacementResult | undefined)
  const running = useResultsStore((s) => s.studyRunning)
  const progress = useResultsStore((s) => s.studyProgress)
  const abort = useResultsStore((s) => s.studyAbort)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  const setFlash = useResultsStore((s) => s.setFlash)
  const [rOhm, setROhm] = useState(20)
  const [line, setLine] = useState('')
  const [fraction, setFraction] = useState(50)
  const [kind, setKind] = useState<'3ph' | 'lg' | 'll' | 'llg'>('3ph')
  const [lineFault, setLineFault] = useState<FaultLineResult | null>(null)
  const [busy, setBusy] = useState(false)
  const lines = edges.filter((e) => e.type === 'line' && !e.data?.params.reactor)
  const chosen = line || lines[0]?.id || ''
  const hasDevices = nodes.some((n) => n.type === 'fuse' || n.type === 'recloser' || n.type === 'relay')
  const locate = (id: string | null | undefined) => {
    if (!id) return
    selectOnly(edges.some((e) => e.id === id) ? 'edge' : 'node', id)
  }
  const run = (key: 'reach' | 'fusesaving' | 'recplacement') => {
    if (key === 'reach') void runStudy('reach', '/api/jobs/reach', { rOhm }, true)
    if (key === 'fusesaving') void runStudy('fusesaving', '/api/fusesaving', { rOhm }, false)
    if (key === 'recplacement') void runStudy('recplacement', '/api/jobs/recloser-placement', { maxCandidates: 40 }, true)
  }
  const faultLine = async () => {
    if (!chosen) return
    setBusy(true)
    try {
      const res = await fetch('/api/faultline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuit: toCircuitJSON(useCircuitStore.getState()), line: chosen, fraction: fraction / 100, kind, rOhm: kind === 'lg' || kind === 'llg' ? rOhm : 0 }),
      })
      const r = (await res.json()) as FaultLineResult
      if (!res.ok || !r.converged) setFlash(r.issues?.find((i) => i.severity === 'error')?.message ?? 'The fault solve did not converge.')
      else setLineFault(r)
    } catch (err) {
      setFlash(`Fault on line: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const nameOf = (id: string) => {
    const n = nodes.find((x) => x.id === id)
    const e = n ? undefined : edges.find((x) => x.id === id)
    const nm = n?.data.params.name ?? e?.data?.params.name
    return typeof nm === 'string' && nm ? nm : id
  }
  const Run = ({ k, label }: { k: 'reach' | 'fusesaving' | 'recplacement'; label: string }) =>
    running[k] ? (
      <button type="button" onClick={() => abort[k]?.abort()}>✕ {progress[k] ? `${progress[k]!.done} / ${progress[k]!.total}` : 'Running…'}</button>
    ) : (
      <button type="button" className="solve-btn" disabled={!hasDevices} onClick={() => run(k)}>▶ {label}</button>
    )
  return (
    <div className="study">
      <div className="scenarios-head">
        <b>Protection</b>
        <label>
          minimum faults through
          <input className="hosting-num" type="number" step={5} aria-label="Fault resistance" value={rOhm} onChange={(e) => setROhm(Number(e.target.value))} /> Ω
        </label>
        {!hasDevices && <span className="scenarios-count">no fuse, recloser or relay on the drawing</span>}
      </div>
      <div className="scenarios-head">
        <b>Reach</b>
        <Run k="reach" label="Check every device's reach" />
      </div>
      {reach && (
        <table className="bp-table">
          <thead>
            <tr><th /><th>Device</th><th>Pickup</th><th>Zone buses</th><th>Min fault at end of zone</th><th>Kind</th><th>DER infeed</th><th>Seen by device</th><th>Reach ratio</th><th>Ground ratio</th><th /></tr>
          </thead>
          <tbody>
            {reach.devices.map((d) => (
              <tr key={d.id} className={d.ok ? '' : 'violation'}>
                <td><button className="bp-locate" title="Select on diagram" onClick={() => locate(d.id)}>⌖</button></td>
                <td className="bp-ro">{d.name} <span className="scenarios-count">{d.kind}</span></td>
                <td className="bp-ro">{amps(d.phasePickupA)}{d.groundPickupA ? ` / ${amps(d.groundPickupA)} gnd` : ''}</td>
                <td className="bp-ro">{d.sectionBuses}</td>
                <td className="bp-ro">{amps(d.minFaultA)} at {d.endBus ?? '—'}</td>
                <td className="bp-ro">{d.minFaultKind === 'lg' ? `L-G through ${reach.rOhm} Ω` : d.minFaultKind === 'll' ? 'L-L bolted' : '—'}</td>
                <td className="bp-ro">{amps(d.derInfeedA)}</td>
                <td className="bp-ro">{amps(d.seenByDeviceA)}</td>
                <td className="bp-ro">{d.reachRatio == null ? '—' : `${d.reachRatio.toFixed(2)} ×`}</td>
                <td className="bp-ro">{d.groundReachRatio == null ? '—' : `${d.groundReachRatio.toFixed(2)} ×`}</td>
                <td className="bp-ro">{d.ok ? 'ok' : `below ${reach.margin} × pickup`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="scenarios-head" style={{ marginTop: 10 }}>
        <b>Fuse saving</b>
        <Run k="fusesaving" label="Grade every recloser–fuse pair" />
      </div>
      {fuseSaving && (
        <table className="bp-table">
          <thead>
            <tr><th>Recloser</th><th>Fuse</th><th>Max fault at fuse</th><th>Fast</th><th>Fuse melts</th><th>Fuse saving</th><th>Min fault in zone</th><th>Fuse clears</th><th>Delayed</th><th>Fuse blowing</th><th>Note</th></tr>
          </thead>
          <tbody>
            {fuseSaving.pairs.length === 0 && <tr><td colSpan={11} className="bp-ro">No fuse has a recloser above it.</td></tr>}
            {fuseSaving.pairs.map((p, i) => (
              <tr key={i} className={p.fuseSaving && p.fuseBlowing ? '' : 'warning'}>
                <td className="bp-ro">{p.recloser}</td>
                <td className="bp-ro">{p.fuse}</td>
                <td className="bp-ro">{amps(p.maxFaultA)}</td>
                <td className="bp-ro">{secs(p.recloserFastS)}</td>
                <td className="bp-ro">{secs(p.fuseMeltS)}</td>
                <td className="bp-ro">{p.fuseSaving ? 'yes' : 'no'}</td>
                <td className="bp-ro">{amps(p.minFaultA)}</td>
                <td className="bp-ro">{secs(p.fuseClearS)} <span className="scenarios-count">({p.clearFrom})</span></td>
                <td className="bp-ro">{secs(p.recloserDelayedS)}</td>
                <td className="bp-ro">{p.fuseBlowing ? 'yes' : 'no'}</td>
                <td className="bp-ro">{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="scenarios-head" style={{ marginTop: 10 }}>
        <b>Fault on a line</b>
        <select aria-label="Line" value={chosen} onChange={(e) => setLine(e.target.value)}>
          {lines.map((e) => <option key={e.id} value={e.id}>{String(e.data?.params.name ?? e.id)}</option>)}
        </select>
        <label>
          at
          <input type="range" min={1} max={99} aria-label="Fraction" value={fraction} onChange={(e) => setFraction(Number(e.target.value))} /> {fraction} %
        </label>
        <select aria-label="Fault kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="3ph">three-phase</option>
          <option value="lg">line-to-ground</option>
          <option value="ll">line-to-line</option>
          <option value="llg">double-line-to-ground</option>
        </select>
        <button type="button" className="solve-btn" disabled={!chosen || busy} onClick={() => void faultLine()}>{busy ? 'Solving…' : '▶ Solve the fault'}</button>
      </div>
      {lineFault && (
        <div className="reliability-indices">
          <span className="reliability-index"><b>Fault current</b> {amps(lineFault.faultA)} ({lineFault.faultPhaseA.map((a) => amps(a)).join(' / ')})</span>
          {Object.entries(lineFault.devices)
            .filter(([f]) => nodes.some((n) => n.id === lineFault.devices[f].id && ['fuse', 'recloser', 'relay', 'breaker'].includes(n.type ?? '')))
            .sort((a, b) => b[1].amps - a[1].amps)
            .map(([f, d]) => (
              <span key={f} className="reliability-index"><b>{nameOf(d.id)}</b> {amps(d.amps)}</span>
            ))}
        </div>
      )}
      <div className="scenarios-head" style={{ marginTop: 10 }}>
        <b>Where a recloser helps most</b>
        <Run k="recplacement" label="Try a recloser on each line" />
      </div>
      {placement && (
        <>
          <div className="reliability-indices">
            <span className="reliability-index"><b>Today</b> SAIFI {placement.base.saifi?.toFixed(3)} · SAIDI {placement.base.saidi?.toFixed(3)} h</span>
          </div>
          <table className="bp-table">
            <thead><tr><th /><th>Line</th><th>Length</th><th>SAIFI</th><th>SAIDI</th><th>Δ SAIDI</th><th>Customer-hours saved</th></tr></thead>
            <tbody>
              {placement.candidates.slice(0, 25).map((c) => (
                <tr key={c.line} className={c.saidiChange < 0 ? '' : 'warning'}>
                  <td><button className="bp-locate" title="Select on diagram" onClick={() => locate(c.line)}>⌖</button></td>
                  <td className="bp-ro">{c.name}</td>
                  <td className="bp-ro">{c.lengthKm} km</td>
                  <td className="bp-ro">{c.saifi?.toFixed(3) ?? '—'}</td>
                  <td className="bp-ro">{c.saidi?.toFixed(3) ?? '—'} h</td>
                  <td className="bp-ro">{c.saidiChange > 0 ? '+' : ''}{c.saidiChange.toFixed(3)} h</td>
                  <td className="bp-ro">{c.custHoursSaved.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="library-note">A recloser mid-way on each line in turn, with the default settings, and the reliability study rerun; {fmtPct(0).length ? '' : ''}the fall in SAIDI is what it would buy.</div>
        </>
      )}
    </div>
  )
}
