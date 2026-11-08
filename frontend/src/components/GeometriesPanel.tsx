import { useEffect, useMemo, useState } from 'react'
import { beginGesture, endGesture, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { LineGeometryJSON, WireDataJSON, WireLibraryEntry } from '../types/circuit'
import { LineCodesPanel } from './LineCodesPanel'

const UNITS = ['ft', 'm', 'mi', 'km', 'kft', 'in', 'cm']

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}${i}`)) i++
  return `${base}${i}`
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

let wireLibrary: WireLibraryEntry[] | null = null
async function loadWireLibrary(): Promise<WireLibraryEntry[]> {
  if (wireLibrary) return wireLibrary
  try {
    const res = await fetch('/api/catalog/wires')
    const data = (await res.json()) as { wires: WireLibraryEntry[] }
    wireLibrary = data.wires
  } catch {
    wireLibrary = []
  }
  return wireLibrary
}

/** A number field that commits on blur, blank meaning "not set". */
function NumField({ label, unit, value, onCommit, step = 0.001 }: { label: string; unit?: string; value: number | null | undefined; onCommit: (v: number | null) => void; step?: number }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <label className="prop-row">
      <span>{label}{unit ? ` (${unit})` : ''}</span>
      <input
        type="number"
        step={step}
        value={text ?? (value == null ? '' : String(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          setText(null)
          const v = e.target.value.trim()
          onCommit(v === '' ? null : Number(v))
        }}
      />
    </label>
  )
}

/** The circuit's conductors: WireData, and CNData / TSData for cables. */
export function ConductorsPanel() {
  const wires = useCircuitStore((s) => s.wireData)
  const setWire = useCircuitStore((s) => s.setWireData)
  const removeWire = useCircuitStore((s) => s.removeWireData)
  const geometries = useCircuitStore((s) => s.lineGeometries)
  const names = Object.keys(wires)
  const [selected, setSelected] = useState<string | null>(names[0] ?? null)
  const active = selected && wires[selected] ? selected : (names[0] ?? null)
  const spec = active ? wires[active] : null
  const [library, setLibrary] = useState<WireLibraryEntry[]>([])
  const [pick, setPick] = useState('')
  useEffect(() => {
    void loadWireLibrary().then(setLibrary)
  }, [])
  const usedBy = useMemo(
    () => (active ? Object.entries(geometries).filter(([, g]) => g.conductors.some((c) => c.wire === active)).map(([n]) => n) : []),
    [geometries, active],
  )
  const update = (patch: Partial<WireDataJSON>) => {
    if (!active || !spec) return
    beginGesture()
    setWire(active, { ...spec, ...patch })
    endGesture()
  }
  const addFromLibrary = (code: string) => {
    const entry = library.find((w) => w.code === code)
    if (!entry) return
    const name = uniqueName(code, new Set(names))
    beginGesture()
    setWire(name, { ...entry.spec })
    endGesture()
    setSelected(name)
    setPick('')
  }
  const add = () => {
    const name = uniqueName('wire1', new Set(names))
    beginGesture()
    setWire(name, { kind: 'wire', rac: 0.306, runits: 'mi', gmr: 0.0244, gmrunits: 'ft', radius: 0.3605, radunits: 'in', normamps: 530, extra: {}, source: 'typed in' })
    endGesture()
    setSelected(name)
  }
  return (
    <div className="curves-panel">
      <div className="curves-list">
        <button className="curves-add" onClick={add}>+ New conductor</button>
        <select className="curves-add" aria-label="Add from the conductor library" value={pick} onChange={(e) => addFromLibrary(e.target.value)}>
          <option value="">+ From the library…</option>
          {library.map((w) => (
            <option key={w.code} value={w.code}>{w.label}</option>
          ))}
        </select>
        {names.length === 0 && (
          <div className="bp-empty">No conductors yet. Add one from the library (standard ACSR, AAC and cable sizes) or type one in; geometries hang them on a pole or in a trench.</div>
        )}
        {names.map((n) => (
          <button key={n} className={`curves-item${n === active ? ' active' : ''}`} onClick={() => setSelected(n)}>
            {n}
            <span className="curves-count">{wires[n].kind === 'wire' ? 'wire' : wires[n].kind === 'cn' ? 'CN cable' : 'TS cable'}</span>
          </button>
        ))}
      </div>
      {active && spec && (
        <div className="curves-editor">
          <div className="curves-head">
            <input
              className="curves-name"
              aria-label="Conductor name"
              value={active}
              onChange={(e) => {
                const next = e.target.value.trim()
                if (!next || next === active || wires[next]) return
                beginGesture()
                setWire(next, spec)
                removeWire(active)
                endGesture()
                setSelected(next)
              }}
            />
            <button className="curves-delete" onClick={() => { removeWire(active); setSelected(null) }} title={usedBy.length ? `Used by geometry ${usedBy.join(', ')}` : 'Delete this conductor'}>
              Delete
            </button>
          </div>
          <div className="geometry-grid">
            <label className="prop-row">
              <span>Kind</span>
              <select value={spec.kind} onChange={(e) => update({ kind: e.target.value as WireDataJSON['kind'] })}>
                <option value="wire">bare wire</option>
                <option value="cn">concentric-neutral cable</option>
                <option value="ts">tape-shield cable</option>
              </select>
            </label>
            <NumField label="R dc" value={num(spec.rdc)} onCommit={(v) => update({ rdc: v })} />
            <NumField label="R ac" value={num(spec.rac)} onCommit={(v) => update({ rac: v })} />
            <label className="prop-row">
              <span>Resistance per</span>
              <select value={spec.runits} onChange={(e) => update({ runits: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
            </label>
            <NumField label="GMR" value={num(spec.gmr)} onCommit={(v) => update({ gmr: v })} step={0.0001} />
            <label className="prop-row">
              <span>GMR units</span>
              <select value={spec.gmrunits} onChange={(e) => update({ gmrunits: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
            </label>
            <NumField label="Radius" value={num(spec.radius)} onCommit={(v) => update({ radius: v })} step={0.0001} />
            <label className="prop-row">
              <span>Radius units</span>
              <select value={spec.radunits} onChange={(e) => update({ radunits: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
            </label>
            <NumField label="Ampacity" unit="A" value={num(spec.normamps)} onCommit={(v) => update({ normamps: v })} step={1} />
            <NumField label="Emergency" unit="A" value={num(spec.emergamps)} onCommit={(v) => update({ emergamps: v })} step={1} />
            {spec.kind !== 'wire' &&
              (spec.kind === 'cn' ? ['k', 'diastrand', 'gmrstrand', 'rstrand', 'epsr', 'inslayer', 'diains', 'diacable'] : ['diashield', 'tapelayer', 'tapelap', 'epsr', 'inslayer', 'diains', 'diacable']).map((key) => (
                <NumField key={key} label={key} value={num(spec.extra?.[key])} onCommit={(v) => update({ extra: { ...(spec.extra ?? {}), ...(v == null ? {} : { [key]: v }) } })} step={0.0001} />
              ))}
          </div>
          <div className="library-note">
            {spec.source ? `Source: ${spec.source}. ` : ''}Resistance and GMR as the conductor table gives them, in the units named; the engine
            builds the impedance matrix from them and the geometry with Carson's equations.
            {usedBy.length > 0 && ` Used by ${usedBy.join(', ')}.`}
          </div>
        </div>
      )}
    </div>
  )
}

/** The circuit's pole and trench configurations (LineGeometry). */
export function GeometriesPanel() {
  const geometries = useCircuitStore((s) => s.lineGeometries)
  const wires = useCircuitStore((s) => s.wireData)
  const setGeometry = useCircuitStore((s) => s.setLineGeometry)
  const removeGeometry = useCircuitStore((s) => s.removeLineGeometry)
  const edges = useCircuitStore((s) => s.edges)
  const setFlash = useResultsStore((s) => s.setFlash)
  const names = Object.keys(geometries)
  const wireNames = Object.keys(wires)
  const [selected, setSelected] = useState<string | null>(names[0] ?? null)
  const active = selected && geometries[selected] ? selected : (names[0] ?? null)
  const spec = active ? geometries[active] : null
  const usedBy = useMemo(() => edges.filter((e) => e.type === 'line' && e.data?.params.geometry === active).length, [edges, active])
  const update = (patch: Partial<LineGeometryJSON>) => {
    if (!active || !spec) return
    beginGesture()
    setGeometry(active, { ...spec, ...patch })
    endGesture()
  }
  const add = () => {
    if (!wireNames.length) {
      setFlash('Add a conductor first (Conductors), then hang it on a geometry.')
      return
    }
    const name = uniqueName('pole1', new Set(names))
    const w = wireNames[0]
    beginGesture()
    setGeometry(name, {
      nconds: 4, nphases: 3, reduce: true, units: 'ft',
      conductors: [{ wire: w, x: -4, h: 28 }, { wire: w, x: -1.5, h: 28 }, { wire: w, x: 3, h: 28 }, { wire: wireNames[1] ?? w, x: 0, h: 24 }],
      source: 'typed in',
    })
    endGesture()
    setSelected(name)
  }
  const setConds = (n: number) => {
    if (!spec) return
    const conds = [...spec.conductors]
    while (conds.length < n) conds.push({ wire: wireNames[0] ?? '', x: 0, h: 24 })
    update({ nconds: n, conductors: conds.slice(0, n), nphases: Math.min(spec.nphases, n) })
  }
  return (
    <div className="curves-panel">
      <div className="curves-list">
        <button className="curves-add" onClick={add}>+ New geometry</button>
        {names.length === 0 && (
          <div className="bp-empty">No geometries yet. A geometry is which conductor hangs where on the pole (or lies where in the trench); a line on a geometry needs no line code, the engine works the impedance out.</div>
        )}
        {names.map((n) => (
          <button key={n} className={`curves-item${n === active ? ' active' : ''}`} onClick={() => setSelected(n)}>
            {n}
            <span className="curves-count">{geometries[n].nconds} cond · {geometries[n].nphases}φ</span>
          </button>
        ))}
      </div>
      {active && spec && (
        <div className="curves-editor">
          <div className="curves-head">
            <input
              className="curves-name"
              aria-label="Geometry name"
              value={active}
              onChange={(e) => {
                const next = e.target.value.trim()
                if (!next || next === active || geometries[next]) return
                beginGesture()
                setGeometry(next, spec)
                removeGeometry(active)
                endGesture()
                setSelected(next)
              }}
            />
            <button className="curves-delete" onClick={() => { removeGeometry(active); setSelected(null) }} title={usedBy ? `${usedBy} line${usedBy === 1 ? '' : 's'} would lose their impedance` : 'Delete this geometry'}>
              Delete
            </button>
          </div>
          <div className="geometry-grid">
            <label className="prop-row"><span>Conductors</span>
              <select value={spec.nconds} onChange={(e) => setConds(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </label>
            <label className="prop-row"><span>Phases</span>
              <select value={spec.nphases} onChange={(e) => update({ nphases: Number(e.target.value) })}>{[1, 2, 3].filter((n) => n <= spec.nconds).map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </label>
            <label className="prop-row"><span>Coordinates in</span>
              <select value={spec.units} onChange={(e) => update({ units: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
            </label>
            <label className="prefs-radio"><input type="checkbox" checked={spec.reduce} onChange={(e) => update({ reduce: e.target.checked })} /> Kron-reduce the neutral</label>
          </div>
          <table className="bp-table geometry-table">
            <thead>
              <tr><th>#</th><th>Conductor</th><th>x ({spec.units})</th><th>Height ({spec.units})</th><th>Role</th></tr>
            </thead>
            <tbody>
              {spec.conductors.map((c, i) => (
                <tr key={i}>
                  <td className="bp-ro">{i + 1}</td>
                  <td>
                    <select aria-label={`Conductor ${i + 1}`} value={c.wire} onChange={(e) => update({ conductors: spec.conductors.map((x, k) => (k === i ? { ...x, wire: e.target.value } : x)) })}>
                      {!wires[c.wire] && <option value={c.wire}>{c.wire || '(pick)'} (missing)</option>}
                      {wireNames.map((w) => <option key={w} value={w}>{w}</option>)}
                    </select>
                  </td>
                  <td><input type="number" step={0.1} aria-label={`x ${i + 1}`} value={c.x} onChange={(e) => update({ conductors: spec.conductors.map((x, k) => (k === i ? { ...x, x: Number(e.target.value) } : x)) })} /></td>
                  <td><input type="number" step={0.1} aria-label={`h ${i + 1}`} value={c.h} onChange={(e) => update({ conductors: spec.conductors.map((x, k) => (k === i ? { ...x, h: Number(e.target.value) } : x)) })} /></td>
                  <td className="bp-ro">{i < spec.nphases ? ['A', 'B', 'C'][i] ?? 'phase' : 'neutral'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="library-note">
            The first {spec.nphases} conductors are the phases, the rest neutrals; a line's *Geometry* field names this. {usedBy ? `${usedBy} line${usedBy === 1 ? '' : 's'} on it.` : 'No line uses it yet.'}
          </div>
        </div>
      )}
    </div>
  )
}

/** The Line codes tab: codes, geometries, conductors. */
export function LineCodesTab() {
  const [which, setWhich] = useState<'codes' | 'geometries' | 'conductors'>('codes')
  return (
    <div className="curves-wrap">
      <div className="scenarios-head curves-switch">
        <label className="prefs-radio"><input type="radio" checked={which === 'codes'} onChange={() => setWhich('codes')} /> Line codes</label>
        <label className="prefs-radio"><input type="radio" checked={which === 'geometries'} onChange={() => setWhich('geometries')} /> Geometries</label>
        <label className="prefs-radio"><input type="radio" checked={which === 'conductors'} onChange={() => setWhich('conductors')} /> Conductors</label>
      </div>
      {which === 'codes' ? <LineCodesPanel /> : which === 'geometries' ? <GeometriesPanel /> : <ConductorsPanel />}
    </div>
  )
}
