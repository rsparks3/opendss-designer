import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { loadImported, pickFiles } from '../lib/fileActions'
import { BuildError, buildModel, crsUnits, type LayerPlan } from '../lib/gis/build'
import { autoMap, CLASSES, guessClass, type ElementClass } from '../lib/gis/classes'
import { readLayers, type Layer } from '../lib/gis/layers'
import { readPref, writePref } from '../store/uiStore'
import { useResultsStore } from '../store/resultsStore'

const ACCEPT = '.zip,.shp,.dbf,.prj,.cpg,.shx,.csv,.txt,.geojson,.json'
const CLASS_ORDER = Object.keys(CLASSES) as Exclude<ElementClass, 'ignore'>[]

/** Tolerances that mean about a metre and about thirty, in the layers' units. */
function defaultTolerances(crs: string | undefined): { snap: number; attach: number; unit: string } {
  const u = crsUnits(crs)
  if (u === 'deg') return { snap: 0.00001, attach: 0.0003, unit: 'degrees' }
  if (u === 'ft') return { snap: 3, attach: 100, unit: 'ft' }
  return { snap: 1, attach: 30, unit: crs ? 'm' : 'layer units' }
}

/** A mapping remembered per layer name and column set, so the next export
 *  of the same GIS layer imports without the clicking. */
const memoryKey = (l: Layer) => `gisMap:${l.name}:${l.fields.join('|')}`

function initialPlan(l: Layer): LayerPlan {
  try {
    const saved = JSON.parse(readPref(memoryKey(l)) ?? 'null')
    if (saved?.cls) return { layer: l, cls: saved.cls, columns: saved.columns ?? {}, values: saved.values ?? {} }
  } catch {
    // a garbled memory is no memory
  }
  const cls = guessClass(l.name, l.kind)
  return { layer: l, cls, columns: cls === 'ignore' ? {} : autoMap(CLASSES[cls].props, l.fields), values: {} }
}

/** File → Import from → GIS layers or CSV tables: each layer or table is
 *  assigned an element class and its columns mapped to that class's
 *  properties; the result is built as an OpenDSS model (lib/gis/build.ts)
 *  and imported like a .dss file. */
export function GisImportDialog({ onClose }: { onClose: () => void }) {
  const [plans, setPlans] = useState<LayerPlan[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [name, setName] = useState('gis-feeder')
  const [snap, setSnap] = useState('')
  const [attach, setAttach] = useState('')
  const [sourceBus, setSourceBus] = useState('')
  const [sourceKv, setSourceKv] = useState('12.47')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  const crs = plans.find((p) => p.cls !== 'ignore' && p.layer.crs)?.layer.crs
  const tol = defaultTolerances(crs)
  const crsSet = new Set(plans.filter((p) => p.cls !== 'ignore' && p.layer.crs).map((p) => p.layer.crs))
  const hasSource = plans.some((p) => p.cls === 'source')

  const choose = async () => {
    const files = await pickFiles(ACCEPT, true)
    if (!files.length) return
    const read = await readLayers(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))))
    setPlans((prev) => [...prev, ...read.layers.map(initialPlan)])
    setErrors(read.errors)
    if (read.layers.length) setOpen(read.layers[0].name)
  }

  const update = (i: number, patch: Partial<LayerPlan>) =>
    setPlans((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const setClass = (i: number, cls: ElementClass) =>
    update(i, { cls, columns: cls === 'ignore' ? {} : autoMap(CLASSES[cls].props, plans[i].layer.fields), values: {} })

  const run = async () => {
    setBusy(true)
    try {
      const built = buildModel(plans, {
        circuitName: name,
        snap: Number(snap) || tol.snap,
        attach: Number(attach) || tol.attach,
        sourceBus,
        sourceKv: Number(sourceKv) || 12.47,
      })
      for (const p of plans) writePref(memoryKey(p.layer), JSON.stringify({ cls: p.cls, columns: p.columns, values: p.values }))
      const result = await api.importDss(built.files)
      // The routes go back onto the lines they belong to, and the layers'
      // coordinate system onto the circuit.
      for (const e of result.circuit.edges) {
        const route = built.routes.get(String(e.params?.name ?? '').toLowerCase())
        if (route) e.geometry = route.map(([x, y]) => ({ x, y }))
      }
      if (crs && crsSet.size === 1) result.circuit.crs = crs
      result.warnings = [
        ...built.notes,
        ...(crsSet.size > 1 ? ['The layers are in different coordinate systems; reproject them to one before importing.'] : []),
        ...built.skipped.slice(0, 5),
        ...(result.warnings ?? []),
      ]
      loadImported(result)
      onClose()
    } catch (err) {
      const msg = err instanceof BuildError || err instanceof Error ? err.message : String(err)
      useResultsStore.getState().setFlash(`GIS import failed: ${msg}`, 'error', 10000)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box wide gis-dialog"
        role="dialog"
        aria-label="Import GIS layers or CSV tables"
        tabIndex={-1}
        ref={box}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-title">Import GIS layers or CSV tables</div>
        <div className="library-note">
          Shapefiles (loose or zipped), GeoJSON and CSV. Say what each layer is and which columns hold what; without
          bus columns, lines are joined where their ends meet and devices attach to the nearest bus.
        </div>
        <div className="gis-files">
          <button type="button" onClick={() => void choose()}>
            {plans.length ? 'Add files…' : 'Choose files…'}
          </button>
          {errors.map((e) => (
            <div key={e} className="modal-error">
              {e}
            </div>
          ))}
        </div>
        {plans.map((p, i) => {
          const props = p.cls === 'ignore' ? [] : CLASSES[p.cls].props
          return (
            <fieldset key={`${p.layer.name}-${i}`} className="prefs-group gis-layer">
              <legend>
                <button type="button" className="gis-toggle" onClick={() => setOpen(open === p.layer.name ? null : p.layer.name)}>
                  {open === p.layer.name ? '▾' : '▸'} {p.layer.name}
                </button>
                <span className="gis-meta">
                  {p.layer.features.length} {p.layer.kind === 'table' ? 'row' : p.layer.kind === 'line' ? 'line' : 'point'}
                  {p.layer.features.length === 1 ? '' : 's'}
                </span>
              </legend>
              <label>
                This layer is
                <select aria-label={`${p.layer.name} class`} value={p.cls} onChange={(e) => setClass(i, e.target.value as ElementClass)}>
                  {CLASS_ORDER.map((c) => (
                    <option key={c} value={c}>
                      {CLASSES[c].label}
                    </option>
                  ))}
                  <option value="ignore">Not imported</option>
                </select>
              </label>
              {p.layer.notes.map((n) => (
                <div key={n} className="library-note">
                  {n}
                </div>
              ))}
              {open === p.layer.name && p.cls !== 'ignore' && (
                <table className="gis-map">
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>Column</th>
                      <th>or value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.map((prop) => (
                      <tr key={prop.key}>
                        <td>
                          {prop.label}
                          {prop.unit ? ` (${prop.unit})` : ''}
                        </td>
                        <td>
                          <select
                            aria-label={`${p.layer.name} ${prop.label} column`}
                            value={p.columns[prop.key] ?? ''}
                            onChange={(e) => {
                              const columns = { ...p.columns }
                              if (e.target.value) columns[prop.key] = e.target.value
                              else delete columns[prop.key]
                              update(i, { columns })
                            }}
                          >
                            <option value="">—</option>
                            {p.layer.fields.map((f) => (
                              <option key={f} value={f}>
                                {f}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            aria-label={`${p.layer.name} ${prop.label} value`}
                            value={p.values[prop.key] ?? ''}
                            placeholder={prop.fallback != null ? String(prop.fallback) : ''}
                            disabled={!!p.columns[prop.key]}
                            onChange={(e) => update(i, { values: { ...p.values, [prop.key]: e.target.value } })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </fieldset>
          )
        })}
        {plans.length > 0 && (
          <fieldset className="prefs-group">
            <legend>Circuit</legend>
            <div className="project-grid">
              <label>
                Name
                <input aria-label="Circuit name" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Snap line ends within ({tol.unit})
                <input aria-label="Snap tolerance" type="number" value={snap} placeholder={String(tol.snap)} onChange={(e) => setSnap(e.target.value)} />
              </label>
              <label>
                Attach devices within ({tol.unit})
                <input aria-label="Attach radius" type="number" value={attach} placeholder={String(tol.attach)} onChange={(e) => setAttach(e.target.value)} />
              </label>
              {!hasSource && (
                <>
                  <label>
                    Source bus
                    <input aria-label="Source bus" value={sourceBus} placeholder="a bus name from the tables" onChange={(e) => setSourceBus(e.target.value)} />
                  </label>
                  <label>
                    Source kV
                    <input aria-label="Source kV" type="number" value={sourceKv} onChange={(e) => setSourceKv(e.target.value)} />
                  </label>
                </>
              )}
            </div>
            <div className="library-note">
              {crs
                ? crsSet.size > 1
                  ? 'The layers are in different coordinate systems.'
                  : 'The layers carry their coordinate system; the map will use it.'
                : 'No coordinate system came with the layers; set one in Project properties to see them on a map.'}
              {!hasSource && ' No layer is the Source: name the bus it feeds.'}
            </div>
          </fieldset>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="modal-primary" disabled={!plans.some((p) => p.cls !== 'ignore') || busy} onClick={() => void run()}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
