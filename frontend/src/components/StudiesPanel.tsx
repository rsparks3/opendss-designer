import { useState } from 'react'
import { fmtKw, fmtPct, fmtPu, LABELS, runStudy } from '../lib/studies'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore, type StudyKey } from '../store/resultsStore'
import { estimateN1Solves, n1CaseName, n1CaseOverrides } from '../lib/contingency'
import type {
  BalanceResult,
  ByPriority,
  CapacityResult,
  CvrResult,
  LossResult,
  N1Case,
  N1Generator,
  N1Options,
  N1Result,
  N1Summary,
  PlacementResult,
  SweepResult,
  TransferResult,
} from '../types/circuit'
import { HostingCapacityPanel } from './HostingCapacityPanel'
import { QaPanel, TlmPanel } from './ModelPanels'
import { ProtectionPanel } from './ProtectionPanel'
import { PowerQualityPanel } from './PowerQualityPanel'
import { LockedNote } from './LockedNote'

type Study = 'qa' | 'hosting' | 'contingency' | 'voltvar' | 'balance' | 'capacity' | 'tlm' | 'protection' | 'pq'

const STUDIES: { key: Study; label: string; help: string }[] = [
  { key: 'qa', label: 'Model QA', help: 'Completeness and the things to fix before a study' },
  { key: 'hosting', label: 'Hosting capacity', help: 'DER or load each bus can take before a criterion binds' },
  { key: 'contingency', label: 'Contingency', help: 'N-1: what a lost device leaves dark, which tie restores it, what a tie can carry' },
  { key: 'voltvar', label: 'Volt/VAR & CVR', help: 'Setting sweeps over a day, CVR savings, capacitor placement' },
  { key: 'balance', label: 'Phase balance', help: 'Unbalance at the head and which laterals to move' },
  { key: 'capacity', label: 'Losses & capacity', help: 'Losses by class over a day or a year, and the load the feeder can take' },
  { key: 'tlm', label: 'Service transformers', help: 'Loading and loss of life of every service transformer, and the voltage at the meter' },
  { key: 'protection', label: 'Protection', help: 'Reach, fuse saving, a fault anywhere on a line, where a recloser helps most' },
  { key: 'pq', label: 'Power quality', help: 'Harmonic distortion at every bus; the voltage step of a motor start or a DER trip' },
]

/** The Studies tab: one study at a time, picked on the left. */
export function StudiesPanel() {
  const [study, setStudy] = useState<Study>('hosting')
  return (
    <div className="studies-panel">
      <div className="studies-side">
        <LockedNote feature="studies" />
        {STUDIES.map((s) => (
          <button key={s.key} className={`curves-item${study === s.key ? ' active' : ''}`} title={s.help} onClick={() => setStudy(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="studies-main">
        {study === 'qa' && <QaPanel />}
        {study === 'hosting' && <HostingCapacityPanel />}
        {study === 'tlm' && <TlmPanel />}
        {study === 'protection' && <ProtectionPanel />}
        {study === 'pq' && <PowerQualityPanel />}
        {study === 'contingency' && <ContingencyPanel />}
        {study === 'voltvar' && <VoltVarPanel />}
        {study === 'balance' && <BalancePanel />}
        {study === 'capacity' && <CapacityPanel />}
      </div>
    </div>
  )
}

function RunButton({ k, label, onRun, disabled }: { k: StudyKey; label?: string; onRun: () => void; disabled?: boolean }) {
  const running = useResultsStore((s) => s.studyRunning[k])
  const progress = useResultsStore((s) => s.studyProgress[k])
  const abort = useResultsStore((s) => s.studyAbort[k])
  if (running) {
    return (
      <button type="button" onClick={() => abort?.abort()}>
        ✕ {progress ? `${progress.done} / ${progress.total}${progress.message ? ` · ${progress.message}` : ''}` : 'Running…'}
      </button>
    )
  }
  return (
    <button type="button" className="solve-btn" disabled={disabled} onClick={onRun}>
      ▶ {label ?? `Run ${LABELS[k].toLowerCase()}`}
    </button>
  )
}

function useLocate() {
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  return {
    locate: (id: string | null | undefined) => {
      if (!id) return
      selectOnly(edges.some((e) => e.id === id) ? 'edge' : 'node', id)
    },
    nameOf: (id: string | null | undefined, fallback = '—') => {
      if (!id) return fallback
      const n = nodes.find((x) => x.id === id)
      const e = n ? undefined : edges.find((x) => x.id === id)
      const name = n?.data.params.name ?? e?.data?.params.name
      return typeof name === 'string' && name ? name : fallback
    },
  }
}

// --- contingency ------------------------------------------------------------------------

const PRIORITY_SHORT: Record<keyof ByPriority, string> = { critical: 'crit', essential: 'ess', nonessential: 'non', unassigned: 'n/a' }

/** "crit 900 · ess 250" — the priorities with load in them, critical first. */
function byPriority(p: ByPriority | null | undefined): string {
  if (!p) return '—'
  const parts = (Object.keys(PRIORITY_SHORT) as (keyof ByPriority)[])
    .filter((k) => (p[k] ?? 0) > 0.5)
    .map((k) => `${PRIORITY_SHORT[k]} ${Math.round(p[k])}`)
  return parts.length ? parts.join(' · ') : '0'
}

function worstGen(s: N1Summary | undefined | null): string {
  const g = (s?.generators ?? []).reduce<N1Generator | null>((w, x) => (!w || (x.loadingPct ?? 0) > (w.loadingPct ?? 0) ? x : w), null)
  return g ? `${g.name} ${fmtPct(g.loadingPct, 0)}` : '—'
}

function ContingencyPanel() {
  const n1 = useResultsStore((s) => s.studies.n1 as N1Result | undefined)
  const transfer = useResultsStore((s) => s.studies.transfer as TransferResult | undefined)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const previewScenario = useCircuitStore((s) => s.previewScenario)
  const keepPreview = useCircuitStore((s) => s.keepPreview)
  const { locate, nameOf } = useLocate()
  const [candidates, setCandidates] = useState<N1Options['candidates']>('switches')
  const [standby, setStandby] = useState(false)
  const [excludeText, setExcludeText] = useState('')
  const excludeTags = excludeText.split(/[,;]+/).map((t) => t.trim()).filter(Boolean)
  const options: N1Options = { candidates, standby, excludeTags }
  const solves = estimateN1Solves(nodes, edges, options)
  const hasStandby = nodes.some((n) => n.type === 'generator' && n.data.params.standby === true)
  const ties = nodes.filter((n) => n.type === 'breaker' && (n.data.params.tie === true || n.data.params.closed === false))
  const [tie, setTie] = useState<string>('')
  const chosenTie = tie || ties[0]?.id || ''
  const hasElements = nodes.some((n) => n.type !== 'note' && n.type !== 'zone')
  const kindOf = (id: string) => nodes.find((n) => n.id === id)?.type ?? (edges.some((e) => e.id === id) ? 'line' : undefined)
  const show = (c: N1Case) => {
    if (!n1) return
    previewScenario(n1CaseName(c), 'An N-1 row shown on the drawing.', n1CaseOverrides(c, n1, kindOf))
  }
  const keep = (c: N1Case) => {
    show(c)
    keepPreview(n1CaseName(c))
  }
  return (
    <div className="study">
      <div className="scenarios-head">
        <b>N-1 contingency</b>
        <select aria-label="Elements to take out" value={candidates} onChange={(e) => setCandidates(e.target.value as N1Options['candidates'])}>
          <option value="switches">switches and protective devices</option>
          <option value="all">… and every line and transformer</option>
          <option value="transformers">transformers only</option>
        </select>
        <label className="prefs-radio" title={hasStandby ? 'A generator marked Standby starts, isochronous, in an island the outage leaves without a source' : 'No generator is marked Standby (Properties → Standby)'}>
          <input type="checkbox" checked={standby} onChange={(e) => setStandby(e.target.checked)} /> start standby generators
        </label>
        <input className="hosting-num wide" aria-label="Exclude elements tagged" placeholder="exclude tags…" value={excludeText} onChange={(e) => setExcludeText(e.target.value)} />
        <span className="scenarios-count" title="The base solve, then each outage alone and with each tie">≈ {solves} solves</span>
        <RunButton k="n1" disabled={!hasElements} onRun={() => void runStudy('n1', '/api/jobs/n-minus-1', { options }, true)} />
      </div>
      {!n1 ? (
        <div className="bp-empty">
          Each closed switch or protective device is taken out in turn: the load left dark by priority, the normally-open
          tie (a breaker marked <i>Tie switch</i>, or any open breaker) that restores the most of it, and the worst voltage
          and loading while it does. With standby generators on, an island the outage cuts off is carried by its standby
          units, judged against their rating. Ranked by critical load that cannot be restored, then by all of it.
        </div>
      ) : (
        <>
          <div className="reliability-indices">
            <span className="reliability-index"><b>{n1.summary.evaluated}</b> elements · {n1.summary.withLostLoad} drop load · {n1.summary.withCriticalLoss ?? 0} leave critical load dark · {n1.summary.restorable} restorable by a tie</span>
            <span className="reliability-index"><b>Ties</b> {n1.ties.map((t) => t.name).join(', ') || 'none'}</span>
            {n1.options?.standby && <span className="reliability-index"><b>Standby</b> {n1.standbyUnits?.map((u) => u.name).join(', ') || 'none marked'}</span>}
            <span className="reliability-index"><b>Base</b> {fmtKw(n1.base.totalLoadKw)} load · min V {fmtPu(n1.base.minVpu)} · max loading {fmtPct(n1.base.maxLoadingPct, 0)} · losses {fmtKw(n1.base.lossesKw)} · {n1.loadLevel.name}</span>
          </div>
          <table className="bp-table">
            <thead>
              <tr>
                <th />
                <th>Lost element</th>
                <th>Load dark</th>
                <th title="Separate parts with load cut off from every source">Islands</th>
                <th>Best tie</th>
                <th>Still dark</th>
                <th>Still dark by priority (kW)</th>
                <th>Min V</th>
                <th>Max loading</th>
                {n1.options?.standby && <th>Standby loading</th>}
                <th>Losses</th>
                <th>New violations</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {n1.cases.map((c) => {
                const shown = c.bestTie ?? c.noAction
                return (
                  <tr key={c.id} className={(c.remainingByPriority?.critical ?? 0) > 0.5 ? 'error' : (c.remainingUnservedKw ?? 0) > 0.5 || (shown?.genOverloads ?? 0) > 0 ? 'warning' : ''}>
                    <td><button className="bp-locate" title="Select on diagram" onClick={() => locate(c.id)}>⌖</button></td>
                    <td className="bp-ro">{c.element} <span className="scenarios-count">{c.kind}</span></td>
                    <td className="bp-ro">{c.converged ? fmtKw(c.unservedKw) : 'did not converge'}</td>
                    <td className="bp-ro">{c.islandsFormed ?? '—'}</td>
                    <td className="bp-ro">{c.bestTie ? `${c.bestTie.tieName} (+${fmtKw(c.bestTie.restoredKw)})` : (c.unservedKw ?? 0) > 0.5 ? 'none restores it' : '—'}</td>
                    <td className="bp-ro">{fmtKw(c.remainingUnservedKw)}</td>
                    <td className="bp-ro">{byPriority(c.remainingByPriority)}</td>
                    <td className="bp-ro">{fmtPu(shown?.minVpu)}</td>
                    <td className="bp-ro">{fmtPct(shown?.maxLoadingPct, 0)}</td>
                    {n1.options?.standby && <td className="bp-ro">{worstGen(shown)}</td>}
                    <td className="bp-ro">{fmtKw(shown?.lossesKw)}</td>
                    <td className="bp-ro">{c.bestTie ? c.bestTie.newViolations : c.noAction ? Math.max(0, c.noAction.violations - n1.base.violations) : '—'}</td>
                    <td className="bp-ro">
                      <button type="button" className="scenarios-mini" disabled={!c.converged} title="Show this outage on the drawing, unsaved (solve to see the overlays)" onClick={() => show(c)}>Show</button>
                      <button type="button" className="scenarios-mini" disabled={!c.converged} title="Keep this outage (and its tie and standby units) as a scenario" onClick={() => keep(c)}>Save as scenario</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
      <div className="scenarios-head" style={{ marginTop: 10 }}>
        <b>Transfer capability</b>
        <select aria-label="Tie switch" value={chosenTie} onChange={(e) => setTie(e.target.value)} disabled={!ties.length}>
          {ties.map((t) => (
            <option key={t.id} value={t.id}>{String(t.data.params.name ?? t.id)}</option>
          ))}
          {!ties.length && <option value="">no normally-open breaker</option>}
        </select>
        <RunButton k="transfer" disabled={!chosenTie} onRun={() => void runStudy('transfer', '/api/transfer', { tie: chosenTie }, false)} />
      </div>
      {transfer && (
        <table className="bp-table">
          <thead>
            <tr>
              <th>Side isolated at</th>
              <th>Load transferred</th>
              <th>Can carry</th>
              <th>× present</th>
              <th>Min V</th>
              <th>Max loading</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {transfer.directions.map((d, i) => (
              <tr key={i} className={d.carriesPresentLoad === false ? 'warning' : ''}>
                <td className="bp-ro">{d.isolatingName ?? d.sideBus}</td>
                <td className="bp-ro">{fmtKw(d.transferredLoadKw)}</td>
                <td className="bp-ro">{fmtKw(d.kw)}</td>
                <td className="bp-ro">{d.multiplier == null ? '—' : d.multiplier.toFixed(2)}</td>
                <td className="bp-ro">{fmtPu(d.minVpu)}</td>
                <td className="bp-ro">{fmtPct(d.maxLoadingPct, 0)}</td>
                <td className="bp-ro">{d.note ?? (d.carriesPresentLoad ? 'carries the present load' : 'cannot carry the present load')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="library-note">
        Transfer capability closes the tie, isolates one side at the first switch between it and its source, and scales
        that side's load until the voltage limit or the {n1?.loadLevel.rating === 'emergency' ? 'emergency' : 'active level’s'} rating binds. {nameOf(undefined, '')}
      </div>
    </div>
  )
}

// --- Volt/VAR -----------------------------------------------------------------------------

function VoltVarPanel() {
  const sweep = useResultsStore((s) => s.studies.sweep as SweepResult | undefined)
  const cvr = useResultsStore((s) => s.studies.cvr as CvrResult | undefined)
  const placement = useResultsStore((s) => s.studies.placement as PlacementResult | undefined)
  const nodes = useCircuitStore((s) => s.nodes)
  const { locate } = useLocate()
  const regs = nodes.filter((n) => n.type === 'regulator')
  const caps = nodes.filter((n) => n.type === 'capacitor' && typeof n.data.params.control === 'string' && n.data.params.control !== 'none')
  const [target, setTarget] = useState('')
  const [prop, setProp] = useState('vreg')
  const [values, setValues] = useState('118, 120, 122, 124')
  const [reduction, setReduction] = useState(2)
  const [kvar, setKvar] = useState(600)
  const [banks, setBanks] = useState(1)
  const chosen = target || regs[0]?.id || caps[0]?.id || ''
  const isCap = caps.some((c) => c.id === chosen)
  const hasShapes = nodes.some((n) => !!n.data.params.loadshape)
  const runSweep = () => {
    const vals = values.split(/[,\s]+/).map(Number).filter((v) => Number.isFinite(v))
    void runStudy('sweep', '/api/jobs/sweep', { sweeps: [{ id: chosen, property: prop, values: vals }] }, true)
  }
  return (
    <div className="study">
      <div className="scenarios-head">
        <b>Setting sweep</b>
        <select aria-label="Swept element" value={chosen} onChange={(e) => { setTarget(e.target.value); setProp(caps.some((c) => c.id === e.target.value) ? 'onsetting' : 'vreg') }}>
          {regs.map((r) => <option key={r.id} value={r.id}>{String(r.data.params.name ?? r.id)} (regulator)</option>)}
          {caps.map((c) => <option key={c.id} value={c.id}>{String(c.data.params.name ?? c.id)} (capacitor)</option>)}
          {!regs.length && !caps.length && <option value="">no regulator or controlled capacitor</option>}
        </select>
        <select aria-label="Swept property" value={prop} onChange={(e) => setProp(e.target.value)}>
          {(isCap ? ['onsetting', 'offsetting', 'delay'] : ['vreg', 'band', 'r', 'x']).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input aria-label="Values" value={values} onChange={(e) => setValues(e.target.value)} style={{ width: 180 }} />
        <RunButton k="sweep" disabled={!chosen} onRun={runSweep} />
        {!hasShapes && <span className="scenarios-count">no loadshapes: one load all day</span>}
      </div>
      {sweep && (
        <table className="bp-table">
          <thead>
            <tr>
              <th>Settings</th>
              <th>Energy</th>
              <th>Losses</th>
              <th>Min V</th>
              <th>Max V</th>
              <th>Control ops</th>
              <th>Under / over V (bus·steps)</th>
              <th>Overload steps</th>
            </tr>
          </thead>
          <tbody>
            {sweep.rows.map((r, i) => (
              <tr key={i} className={r.undervoltageBusSteps + r.overvoltageBusSteps + r.overloadSteps ? 'warning' : ''}>
                <td className="bp-ro">{Object.entries(r.settings).map(([k, v]) => `${k} = ${v}`).join(', ')}</td>
                <td className="bp-ro">{(r.energyKwh / 1000).toFixed(2)} MWh</td>
                <td className="bp-ro">{r.lossesKwh.toFixed(1)} kWh{r.lossPct != null ? ` (${r.lossPct.toFixed(2)} %)` : ''}</td>
                <td className="bp-ro">{fmtPu(r.minVpu)}</td>
                <td className="bp-ro">{fmtPu(r.maxVpu)}</td>
                <td className="bp-ro">{r.controlOps}</td>
                <td className="bp-ro">{r.undervoltageBusSteps} / {r.overvoltageBusSteps}</td>
                <td className="bp-ro">{r.overloadSteps}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="scenarios-head" style={{ marginTop: 10 }}>
        <b>CVR</b>
        <label>
          lower setpoints by
          <input className="hosting-num" type="number" step={0.5} aria-label="Reduction V" value={reduction} onChange={(e) => setReduction(Number(e.target.value))} /> V (120 base)
        </label>
        <RunButton k="cvr" label="Run CVR evaluation" onRun={() => void runStudy('cvr', '/api/cvr', { reductionV: reduction }, false)} />
      </div>
      {cvr && (
        <div className="reliability-indices">
          <span className="reliability-index"><b>Energy saved</b> {cvr.energySavedKwh.toFixed(1)} kWh/day ({fmtPct(cvr.energySavedPct, 2)})</span>
          <span className="reliability-index"><b>Voltage reduced</b> {fmtPct(cvr.voltageReducedPct, 2)}</span>
          <span className="reliability-index"><b>CVR factor</b> {cvr.cvrFactor == null ? '—' : cvr.cvrFactor.toFixed(2)}</span>
          <span className="reliability-index"><b>Losses saved</b> {cvr.lossesSavedKwh.toFixed(1)} kWh/day</span>
          <span className="reliability-index"><b>Lowest customer voltage</b> {cvr.lowestLoadV120 == null ? '—' : `${cvr.lowestLoadV120} V`} ({fmtPu(cvr.lowestLoadVpu)} pu)</span>
          <span className="reliability-index">{cvr.how}; {cvr.cvrLoads} load{cvr.cvrLoads === 1 ? '' : 's'} on a voltage-dependent model</span>
        </div>
      )}
      <div className="scenarios-head" style={{ marginTop: 10 }}>
        <b>Capacitor placement</b>
        <label>
          bank
          <input className="hosting-num" type="number" step={100} aria-label="Bank kvar" value={kvar} onChange={(e) => setKvar(Number(e.target.value))} /> kvar
        </label>
        <label>
          ×
          <input className="hosting-num" type="number" step={1} min={1} aria-label="Banks" value={banks} onChange={(e) => setBanks(Number(e.target.value))} />
        </label>
        <RunButton k="placement" onRun={() => void runStudy('placement', '/api/jobs/capacitor-placement', { kvar, banks }, true)} />
      </div>
      {placement && (
        <>
          <div className="reliability-indices">
            <span className="reliability-index"><b>Base losses</b> {placement.base.lossKw.toFixed(1)} kW · min V {fmtPu(placement.base.minVpu)}</span>
            <span className="reliability-index"><b>With {placement.placed.length} bank{placement.placed.length === 1 ? '' : 's'}</b> losses down {placement.totalLossReductionKw.toFixed(1)} kW</span>
          </div>
          <table className="bp-table">
            <thead>
              <tr>
                <th>Bank</th>
                <th>Bus</th>
                <th>Loss reduction</th>
                <th>Min V after</th>
                <th>Voltage lift</th>
                <th>Max V after</th>
              </tr>
            </thead>
            <tbody>
              {placement.placed.map((p, i) => (
                <tr key={i}>
                  <td className="bp-ro">{i + 1}</td>
                  <td className="bp-ro">
                    <button className="bp-locate" title="Select on diagram" onClick={() => locate(Object.entries(placement.nodeBuses).find(([, b]) => b[0] === p.bus)?.[0])}>⌖</button>{' '}
                    {placement.busNames[p.bus] ?? p.bus}
                  </td>
                  <td className="bp-ro">{p.lossReductionKw.toFixed(2)} kW</td>
                  <td className="bp-ro">{fmtPu(p.minVpu)}</td>
                  <td className="bp-ro">+{p.voltageLiftPu.toFixed(4)} pu</td>
                  <td className="bp-ro">{fmtPu(p.maxVpu)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {placement.rounds[0] && (
            <details>
              <summary>Every candidate for bank 1 ({placement.rounds[0].candidates.length} best)</summary>
              <table className="bp-table">
                <tbody>
                  {placement.rounds[0].candidates.map((c) => (
                    <tr key={c.bus} className={c.overvoltage ? 'warning' : ''}>
                      <td className="bp-ro">{placement.busNames[c.bus] ?? c.bus}</td>
                      <td className="bp-ro">{c.lossReductionKw.toFixed(2)} kW</td>
                      <td className="bp-ro">min V {fmtPu(c.minVpu)}</td>
                      <td className="bp-ro">{c.overvoltage ? 'overvoltage' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </div>
  )
}

// --- phase balance ------------------------------------------------------------------------

function BalancePanel() {
  const result = useResultsStore((s) => s.studies.balance as BalanceResult | undefined)
  const nodes = useCircuitStore((s) => s.nodes)
  const bulkUpdateParams = useCircuitStore((s) => s.bulkUpdateParams)
  const updateNodeParams = useCircuitStore((s) => s.updateNodeParams)
  const updateEdgeParams = useCircuitStore((s) => s.updateEdgeParams)
  const edges = useCircuitStore((s) => s.edges)
  const { locate } = useLocate()
  const hasElements = nodes.some((n) => n.type !== 'note' && n.type !== 'zone')
  const apply = (overrides: Record<string, Record<string, unknown>>) => {
    for (const [id, patch] of Object.entries(overrides)) {
      if (edges.some((e) => e.id === id)) updateEdgeParams(id, patch)
      else updateNodeParams(id, patch)
    }
    void bulkUpdateParams
  }
  return (
    <div className="study">
      <div className="scenarios-head">
        <b>Phase balance</b>
        <RunButton k="balance" disabled={!hasElements} onRun={() => void runStudy('balance', '/api/jobs/phase-balance', {}, true)} />
      </div>
      {!result ? (
        <div className="bp-empty">
          The current unbalance at the feeder head and the voltage unbalance at every three-phase bus, then every
          single-phase lateral tried on each other phase (a rebuild and a solve each), ranked by how much the head
          unbalance falls. <i>Apply</i> re-pins the lateral on the drawing.
        </div>
      ) : (
        <>
          <div className="reliability-indices">
            <span className="reliability-index"><b>Head currents</b> {result.base.headCurrentsA?.map((a) => a.toFixed(0)).join(' / ') ?? '—'} A</span>
            <span className="reliability-index"><b>Current unbalance</b> {fmtPct(result.base.currentUnbalancePct)}</span>
            <span className="reliability-index"><b>Worst voltage unbalance</b> {fmtPct(result.base.voltageUnbalancePct, 2)} at {result.base.voltageUnbalanceBus ?? '—'}</span>
            <span className="reliability-index"><b>Laterals</b> {result.laterals.length}</span>
          </div>
          <table className="bp-table">
            <thead>
              <tr>
                <th />
                <th>Lateral</th>
                <th>Load</th>
                <th>Move</th>
                <th>Head unbalance after</th>
                <th>Improvement</th>
                <th>Loss change</th>
                <th>Worst V unbalance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {result.candidates.slice(0, 60).map((c, i) => (
                <tr key={i} className={(c.currentImprovementPct ?? 0) > 0 ? '' : 'warning'}>
                  <td><button className="bp-locate" title="Select on diagram" onClick={() => locate(c.lateral)}>⌖</button></td>
                  <td className="bp-ro">{c.name} <span className="scenarios-count">{c.elements} el.</span></td>
                  <td className="bp-ro">{fmtKw(c.loadKw)}</td>
                  <td className="bp-ro">{c.fromPhase} → {c.toPhase}</td>
                  <td className="bp-ro">{fmtPct(c.currentUnbalancePct)}</td>
                  <td className="bp-ro">{c.currentImprovementPct == null ? '—' : `${c.currentImprovementPct > 0 ? '−' : '+'}${Math.abs(c.currentImprovementPct).toFixed(1)} pts`}</td>
                  <td className="bp-ro">{c.lossChangeKw == null ? '—' : `${c.lossChangeKw > 0 ? '+' : ''}${c.lossChangeKw.toFixed(2)} kW`}</td>
                  <td className="bp-ro">{fmtPct(c.voltageUnbalancePct, 2)}</td>
                  <td><button type="button" onClick={() => apply(c.overrides)} title="Re-pin this lateral on the drawing">Apply</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// --- losses and capacity ----------------------------------------------------------------------

function CapacityPanel() {
  const losses = useResultsStore((s) => s.studies.losses as LossResult | undefined)
  const cap = useResultsStore((s) => s.studies.capacity as CapacityResult | undefined)
  const nodes = useCircuitStore((s) => s.nodes)
  const hasElements = nodes.some((n) => n.type !== 'note' && n.type !== 'zone')
  const [mode, setMode] = useState<'daily' | 'yearly'>('daily')
  const [price, setPrice] = useState(0.08)
  return (
    <div className="study">
      <div className="scenarios-head">
        <b>Loss evaluation</b>
        <select aria-label="Horizon" value={mode} onChange={(e) => setMode(e.target.value as 'daily' | 'yearly')}>
          <option value="daily">a day</option>
          <option value="yearly">a year</option>
        </select>
        <label>
          at $
          <input className="hosting-num" type="number" step={0.01} aria-label="Price per kWh" value={price} onChange={(e) => setPrice(Number(e.target.value))} /> /kWh
        </label>
        <RunButton k="losses" disabled={!hasElements} onRun={() => void runStudy('losses', '/api/jobs/loss-evaluation', { mode, pricePerKwh: price }, true)} />
      </div>
      {losses && (
        <>
          <div className="reliability-indices">
            <span className="reliability-index"><b>Energy served</b> {(losses.energyKwh / 1000).toFixed(1)} MWh</span>
            <span className="reliability-index"><b>Losses</b> {(losses.lossesKwh / 1000).toFixed(2)} MWh ({fmtPct(losses.lossPct, 2)})</span>
            {losses.costTotal != null && <span className="reliability-index"><b>Cost</b> ${losses.costTotal.toFixed(0)}</span>}
            <span className="reliability-index"><b>At peak</b> {losses.peakLossKw.toFixed(1)} kW of {fmtKw(losses.peakKw)} ({fmtPct(losses.peakLossPct, 2)})</span>
          </div>
          <table className="bp-table">
            <thead>
              <tr>
                <th>Element class</th>
                <th>Losses</th>
                <th>Share</th>
                {losses.pricePerKwh > 0 && <th>Cost</th>}
              </tr>
            </thead>
            <tbody>
              {losses.byClass.map((r) => (
                <tr key={r.class}>
                  <td className="bp-ro">{r.label}</td>
                  <td className="bp-ro">{r.kwh.toFixed(1)} kWh</td>
                  <td className="bp-ro">{fmtPct(r.share)}</td>
                  {losses.pricePerKwh > 0 && <td className="bp-ro">${(r.cost ?? 0).toFixed(0)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="scenarios-head" style={{ marginTop: 10 }}>
        <b>Capacity</b>
        <RunButton k="capacity" label="Find the feeder's capacity" disabled={!hasElements} onRun={() => void runStudy('capacity', '/api/capacity', {}, false)} />
      </div>
      {cap && (
        <div className="reliability-indices">
          <span className="reliability-index">
            <b>Capacity</b> {fmtKw(cap.capacityKw)} at ×{cap.capacityMult.toFixed(2)} of rated load{cap.capped ? ' (search cap reached)' : ''}
          </span>
          <span className="reliability-index"><b>Headroom</b> {fmtKw(cap.headroomKw)} above the {cap.loadLevel.name} case ({fmtKw(cap.base.sourceKw)})</span>
          <span className="reliability-index"><b>Binds on</b> {cap.binding === 'voltage' ? `undervoltage at ${cap.atLimit.minVBus ?? '—'}` : cap.binding === 'thermal' ? `overload of ${cap.atLimit.maxLoadingElement ?? '—'}` : cap.binding}</span>
          <span className="reliability-index"><b>At the limit</b> min V {fmtPu(cap.atLimit.minVpu)} · max loading {fmtPct(cap.atLimit.maxLoadingPct, 0)}</span>
          {cap.atCapacity && <span className="reliability-index">The present case already breaks a criterion.</span>}
        </div>
      )}
    </div>
  )
}
