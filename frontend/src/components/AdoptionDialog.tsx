import { useEffect, useMemo, useRef, useState } from 'react'
import { useCircuitStore, type AppNode } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { LoadShapeJSON } from '../types/circuit'

/** Built-in hourly shapes for the things people add to a house. Synthetic
 *  but typical: a residential Level 2 charger plugged in on coming home, a
 *  workplace charger over the working day, a heat pump following a cold
 *  day, and a south-facing roof. Replace with a measured shape by name. */
export const ADOPTION_SHAPES: Record<string, { label: string; kw: number; shape: LoadShapeJSON; kind: 'load' | 'pv' }> = {
  ev_home: {
    label: 'EV charger, home Level 2 (7 kW, evening)',
    kw: 7,
    kind: 'load',
    shape: { intervalMin: 60, points: [0.6, 0.4, 0.2, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.3, 0.7, 1, 1, 0.9, 0.8, 0.7, 0.6], source: 'builtin:ev_home' },
  },
  ev_work: {
    label: 'EV charger, workplace (7 kW, daytime)',
    kw: 7,
    kind: 'load',
    shape: { intervalMin: 60, points: [0, 0, 0, 0, 0, 0, 0.1, 0.5, 1, 1, 0.9, 0.7, 0.6, 0.6, 0.5, 0.3, 0.2, 0.1, 0, 0, 0, 0, 0, 0], source: 'builtin:ev_work' },
  },
  heat_pump: {
    label: 'Heat pump, cold day (4 kW)',
    kw: 4,
    kind: 'load',
    shape: { intervalMin: 60, points: [0.8, 0.8, 0.8, 0.8, 0.85, 0.95, 1, 1, 0.9, 0.7, 0.5, 0.4, 0.35, 0.35, 0.4, 0.5, 0.7, 0.85, 0.9, 0.9, 0.85, 0.85, 0.8, 0.8], source: 'builtin:heat_pump' },
  },
  rooftop_pv: {
    label: 'Rooftop PV (6 kW, clear day)',
    kw: 6,
    kind: 'pv',
    shape: { kind: 'irradiance', intervalMin: 60, points: [0, 0, 0, 0, 0, 0, 0.05, 0.2, 0.45, 0.7, 0.88, 0.98, 1, 0.95, 0.82, 0.62, 0.38, 0.15, 0.02, 0, 0, 0, 0, 0], source: 'builtin:rooftop_pv' },
  },
}

/** A small deterministic generator (mulberry32), so a seed reproduces a draw. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Analysis → Adoption scenario…: EVs, heat pumps or PV drawn at random
 *  among the loads of a class, several draws as scenarios. */
export function AdoptionDialog({ onClose }: { onClose: () => void }) {
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const loadShapes = useCircuitStore((s) => s.loadShapes)
  const setFlash = useResultsStore((s) => s.setFlash)
  const [what, setWhat] = useState('ev_home')
  const [cls, setCls] = useState('')
  const [pct, setPct] = useState(30)
  const [kw, setKw] = useState(ADOPTION_SHAPES.ev_home.kw)
  const [seed, setSeed] = useState(1)
  const [draws, setDraws] = useState(3)
  const [shapeName, setShapeName] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  const loads = useMemo(() => nodes.filter((n) => n.type === 'load'), [nodes])
  const classes = useMemo(() => [...new Set(loads.map((n) => String(n.data.params.class ?? '').trim()).filter(Boolean))].sort(), [loads])
  const pool = useMemo(() => loads.filter((n) => !cls || String(n.data.params.class ?? '').trim() === cls), [loads, cls])
  const preset = ADOPTION_SHAPES[what]

  const run = () => {
    const store = useCircuitStore.getState()
    const shapeKey = shapeName || `adopt_${what}`
    if (!shapeName) store.setLoadShape(shapeKey, preset.shape)
    const count = Math.round((pct / 100) * pool.length)
    if (!count) {
      setFlash('No loads to draw from at that rate.')
      return
    }
    const parentBus = (n: AppNode) => {
      const e = edges.find((x) => x.source === n.id || x.target === n.id)
      if (!e) return null
      return e.source === n.id ? { id: e.target, handle: e.targetHandle ?? 'b0' } : { id: e.source, handle: e.sourceHandle ?? 'b0' }
    }
    const made: string[] = []
    for (let d = 0; d < draws; d++) {
      const random = rng(seed + d * 7919)
      const shuffled = [...pool].sort(() => random() - 0.5)
      const picked = shuffled.slice(0, count)
      const id = store.addScenario(`${preset.label.split(' (')[0]} ${pct} %, draw ${d + 1}`, `${count} of ${pool.length} ${cls || 'loads'} at ${kw} kW each, seed ${seed + d * 7919}`)
      const s = useCircuitStore.getState()
      for (const n of picked) {
        const bus = parentBus(n)
        if (!bus) continue
        const type = preset.kind === 'pv' ? 'pvsystem' : 'load'
        const newId = s.addNodeAt(type, { x: n.position.x + 70, y: n.position.y + 40 })
        const params: Record<string, unknown> = preset.kind === 'pv'
          ? { name: `PV_${String(n.data.params.name ?? n.id)}`, kv: n.data.params.kv, kva: kw, pmpp: kw, phases: n.data.params.phases ?? 1, phasing: n.data.params.phasing, loadshape: shapeKey }
          : { name: `${what === 'heat_pump' ? 'HP' : 'EV'}_${String(n.data.params.name ?? n.id)}`, kv: n.data.params.kv, kw, pf: 0.98, phases: n.data.params.phases ?? 1, phasing: n.data.params.phasing, class: String(n.data.params.class ?? ''), loadshape: shapeKey, model: 1 }
        s.updateNodeParams(newId, params)
        s.onConnect({ source: bus.id, sourceHandle: bus.handle, target: newId, targetHandle: 't1' })
      }
      made.push(id)
    }
    useCircuitStore.getState().activateScenario(null)
    setFlash(`${made.length} scenario${made.length === 1 ? '' : 's'} created; Run all in the Scenarios tab solves them at every level.`, 'info', 8000)
    onClose()
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box wide" role="dialog" aria-label="Adoption scenario" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-title">Adoption scenario</div>
        <div className="alloc-grid">
          <label>
            What is adopted
            <select aria-label="Adopted" value={what} onChange={(e) => { setWhat(e.target.value); setKw(ADOPTION_SHAPES[e.target.value].kw) }}>
              {Object.entries(ADOPTION_SHAPES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          <label>
            Among loads of class
            <select aria-label="Class" value={cls} onChange={(e) => setCls(e.target.value)}>
              <option value="">any ({loads.length})</option>
              {classes.map((c) => (
                <option key={c} value={c}>{c} ({loads.filter((n) => String(n.data.params.class ?? '').trim() === c).length})</option>
              ))}
            </select>
          </label>
          <label>
            Adoption rate (%)
            <input type="number" min={0} max={100} aria-label="Adoption rate" value={pct} onChange={(e) => setPct(Number(e.target.value))} />
          </label>
          <label>
            Size per adopter (kW)
            <input type="number" step={0.5} aria-label="kW" value={kw} onChange={(e) => setKw(Number(e.target.value))} />
          </label>
          <label>
            Shape (blank: the built-in one)
            <select aria-label="Shape" value={shapeName} onChange={(e) => setShapeName(e.target.value)}>
              <option value="">built-in {preset.label.split(' (')[0].toLowerCase()} shape</option>
              {Object.keys(loadShapes).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Seed
            <input type="number" aria-label="Seed" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
          </label>
          <label>
            Draws (scenarios)
            <input type="number" min={1} max={20} aria-label="Draws" value={draws} onChange={(e) => setDraws(Number(e.target.value))} />
          </label>
        </div>
        <div className="library-note">
          {Math.round((pct / 100) * pool.length)} of {pool.length} loads get a {kw} kW {preset.kind === 'pv' ? 'PV system' : 'load'} on the same bus,
          on the built-in shape unless another is named; each draw is a scenario, so the batch run shows the spread.
          The built-in shapes are typical, not measured.
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="modal-primary" disabled={!pool.length} onClick={run}>Create the scenarios</button>
        </div>
      </div>
    </div>
  )
}
