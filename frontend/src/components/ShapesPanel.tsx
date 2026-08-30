import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type GeocodeHit, type NrelMeta } from '../lib/api'
import { loadNlrCreds, maskKey, saveNlrCreds, type NlrCreds } from '../lib/nlrCreds'
import {
  decimate,
  normalizeAverage,
  normalizePeak,
  parseShapeText,
  round5,
  shapeStats,
} from '../lib/shapeCsv'
import { beginGesture, endGesture, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { LoadShapeJSON } from '../types/circuit'

/** Largest shape that still gets draggable point handles. */
const EDITABLE_MAX_PTS = 96
const PREVIEW_W = 560
const PREVIEW_H = 150
const PAD = { l: 34, r: 8, t: 8, b: 18 }

function uniqueShapeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}${i}`)) i++
  return `${base}${i}`
}

const typeLabel = (t: string) => t.replace(/_/g, ' ')

/** Picker for NREL End-Use Load Profiles (climate zone × building type),
 *  fetched through the backend proxy (cached on disk server-side). */
function NrelImport({
  onImport,
}: {
  onImport: (name: string, spec: LoadShapeJSON, statsLine: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [meta, setMeta] = useState<NrelMeta | null>(null)
  const [product, setProduct] = useState<'resstock' | 'comstock'>('resstock')
  const [zone, setZone] = useState('3a')
  const [btype, setBtype] = useState('single-family_detached')
  const [step15, setStep15] = useState(false)
  const [normalize, setNormalize] = useState<'peak' | 'average'>('peak')
  const [busy, setBusy] = useState(false)
  const flash = (msg: string, kind: 'error' | 'info' = 'error') =>
    useResultsStore.getState().setFlash(msg, kind)

  useEffect(() => {
    if (!open || meta) return
    api
      .nrelMeta()
      .then(setMeta)
      .catch((e) => flash(`Could not load the NREL catalog: ${e.message}`))
  }, [open, meta])

  const prod = meta?.products[product]
  const pickProduct = (p: 'resstock' | 'comstock') => {
    setProduct(p)
    const m = meta?.products[p]
    if (m) {
      if (!m.zones.includes(zone)) setZone(m.zones[0])
      setBtype(m.buildingTypes[0])
    }
  }
  const run = async () => {
    setBusy(true)
    try {
      const r = await api.nrelFetch({
        product,
        climateZone: zone,
        buildingType: btype,
        stepMin: step15 ? 15 : 60,
        normalize,
      })
      onImport(
        r.name,
        { intervalMin: r.intervalMin, points: r.points, source: r.source },
        `${r.points.length} pts (full year). Source aggregate: ` +
          `${(r.stats.annualKwh / 1e6).toFixed(0)} GWh/yr, peak ${(r.stats.peakKw / 1e3).toFixed(0)} MW.`,
      )
    } catch (e) {
      flash(`NREL fetch failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nrel-import">
      <button className="nrel-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Import from NREL…
      </button>
      {open && (
        <div className="nrel-form">
          <div className="nrel-note">
            End-Use Load Profiles for the U.S. Building Stock (2018 weather year,
            15-min aggregates). First fetch downloads ~10–30 MB, then it's cached.
          </div>
          <label>
            Sector{' '}
            <select value={product} onChange={(e) => pickProduct(e.target.value as 'resstock' | 'comstock')}>
              <option value="resstock">Residential</option>
              <option value="comstock">Commercial</option>
            </select>
          </label>
          <label>
            Climate zone{' '}
            <select value={zone} onChange={(e) => setZone(e.target.value)} disabled={!prod}>
              {(prod?.zones ?? [zone]).map((z) => (
                <option key={z} value={z}>
                  {z.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label>
            Building type{' '}
            <select value={btype} onChange={(e) => setBtype(e.target.value)} disabled={!prod}>
              {(prod?.buildingTypes ?? [btype]).map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Normalize{' '}
            <select value={normalize} onChange={(e) => setNormalize(e.target.value as 'peak' | 'average')}>
              <option value="peak">peak = 1.0 (kW sets the peak)</option>
              <option value="average">average = 1.0 (kW sets the average)</option>
            </select>
          </label>
          <label className="nrel-check">
            <input type="checkbox" checked={step15} onChange={(e) => setStep15(e.target.checked)} />{' '}
            Keep 15-minute resolution (35k points)
          </label>
          <button onClick={run} disabled={busy || !prod}>
            {busy ? 'Fetching…' : 'Fetch profile'}
          </button>
        </div>
      )}
    </div>
  )
}

/** First-run prompt for the user's free NLR API key + contact email.
 *  Saved to localStorage so it never has to be entered again. */
function NlrKeyPrompt({
  initial,
  error,
  onSave,
  onCancel,
}: {
  initial: NlrCreds | null
  error: string | null
  onSave: (creds: NlrCreds) => void
  onCancel: () => void
}) {
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [email, setEmail] = useState(initial?.email ?? '')
  const canSave = apiKey.trim().length > 0 && /.+@.+\..+/.test(email.trim())
  const save = () => canSave && onSave({ apiKey: apiKey.trim(), email: email.trim() })
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-box"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter') save()
        }}
      >
        <div className="modal-title">NLR Developer Network API key</div>
        <div className="nrel-note">
          Fetching NSRDB irradiance data needs a free API key from the NLR
          Developer Network. Sign up at{' '}
          <a href="https://developer.nlr.gov/signup/" target="_blank" rel="noreferrer">
            developer.nlr.gov/signup
          </a>{' '}
          (takes a minute), then paste the key here. The email is required by
          the NLR API to identify requests; both are remembered in this
          browser only.
        </div>
        {error && <div className="modal-error">{error}</div>}
        <label>
          API key{' '}
          <input
            autoFocus
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="e.g. gk9pW…"
          />
        </label>
        <label>
          Email{' '}
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="modal-primary" onClick={save} disabled={!canSave}>
            Save key
          </button>
        </div>
      </div>
    </div>
  )
}

/** Fetcher for regional irradiance: NLR NSRDB hourly GHI, weather year 2018
 *  (matching the EULP load shapes). Prompts for the user's free NLR API key
 *  on first use and remembers it in localStorage. */
function NsrdbImport({
  onImport,
}: {
  onImport: (name: string, spec: LoadShapeJSON, statsLine: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState('')
  const [hits, setHits] = useState<GeocodeHit[] | null>(null)
  const [picked, setPicked] = useState<GeocodeHit | null>(null)
  const [lat, setLat] = useState('39.74')
  const [lon, setLon] = useState('-104.99')
  const [creds, setCreds] = useState<NlrCreds | null>(loadNlrCreds)
  // thenFetch: the prompt interrupted a fetch, which resumes on save.
  const [prompt, setPrompt] = useState<{ error: string | null; thenFetch: boolean } | null>(null)
  const [scaling, setScaling] = useState<'kwm2' | 'peak'>('kwm2')
  const [busy, setBusy] = useState<'search' | 'fetch' | null>(null)
  const flash = (msg: string, kind: 'error' | 'info' = 'error') =>
    useResultsStore.getState().setFlash(msg, kind)

  const search = async () => {
    if (!place.trim()) return
    setBusy('search')
    try {
      const results = await api.irradianceGeocode(place.trim())
      setHits(results)
      if (results.length) pick(results[0])
      else flash(`No places found for '${place.trim()}'.`)
    } catch (e) {
      flash(`Place search failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }
  const pick = (h: GeocodeHit) => {
    setPicked(h)
    setLat(String(h.lat))
    setLon(String(h.lon))
  }
  const run = async (useCreds: NlrCreds | null = creds) => {
    const latN = Number(lat)
    const lonN = Number(lon)
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) {
      flash('Enter a valid latitude and longitude (or search for a place).')
      return
    }
    if (!useCreds) {
      // First use: ask for the key, then the fetch continues automatically.
      setPrompt({ error: null, thenFetch: true })
      return
    }
    setBusy('fetch')
    try {
      const r = await api.irradianceFetch({
        lat: latN,
        lon: lonN,
        apiKey: useCreds.apiKey,
        email: useCreds.email,
        scaling,
        label: picked?.name,
      })
      onImport(
        r.name,
        { kind: 'irradiance', intervalMin: r.intervalMin, points: r.points, source: r.source },
        `8760 h of 2018 GHI near ${r.stats.resolvedLat.toFixed(2)}, ${r.stats.resolvedLon.toFixed(2)} — ` +
          `peak ${r.stats.peakWm2} W/m², ${r.stats.annualKwhM2} kWh/m²/yr.` +
          (scaling === 'peak' ? ` Set the PV irradiance parameter to ${(r.stats.peakWm2 / 1000).toFixed(2)}.` : ''),
      )
    } catch (e) {
      const msg = (e as Error).message
      if (/api key|email/i.test(msg)) {
        // Rejected credentials: reopen the prompt with the server's reason.
        setPrompt({ error: msg, thenFetch: true })
      } else {
        flash(`NSRDB fetch failed: ${msg}`, 'error')
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="nrel-import">
      <button className="nrel-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Fetch NSRDB irradiance…
      </button>
      {open && (
        <div className="nrel-form">
          <div className="nrel-note">
            Hourly GHI for weather year 2018 (matches the NREL/NLR building
            load shapes) from the NLR National Solar Radiation Database.
            Needs a free API key from developer.nlr.gov/signup.
          </div>
          <label>
            Place{' '}
            <span className="nsrdb-search">
              <input
                placeholder="e.g. Denver"
                value={place}
                onChange={(e) => setPlace(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void search()}
              />
              <button onClick={() => void search()} disabled={busy === 'search' || !place.trim()}>
                {busy === 'search' ? '…' : 'Search'}
              </button>
            </span>
          </label>
          {hits && hits.length > 0 && (
            <select
              value={picked ? `${picked.lat},${picked.lon}` : ''}
              onChange={(e) => {
                const h = hits.find((x) => `${x.lat},${x.lon}` === e.target.value)
                if (h) pick(h)
              }}
            >
              {hits.map((h) => (
                <option key={`${h.lat},${h.lon}`} value={`${h.lat},${h.lon}`}>
                  {h.name} ({h.region})
                </option>
              ))}
            </select>
          )}
          <label>
            Lat / Lon{' '}
            <span className="nsrdb-latlon">
              <input value={lat} onChange={(e) => setLat(e.target.value)} />
              <input value={lon} onChange={(e) => setLon(e.target.value)} />
            </span>
          </label>
          <label>
            Scaling{' '}
            <select value={scaling} onChange={(e) => setScaling(e.target.value as 'kwm2' | 'peak')}>
              <option value="kwm2">kW/m² (÷1000 — keep PV irradiance = 1.0)</option>
              <option value="peak">peak = 1.0 (set PV irradiance to site peak)</option>
            </select>
          </label>
          <button onClick={() => void run()} disabled={busy === 'fetch'}>
            {busy === 'fetch' ? 'Fetching…' : 'Fetch irradiance'}
          </button>
          <div className="nsrdb-cred-line">
            {creds ? (
              <>
                NLR key {maskKey(creds.apiKey)} · {creds.email}{' '}
                <button className="nrel-toggle" onClick={() => setPrompt({ error: null, thenFetch: false })}>
                  change
                </button>
              </>
            ) : (
              "You'll be asked for your free NLR API key on the first fetch."
            )}
          </div>
        </div>
      )}
      {prompt && (
        <NlrKeyPrompt
          initial={creds}
          error={prompt.error}
          onCancel={() => setPrompt(null)}
          onSave={(c) => {
            saveNlrCreds(c)
            setCreds(c)
            const resume = prompt.thenFetch
            setPrompt(null)
            if (resume) void run(c) // continue the fetch the prompt interrupted
          }}
        />
      )}
    </div>
  )
}

/** Inline SVG preview; draggable point handles for small shapes. */
function ShapeChart({
  name,
  shape,
  editable,
}: {
  name: string
  shape: LoadShapeJSON
  editable: boolean
}) {
  const setLoadShape = useCircuitStore((s) => s.setLoadShape)
  const svgRef = useRef<SVGSVGElement>(null)
  const pts = shape.points
  const { min, max } = shapeStats(pts)
  const yLo = Math.min(0, min)
  const yHi = Math.max(max, yLo + 1e-6)
  const plotW = PREVIEW_W - PAD.l - PAD.r
  const plotH = PREVIEW_H - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (pts.length > 1 ? (i / (pts.length - 1)) * plotW : plotW / 2)
  const y = (v: number) => PAD.t + (1 - (v - yLo) / (yHi - yLo)) * plotH
  const yFromPx = (py: number) => yLo + (1 - (py - PAD.t) / plotH) * (yHi - yLo)

  const line = useMemo(() => {
    const raw = pts.map((v, i) => ({ x: x(i), y: y(v) }))
    return decimate(raw, 2 * plotW)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, yLo, yHi])

  const dragPoint = (idx: number) => (down: React.PointerEvent) => {
    if (!editable) return
    down.preventDefault()
    beginGesture()
    const svg = svgRef.current!
    const toLocalY = (e: PointerEvent | React.PointerEvent) => {
      const r = svg.getBoundingClientRect()
      return ((e.clientY - r.top) / r.height) * PREVIEW_H
    }
    const move = (e: PointerEvent) => {
      const v = round5(Math.max(yLo, Math.min(yHi, yFromPx(toLocalY(e)))))
      const cur = useCircuitStore.getState().loadShapes[name]
      if (!cur) return
      const points = cur.points.map((p, i) => (i === idx ? v : p))
      setLoadShape(name, { ...cur, points })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const ticks = [yLo, (yLo + yHi) / 2, yHi]
  return (
    <svg
      ref={svgRef}
      className="shape-chart"
      viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
      style={{ width: '100%', maxWidth: PREVIEW_W }}
    >
      <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} className="shape-paper" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} y1={y(t)} x2={PAD.l + plotW} y2={y(t)} className="shape-grid" />
          <text x={PAD.l - 4} y={y(t) + 3} textAnchor="end" className="shape-tick">
            {round5(t)}
          </text>
        </g>
      ))}
      {yLo < 0 && (
        <line x1={PAD.l} y1={y(0)} x2={PAD.l + plotW} y2={y(0)} className="shape-zero" />
      )}
      <polyline points={line} className="shape-line" fill="none" />
      {editable &&
        pts.map((v, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(v)}
            r={4}
            className="shape-pt"
            onPointerDown={dragPoint(i)}
          >
            <title>{`[${i}] ${v}`}</title>
          </circle>
        ))}
      <text x={PAD.l + plotW / 2} y={PREVIEW_H - 4} textAnchor="middle" className="shape-tick">
        {pts.length} pts × {shape.intervalMin} min ={' '}
        {round5((pts.length * shape.intervalMin) / 60)} h
      </text>
    </svg>
  )
}

export function ShapesPanel() {
  const loadShapes = useCircuitStore((s) => s.loadShapes)
  const setLoadShape = useCircuitStore((s) => s.setLoadShape)
  const deleteLoadShape = useCircuitStore((s) => s.deleteLoadShape)
  const renameLoadShape = useCircuitStore((s) => s.renameLoadShape)
  const flash = (msg: string, kind: 'error' | 'info' = 'error', durationMs?: number) =>
    useResultsStore.getState().setFlash(msg, kind, durationMs)

  const [kindTab, setKindTab] = useState<'load' | 'irradiance'>('load')
  const allNames = Object.keys(loadShapes)
  const names = allNames.filter((n) => (loadShapes[n].kind ?? 'load') === kindTab)
  const [selected, setSelected] = useState<string | null>(names[0] ?? null)
  const active = selected != null && names.includes(selected) ? selected : (names[0] ?? null)
  const shape = active ? loadShapes[active] : null

  const [csv, setCsv] = useState('')
  const [renameDraft, setRenameDraft] = useState(active ?? '')
  useEffect(() => setRenameDraft(active ?? ''), [active])

  const onNew = () => {
    const name = uniqueShapeName(kindTab === 'irradiance' ? 'irr1' : 'shape1', new Set(allNames))
    // A flat unit day: something visible to drag into shape.
    setLoadShape(name, { kind: kindTab, intervalMin: 60, points: Array(24).fill(1), source: 'csv' })
    setSelected(name)
  }
  const onDuplicate = () => {
    if (!active || !shape) return
    const name = uniqueShapeName(active, new Set(allNames))
    setLoadShape(name, { ...shape, points: [...shape.points] })
    setSelected(name)
  }
  const onDelete = () => {
    if (!active) return
    deleteLoadShape(active)
    setSelected(null)
  }
  const commitRename = () => {
    if (!active || !renameDraft || renameDraft === active) return
    if (loadShapes[renameDraft]) {
      flash(`A loadshape named '${renameDraft}' already exists.`)
      setRenameDraft(active)
      return
    }
    renameLoadShape(active, renameDraft)
    setSelected(renameDraft)
  }
  const applyCsv = () => {
    if (!active || !shape) return
    const { points, error } = parseShapeText(csv)
    if (error) {
      flash(error)
      return
    }
    setLoadShape(active, { ...shape, points: points.map(round5), source: 'csv' })
    flash(`Loaded ${points.length} points into '${active}'.`, 'info')
  }
  const applyNormalize = (fn: (p: number[]) => number[]) => {
    if (!active || !shape) return
    setLoadShape(active, { ...shape, points: fn(shape.points) })
  }

  const stats = shape ? shapeStats(shape.points) : null
  return (
    <div className="shapes-panel">
      <div className="shapes-list">
        <div className="shapes-kind-tabs">
          <button
            className={`bp-subtab${kindTab === 'load' ? ' active' : ''}`}
            onClick={() => setKindTab('load')}
          >
            Load shapes
          </button>
          <button
            className={`bp-subtab${kindTab === 'irradiance' ? ' active' : ''}`}
            onClick={() => setKindTab('irradiance')}
          >
            Irradiance
          </button>
        </div>
        <div className="shapes-actions">
          <button onClick={onNew}>New</button>
          <button onClick={onDuplicate} disabled={!active}>
            Duplicate
          </button>
          <button onClick={onDelete} disabled={!active}>
            Delete
          </button>
        </div>
        {names.length === 0 && (
          <div className="shapes-empty">
            {kindTab === 'load'
              ? 'No load shapes yet. Create one, paste CSV values, or import an ' +
                'NREL building profile — then assign it to loads (or storage ' +
                'dispatch) in their properties.'
              : 'No irradiance shapes yet. Create one, paste CSV values, or ' +
                'fetch regional NSRDB data — then assign it to PV systems as ' +
                'their irradiance shape.'}
          </div>
        )}
        {names.map((n) => (
          <button
            key={n}
            className={`shapes-item${n === active ? ' active' : ''}`}
            onClick={() => setSelected(n)}
          >
            <span className="shapes-item-name">{n}</span>
            <span className="shapes-item-info">{loadShapes[n].points.length}</span>
          </button>
        ))}
        {kindTab === 'load' ? (
          <NrelImport
            onImport={(name, spec, statsLine) => {
              const finalName = uniqueShapeName(name, new Set(Object.keys(useCircuitStore.getState().loadShapes)))
              setLoadShape(finalName, { ...spec, kind: 'load' })
              setSelected(finalName)
              flash(`Imported '${finalName}': ${statsLine}`, 'info', 8000)
            }}
          />
        ) : (
          <NsrdbImport
            onImport={(name, spec, statsLine) => {
              const finalName = uniqueShapeName(name, new Set(Object.keys(useCircuitStore.getState().loadShapes)))
              setLoadShape(finalName, spec)
              setSelected(finalName)
              flash(`Imported '${finalName}': ${statsLine}`, 'info', 8000)
            }}
          />
        )}
      </div>
      {shape && active ? (
        <div className="shapes-editor">
          <div className="shapes-row">
            <label>
              Name{' '}
              <input
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
            </label>
            <label>
              Interval{' '}
              <select
                value={String(shape.intervalMin)}
                onChange={(e) => setLoadShape(active, { ...shape, intervalMin: Number(e.target.value) })}
              >
                <option value="60">60 min</option>
                <option value="15">15 min</option>
              </select>
            </label>
            <button onClick={() => applyNormalize(normalizePeak)}>Normalize peak=1</button>
            <button onClick={() => applyNormalize(normalizeAverage)}>Normalize avg=1</button>
            {stats && (
              <span className="shapes-stats">
                min {round5(stats.min)} · max {round5(stats.max)} · avg {round5(stats.avg)}
              </span>
            )}
          </div>
          <ShapeChart name={active} shape={shape} editable={shape.points.length <= EDITABLE_MAX_PTS} />
          {shape.points.length > EDITABLE_MAX_PTS && (
            <div className="shapes-hint">
              Preview only — shapes over {EDITABLE_MAX_PTS} points are edited via CSV.
              {/^(nrel|nsrdb):/.test(shape.source ?? '') ? ` Source: ${shape.source}` : ''}
            </div>
          )}
          <div className="shapes-csv">
            <textarea
              placeholder={'Paste multiplier values — one per line, comma-separated,\nor time,value rows (the time column is dropped).'}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={4}
              spellCheck={false}
            />
            <button onClick={applyCsv} disabled={!csv.trim()}>
              Load CSV into '{active}'
            </button>
          </div>
        </div>
      ) : (
        <div className="shapes-editor shapes-empty">Select or create a loadshape.</div>
      )}
    </div>
  )
}
