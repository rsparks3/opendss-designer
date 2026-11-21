import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { sizingSvg } from '../lib/report/charts'
import { dispatchShape, hourLabel, sizedUnits, type SizingOptions, type SizingResult } from '../lib/sizing'
import { downstream, topologyOf } from '../lib/trace'
import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import { LockedNote } from './LockedNote'

const kw = (v: number) => `${Math.round(v).toLocaleString()} kW`
const kwh = (v: number) => `${Math.round(v).toLocaleString()} kWh`

/** Right-click a device → Size backup for downstream…: the generator and
 *  battery the island below it needs over a day or a year, with a daily
 *  verification run, and the sizes put into a new scenario on request. */
export function SizingDialog({ onClose }: { onClose: () => void }) {
  const target = useUiStore((s) => s.sizingTarget)
  const nodes = useCircuitStore((s) => s.nodes)
  const shapes = useCircuitStore((s) => s.loadShapes)
  const setFlash = useResultsStore((s) => s.setFlash)
  const setStudy = useResultsStore((s) => s.setStudy)
  const kept = useResultsStore((s) => s.studies.sizing as SizingResult | undefined)
  const [opts, setOpts] = useState<Omit<SizingOptions, 'elementId'>>({
    shape: null, mode: 'daily', marginPct: 20, countPv: true, generatorKw: null, efficiencyPct: 90, reservePct: 20, verify: true,
  })
  const [result, setResult] = useState<SizingResult | null>(kept && kept.elementId === target ? kept : null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])
  const el = nodes.find((n) => n.id === target)
  const name = String(el?.data.params.name ?? target ?? '')
  const loadShapes = Object.entries(shapes).filter(([, s]) => (s.kind ?? 'load') === 'load').map(([n]) => n)

  const run = async () => {
    if (!target) return
    setBusy(true)
    try {
      const r = await api.sizing(toCircuitJSON(useCircuitStore.getState()), { ...opts, elementId: target })
      if (!r.ok) {
        setFlash(r.issues.find((i) => i.severity === 'error')?.message ?? 'Sizing failed.')
        return
      }
      setResult(r)
      setStudy('sizing', r)
    } catch (err) {
      setFlash(`Sizing failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const insert = () => {
    if (!result || !el) return
    const cs = useCircuitStore.getState()
    // The new units hang off the element's island side.
    const lost = new Set(downstream(topologyOf(cs.nodes, cs.edges), el.id).buses)
    const own = topologyOf(cs.nodes, cs.edges).elementBuses.get(el.id) ?? []
    const handle = el.type === 'busbar' ? 'b1' : lost.has(own[0] ?? '') && !lost.has(own[1] ?? '') ? 't1' : 't2'
    let shape: string | null = null
    if (result.battery.kwh > 0 && result.mode === 'daily') {
      shape = 'backup_dispatch'
      for (let i = 2; shape in cs.loadShapes; i++) shape = `backup_dispatch_${i}`
      cs.setLoadShape(shape, { kind: 'load', intervalMin: 60, points: dispatchShape(result), source: `sizing:${result.elementName}` })
    }
    const units = sizedUnits(result, shape)
    cs.addScenario(`Backup for ${result.elementName}`,
      `Generator ${result.generator.chosenKw} kW${units.storage ? `, battery ${result.battery.kw} kW / ${result.battery.kwh} kWh` : ''} from Size backup (${result.mode}).`)
    let dx = 90
    for (const [type, params] of [['generator', units.generator], ['storage', units.storage]] as const) {
      if (!params) continue
      const s = useCircuitStore.getState()
      const id = s.addNodeAt(type, { x: el.position.x + dx, y: el.position.y + 100 })
      s.updateNodeParams(id, params)
      s.onConnect({ source: el.id, sourceHandle: handle, target: id, targetHandle: 't1' })
      dx += 80
    }
    setFlash(`Added to a new scenario, "Backup for ${result.elementName}".`, 'info', 6000)
    onClose()
  }

  const svg = result ? sizingSvg(result) : null
  const v = result?.verification
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box wide" role="dialog" aria-label="Size backup" tabIndex={-1} ref={box}
           onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <LockedNote feature="studies" />
        <div className="modal-title">Size backup for everything below {name}</div>
        <div className="project-grid">
          <label>
            Load shape
            <select aria-label="Load shape" value={opts.shape ?? ''} onChange={(e) => setOpts({ ...opts, shape: e.target.value || null })}>
              <option value="">each load's own (flat where none)</option>
              {loadShapes.map((n) => <option key={n} value={n}>{n} for every load</option>)}
            </select>
          </label>
          <label>
            Over
            <select aria-label="Over" value={opts.mode} onChange={(e) => setOpts({ ...opts, mode: e.target.value as 'daily' | 'yearly' })}>
              <option value="daily">a day</option>
              <option value="yearly">a year</option>
            </select>
          </label>
          <label>
            Reserve margin (%)
            <input type="number" aria-label="Reserve margin" value={opts.marginPct} onChange={(e) => setOpts({ ...opts, marginPct: Number(e.target.value) })} />
          </label>
          <label className="prefs-radio">
            <input type="checkbox" checked={opts.countPv} onChange={(e) => setOpts({ ...opts, countPv: e.target.checked })} /> count PV in the island
          </label>
          <label>
            Generator for the battery (kW)
            <input type="number" aria-label="Generator kW" placeholder="the size found" value={opts.generatorKw ?? ''}
                   onChange={(e) => setOpts({ ...opts, generatorKw: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <label>
            Battery round trip (%)
            <input type="number" aria-label="Round-trip efficiency" value={opts.efficiencyPct} onChange={(e) => setOpts({ ...opts, efficiencyPct: Number(e.target.value) })} />
          </label>
          <label>
            Battery reserve (%)
            <input type="number" aria-label="Battery reserve" value={opts.reservePct} onChange={(e) => setOpts({ ...opts, reservePct: Number(e.target.value) })} />
          </label>
          <label className="prefs-radio">
            <input type="checkbox" checked={opts.verify} onChange={(e) => setOpts({ ...opts, verify: e.target.checked })} /> verify with a daily run
          </label>
        </div>
        {result && (
          <div className="sizing-result">
            <div className="reliability-indices">
              <span className="reliability-index"><b>Generator</b> {kw(result.generator.requiredKw)} needed: peak net load {kw(result.generator.peakNetKw)} at {hourLabel(result.generator.peakHour, result.mode === 'yearly')} + {result.generator.marginPct} %</span>
              <span className="reliability-index">{result.generator.hoursAbove80} h above 80 % of {kw(result.generator.chosenKw)}</span>
              {result.generator.existing.map((g) => (
                <span key={g.id} className="reliability-index">{g.name}: {g.fuelHours ? `${g.fuelHours} h of fuel` : 'fuel not entered'}</span>
              ))}
            </div>
            <div className="reliability-indices">
              {result.battery.kwh > 0 ? (
                <span className="reliability-index"><b>Battery</b> {kw(result.battery.kw)} / {kwh(result.battery.kwh)} ({kwh(result.battery.usableKwh)} usable above a {result.battery.reservePct} % reserve, for {kw(result.generator.chosenKw)} of generator)</span>
              ) : (
                <span className="reliability-index"><b>Battery</b> none needed with {kw(result.generator.chosenKw)} of generator</span>
              )}
              <span className={`reliability-index${result.battery.cycleCloses ? '' : ' bad'}`}>
                {result.battery.cycleCloses
                  ? `the ${result.mode === 'daily' ? 'day' : 'year'} closes with ${kwh(result.battery.energyBalanceKwh)} to spare`
                  : `short ${kwh(-result.battery.energyBalanceKwh)} a ${result.mode === 'daily' ? 'day' : 'year'}: cannot be carried indefinitely${result.battery.emptiesAfterHours ? `; the battery is empty after about ${Math.round(result.battery.emptiesAfterHours)} h` : ''}`}
              </span>
              {result.reversePowerCount > 0 && (
                <span className="reliability-index bad">{result.reversePowerCount} h of PV surplus with nowhere to go but the generator (reverse power): curtail the PV or add storage</span>
              )}
            </div>
            {v && (
              <div className="library-note">
                <b>Verification:</b>{' '}
                {!v.ran ? v.why : !v.converged ? 'the island did not solve.' : v.passed
                  ? `passed — generator at most ${v.maxGenLoadingPct} % of ${v.generatorKva} kVA${v.minSocPct != null ? `, battery never below ${v.minSocPct} %` : ''}, no reverse power.`
                  : v.oneDayOnly
                    ? `carried for one day from a full battery (generator at most ${v.maxGenLoadingPct} %, battery down to ${v.minSocPct} %), but the day is short of energy, so not indefinitely.`
                    : `failed — generator up to ${v.maxGenLoadingPct} % of ${v.generatorKva} kVA${v.minSocPct != null ? `, battery down to ${v.minSocPct} %` : ''}${v.reverseHours ? `, ${v.reverseHours} h of reverse power` : ''}.`}
              </div>
            )}
            {svg && <div className="sizing-chart" dangerouslySetInnerHTML={{ __html: svg }} />}
            <div className="library-note">
              A sizing calculator, not an optimisation: PV is Pmpp × irradiance without inverter or temperature losses,
              the generator is an isochronous source rated at its kW at 0.8 power factor, and the battery charges only
              from surplus.
            </div>
          </div>
        )}
        <div className="modal-actions">
          {result && el && (
            <button type="button" onClick={insert} title="Add the generator (on standby) and battery, connected below this element, in a new scenario">
              Insert in a new scenario
            </button>
          )}
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" className="modal-primary" disabled={busy || !target} onClick={() => void run()}>
            {busy ? 'Sizing…' : 'Size'}
          </button>
        </div>
      </div>
    </div>
  )
}
