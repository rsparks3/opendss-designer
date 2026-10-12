import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  lonLatToWorld,
  looksLikeLonLat,
  OSM_ATTRIBUTION,
  OSM_TILES,
  projectionFor,
  TILE,
  tileUrl,
  worldToLonLat,
  type Projection,
} from '../lib/geo'
import { placeOnMap, type MapPoint } from '../lib/geoPlacement'
import { byId as indexById } from '../lib/indexes'
import { overlayInk } from '../lib/overlayInk'
import { redo, undo, useCircuitStore, useLimits, type AppNode } from '../store/circuitStore'
import { activeResult, activeStale, useResultsStore } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import type { GeoPoint } from '../types/circuit'
import { ResultTooltip, type HoverTarget } from './ResultTooltip'

/** The view: world point at the centre of the canvas, and pixels per world
 *  unit. On a map the world is Web Mercator pixels at zoom 0, so `k` is
 *  2^zoom; on a plain grid it is the circuit's own units. */
interface View {
  cx: number
  cy: number
  k: number
}

type Hit = { kind: 'node' | 'edge'; id: string } | null

const ICON = 7
const FAN_RADIUS = 18
const MAX_TILES = 160

/** The circuit on a map: buses at their coordinates, lines along their
 *  routes, devices where they connect, coloured by the overlay that is on.
 *  Select to edit in the properties panel; drag a selected bus that has a
 *  coordinate to move it. Placing and wiring new elements is the
 *  schematic's job. */
export function GeoCanvas() {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const crs = useCircuitStore((s) => s.crs)
  const overlay = useResultsStore((s) => s.overlay)
  const result = useResultsStore(activeResult)
  const stale = useResultsStore(activeStale)
  const phases = useResultsStore((s) => s.phases)
  const limits = useLimits()
  const basemap = useUiStore((s) => s.basemap)
  const basemapUrl = useUiStore((s) => s.basemapUrl)
  const setBasemap = useUiStore((s) => s.setBasemap)

  const [projection, setProjection] = useState<Projection | null | undefined>(undefined)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<HoverTarget | null>(null)
  const [drag, setDrag] = useState<{ id: string; world: MapPoint } | null>(null)
  const view = useRef<View>({ cx: 0, cy: 0, k: 1 })
  const [frame, redraw] = useState(0)
  const tiles = useRef(new Map<string, HTMLImageElement>())

  useEffect(() => {
    let live = true
    setProjection(undefined)
    void projectionFor(crs).then((p) => live && setProjection(p))
    return () => {
      live = false
    }
  }, [crs])

  // Circuit coordinates to world and back: through longitude/latitude to
  // Web Mercator on a map; y flipped (north up) on a plain grid.
  const mapped = !!projection
  const project = useCallback(
    (p: GeoPoint): MapPoint | null => {
      if (projection) {
        const [lon, lat] = projection.toLonLat(p.x, p.y)
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
        const [x, y] = lonLatToWorld(lon, lat)
        return { x, y }
      }
      return { x: p.x, y: -p.y }
    },
    [projection],
  )
  const unproject = useCallback(
    (w: MapPoint): GeoPoint => {
      if (projection) {
        const [x, y] = projection.fromLonLat(...worldToLonLat(w.x, w.y))
        return { x, y }
      }
      return { x: w.x, y: -w.y }
    },
    [projection],
  )

  const placement = useMemo(
    () => (projection === undefined ? null : placeOnMap(nodes, edges, project)),
    [nodes, edges, project, projection],
  )
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  // Where something is drawn on screen: its world position through the
  // view, a bus being dragged where the pointer is, and a device hanging
  // from a bus fanned out below it at a fixed distance in pixels.
  const fanned = useMemo(() => {
    const out = new Map<string, { bus: string; dx: number; dy: number }>()
    for (const [bus, ids] of placement?.hanging ?? []) {
      ids.forEach((id, i) => {
        const a = Math.PI / 2 + (i - (ids.length - 1) / 2) * (Math.PI / 7)
        out.set(id, { bus, dx: Math.cos(a) * FAN_RADIUS, dy: Math.sin(a) * FAN_RADIUS })
      })
    }
    return out
  }, [placement])

  const toScreen = useCallback(
    (p: MapPoint) => {
      const v = view.current
      return { x: (p.x - v.cx) * v.k + size.w / 2, y: (p.y - v.cy) * v.k + size.h / 2 }
    },
    [size],
  )
  const toWorld = useCallback(
    (x: number, y: number): MapPoint => {
      const v = view.current
      return { x: (x - size.w / 2) / v.k + v.cx, y: (y - size.h / 2) / v.k + v.cy }
    },
    [size],
  )
  const worldOf = useCallback(
    (id: string): MapPoint | undefined => (drag?.id === id ? drag.world : placement?.pos.get(id)),
    [drag, placement],
  )
  const screenOf = useCallback(
    (id: string): { x: number; y: number } | null => {
      const fan = fanned.get(id)
      if (fan) {
        const b = worldOf(fan.bus)
        if (!b) return null
        const s = toScreen(b)
        return { x: s.x + fan.dx, y: s.y + fan.dy }
      }
      const w = worldOf(id)
      return w ? toScreen(w) : null
    },
    [fanned, worldOf, toScreen],
  )

  const fit = useCallback(() => {
    if (!placement?.pos.size || !size.w) return
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of placement.pos.values()) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
    const w = Math.max(x1 - x0, 1e-9)
    const h = Math.max(y1 - y0, 1e-9)
    let k = Math.min((size.w * 0.9) / w, (size.h * 0.9) / h)
    if (mapped) k = Math.min(k, 2 ** 19)
    view.current = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k }
    redraw((f) => f + 1)
  }, [placement, size, mapped])

  // Fit when the map first has something to show, and when the coordinate
  // system changes what "here" means.
  const fittedFor = useRef<string | null>(null)
  useEffect(() => {
    const key = `${projection?.label ?? 'grid'}|${placement?.placed ?? 0}>0`
    if (placement?.placed && size.w && fittedFor.current !== key) {
      fittedFor.current = key
      fit()
    }
  }, [placement, projection, size, fit])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // --- drawing ------------------------------------------------------------
  const tileTemplate = basemap === 'osm' ? OSM_TILES : basemap === 'custom' ? basemapUrl.trim() : ''
  useEffect(() => {
    const el = canvas.current
    if (!el || !placement || !size.w) return
    const dpr = window.devicePixelRatio || 1
    el.width = Math.round(size.w * dpr)
    el.height = Math.round(size.h * dpr)
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    const style = getComputedStyle(el)
    const ink = style.getPropertyValue('--ink').trim() || '#333'
    const accent = style.getPropertyValue('--accent').trim() || '#1976d2'
    const v = view.current

    if (mapped && tileTemplate) drawTiles(ctx, v, size, tileTemplate, tiles.current, () => redraw((f) => f + 1))

    const colours = overlayInk({ overlay, result, stale, phases, limits, ink })
    const selectedEdges = new Set(edges.filter((e) => e.selected).map((e) => e.id))
    const edgeById = indexById(edges)
    const off = (id: string) => byId.get(id)?.data.params.enabled === false

    // Wires (device to bus): thin and grey; usually a few metres long.
    ctx.lineWidth = 1
    ctx.strokeStyle = style.getPropertyValue('--muted').trim() || '#999'
    ctx.beginPath()
    for (const w of placement.wires) {
      const a = screenOf(w.source) ?? toScreen(w.a)
      const b = toScreen(w.b)
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    }
    ctx.stroke()
    // Hanging devices are fanned out on screen: draw their stubs.
    ctx.beginPath()
    for (const [id, fan] of fanned) {
      const b = worldOf(fan.bus)
      if (!b) continue
      const s = toScreen(b)
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.x + fan.dx, s.y + fan.dy)
      void id
    }
    ctx.stroke()

    // Lines, along their routes, by overlay colour.
    for (const l of placement.lines) {
      const e = edgeById.get(l.id)
      const source = e?.source ?? ''
      ctx.strokeStyle = selectedEdges.has(l.id) ? accent : colours.line(l.id, source)
      ctx.lineWidth = selectedEdges.has(l.id) ? 4 : 2
      ctx.globalAlpha = e?.data?.params.enabled === false ? 0.4 : 1
      ctx.setLineDash(e?.data?.params.enabled === false ? [4, 4] : [])
      ctx.beginPath()
      l.pts.forEach((p, i) => {
        const w = i === 0 ? (worldOf(source) ?? p) : i === l.pts.length - 1 ? (worldOf(e?.target ?? '') ?? p) : p
        const s = toScreen(w)
        if (i === 0) ctx.moveTo(s.x, s.y)
        else ctx.lineTo(s.x, s.y)
      })
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // Elements: an icon each, its name once the view is close enough.
    const onScreen: { n: AppNode; s: { x: number; y: number } }[] = []
    for (const n of nodes) {
      const s = screenOf(n.id)
      if (!s || s.x < -20 || s.y < -20 || s.x > size.w + 20 || s.y > size.h + 20) continue
      onScreen.push({ n, s })
    }
    for (const { n, s } of onScreen) {
      ctx.globalAlpha = off(n.id) ? 0.4 : 1
      drawIcon(ctx, n, s.x, s.y, n.type === 'busbar' ? colours.bus(n.id) : ink)
      if (n.selected) {
        ctx.strokeStyle = accent
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(s.x, s.y, ICON + 3, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
    if (onScreen.length < 250) {
      ctx.font = '11px system-ui, sans-serif'
      ctx.fillStyle = ink
      for (const { n, s } of onScreen) {
        const name = String(n.data.params.name ?? '')
        if (name) ctx.fillText(name, s.x + ICON + 3, s.y - ICON)
      }
    }
    // `frame` is in the dependencies so a pan or a loaded tile redraws.
  }, [frame, placement, size, nodes, edges, byId, overlay, result, stale, phases, limits, mapped,
    tileTemplate, fanned, screenOf, toScreen, worldOf])

  // --- interaction --------------------------------------------------------
  const hitTest = useCallback(
    (x: number, y: number): Hit => {
      if (!placement) return null
      let best: Hit = null
      let bestD = 10
      for (const n of nodes) {
        const s = screenOf(n.id)
        if (!s) continue
        const d = Math.hypot(s.x - x, s.y - y)
        if (d < bestD) {
          best = { kind: 'node', id: n.id }
          bestD = d
        }
      }
      if (best) return best
      bestD = 5
      for (const l of placement.lines) {
        for (let i = 1; i < l.pts.length; i++) {
          const a = toScreen(l.pts[i - 1])
          const b = toScreen(l.pts[i])
          const d = segmentDistance(x, y, a, b)
          if (d < bestD) {
            best = { kind: 'edge', id: l.id }
            bestD = d
          }
        }
      }
      return best
    },
    [placement, nodes, screenOf, toScreen],
  )

  const press = useRef<{ x: number; y: number; hit: Hit; moved: boolean; pan: View; dragging: boolean } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    const r = canvas.current!.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const hit = hitTest(x, y)
    const node = hit?.kind === 'node' ? byId.get(hit.id) : undefined
    // A selected bus (or anything with a coordinate of its own) can be
    // dragged; anything else, or the empty map, pans.
    const dragging = !!node?.selected && !!placement?.own.has(node.id) && e.button === 0
    press.current = { x, y, hit, moved: false, pan: { ...view.current }, dragging }
    e.currentTarget.setPointerCapture(e.pointerId)
    setHover(null)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const p = press.current
    if (!p) {
      const hit = hitTest(x, y)
      setHover(hit ? { ...hit, x: e.clientX, y: e.clientY } : null)
      return
    }
    if (Math.hypot(x - p.x, y - p.y) > 3) p.moved = true
    if (!p.moved) return
    if (p.dragging && p.hit) {
      setDrag({ id: p.hit.id, world: toWorld(x, y) })
    } else {
      view.current = { ...p.pan, cx: p.pan.cx - (x - p.x) / p.pan.k, cy: p.pan.cy - (y - p.y) / p.pan.k }
      redraw((f) => f + 1)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current
    press.current = null
    if (!p) return
    const store = useCircuitStore.getState()
    if (p.dragging && p.moved && drag) {
      store.setGeo({ [drag.id]: unproject(drag.world) })
      setDrag(null)
      return
    }
    setDrag(null)
    if (p.moved) return
    if (!p.hit) {
      store.clearSelection()
      return
    }
    if (e.shiftKey) {
      const nodeIds = store.nodes.filter((n) => n.selected).map((n) => n.id)
      const edgeIds = store.edges.filter((ed) => ed.selected).map((ed) => ed.id)
      const list = p.hit.kind === 'node' ? nodeIds : edgeIds
      const i = list.indexOf(p.hit.id)
      if (i >= 0) list.splice(i, 1)
      else list.push(p.hit.id)
      store.selectMany({ nodeIds, edgeIds })
    } else {
      store.selectOnly(p.hit.kind, p.hit.id)
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const before = toWorld(x, y)
    const v = view.current
    let k = v.k * Math.pow(1.0015, -e.deltaY)
    if (mapped) k = Math.min(Math.max(k, 1), 2 ** 22)
    view.current = { k, cx: before.x - (x - size.w / 2) / k, cy: before.y - (y - size.h / 2) / k }
    redraw((f) => f + 1)
  }

  // Undo and redo work here as on the one-line; Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return
      if (useUiStore.getState().dialog) return
      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault()
        redo()
      } else if (e.key === 'Escape') {
        useCircuitStore.getState().clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Scripting hook, like `flow` for the one-line: where an element is drawn,
  // in page coordinates.
  useEffect(() => {
    window.opendssDesigner.map = {
      screenOf: (id: string) => {
        const s = screenOf(id)
        const r = canvas.current?.getBoundingClientRect()
        return s && r ? { x: s.x + r.left, y: s.y + r.top } : null
      },
      fit,
    }
    return () => {
      window.opendssDesigner.map = undefined
    }
  }, [screenOf, fit])

  useEffect(() => {
    const onFit = () => fit()
    window.addEventListener('opendss:fit-view', onFit)
    return () => window.removeEventListener('opendss:fit-view', onFit)
  }, [fit])

  const owned = placement ? [...placement.own].map((id) => byId.get(id)?.data.geo).filter((g): g is GeoPoint => !!g) : []
  const suggestLonLat = !crs && owned.length > 0 && looksLikeLonLat(owned.slice(0, 200))

  return (
    <div className="geo-wrap" ref={wrap}>
      <canvas
        ref={canvas}
        className="geo-canvas"
        data-frame={frame}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => !press.current && setHover(null)}
        onWheel={onWheel}
      />
      <div className="geo-toolbar">
        <label>
          Map
          <select
            value={basemap}
            aria-label="Basemap"
            disabled={!mapped}
            onChange={(e) => setBasemap(e.target.value as 'osm' | 'custom' | 'none')}
          >
            <option value="osm">OpenStreetMap</option>
            <option value="custom">Custom tiles…</option>
            <option value="none">None</option>
          </select>
        </label>
        {basemap === 'custom' && mapped && (
          <input
            className="geo-tile-url"
            aria-label="Tile URL"
            placeholder="https://…/{z}/{x}/{y}.png"
            defaultValue={basemapUrl}
            onBlur={(e) => setBasemap('custom', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setBasemap('custom', (e.target as HTMLInputElement).value)}
          />
        )}
        <button type="button" onClick={fit} title="Show the whole circuit">
          Fit
        </button>
        <span className="geo-status">
          {placement ? `${placement.placed} of ${placement.total} on the map` : 'Loading…'}
          {projection ? ` · ${projection.label}` : crs ? ` · unknown system "${crs.slice(0, 30)}"` : ' · plain grid'}
        </span>
      </div>
      {placement && placement.placed === 0 && (
        <div className="geo-empty">
          Nothing in this circuit has coordinates yet. Import a .dss file with BusCoords or LatLongCoords, or GIS
          layers (File → Import from → GIS layers or CSV tables), to see it on a map.
        </div>
      )}
      {placement && placement.placed > 0 && !projection && (
        <div className="geo-note">
          {crs ? 'The coordinate system is not one this app recognises, so ' : 'These coordinates have no coordinate system, so '}
          they are drawn on a plain grid.{' '}
          {suggestLonLat ? 'They look like longitude and latitude (EPSG:4326). ' : ''}
          <button type="button" onClick={() => useUiStore.getState().openDialog('project')}>
            Set the coordinate system…
          </button>
        </div>
      )}
      {mapped && tileTemplate && (
        <div className="geo-attribution">{basemap === 'osm' ? OSM_ATTRIBUTION : 'Custom tiles'}</div>
      )}
      {hover && !press.current && <ResultTooltip target={hover} />}
    </div>
  )
}

function segmentDistance(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy))
}

/** Tiles for the view at the nearest whole zoom, scaled to fit; a tile not
 *  yet loaded is fetched and the map redrawn when it arrives. */
function drawTiles(
  ctx: CanvasRenderingContext2D,
  v: View,
  size: { w: number; h: number },
  template: string,
  cache: Map<string, HTMLImageElement>,
  onLoad: () => void,
) {
  const z = Math.max(0, Math.min(19, Math.round(Math.log2(v.k))))
  const n = 2 ** z
  const tileWorld = TILE / n
  const left = v.cx - size.w / 2 / v.k
  const top = v.cy - size.h / 2 / v.k
  const x0 = Math.max(0, Math.floor(left / tileWorld))
  const y0 = Math.max(0, Math.floor(top / tileWorld))
  const x1 = Math.min(n - 1, Math.floor((left + size.w / v.k) / tileWorld))
  const y1 = Math.min(n - 1, Math.floor((top + size.h / v.k) / tileWorld))
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) return
  const px = tileWorld * v.k
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const url = tileUrl(template, z, tx, ty)
      let img = cache.get(url)
      if (!img) {
        img = new Image()
        img.crossOrigin = 'anonymous'
        // OpenStreetMap's tile policy asks for a referrer; the app's own
        // policy sends none, so tiles say where they are shown from.
        img.referrerPolicy = 'strict-origin-when-cross-origin'
        img.onload = onLoad
        img.src = url
        cache.set(url, img)
        if (cache.size > 600) cache.delete(cache.keys().next().value!)
      }
      if (img.complete && img.naturalWidth) {
        const sx = (tx * tileWorld - v.cx) * v.k + size.w / 2
        const sy = (ty * tileWorld - v.cy) * v.k + size.h / 2
        ctx.drawImage(img, sx, sy, px + 0.5, px + 0.5)
      }
    }
  }
}

/** A small mark per element type, in the spirit of a planning tool's map. */
function drawIcon(ctx: CanvasRenderingContext2D, n: AppNode, x: number, y: number, colour: string) {
  const p = n.data.params
  ctx.strokeStyle = colour
  ctx.fillStyle = colour
  ctx.lineWidth = 1.5
  const s = ICON
  switch (n.type) {
    case 'busbar':
      ctx.beginPath()
      ctx.arc(x, y, 3.5, 0, Math.PI * 2)
      ctx.fill()
      return
    case 'transformer':
    case 'regulator':
      ctx.fillStyle = 'white'
      for (const dy of [-2.5, 2.5]) {
        ctx.beginPath()
        ctx.arc(x, y + dy, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
      if (n.type === 'regulator') {
        ctx.beginPath()
        ctx.moveTo(x - 6, y + 6)
        ctx.lineTo(x + 6, y - 6)
        ctx.stroke()
      }
      return
    case 'breaker':
    case 'fuse':
    case 'recloser':
    case 'relay': {
      const closed = p.closed !== false
      ctx.beginPath()
      ctx.rect(x - s / 2, y - s / 2, s, s)
      if (closed) ctx.fill()
      else {
        ctx.fillStyle = 'white'
        ctx.fill()
        ctx.stroke()
      }
      return
    }
    case 'vsource':
      ctx.fillStyle = 'white'
      ctx.beginPath()
      ctx.arc(x, y, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x - 3.5, y)
      ctx.quadraticCurveTo(x - 1.75, y - 3, x, y)
      ctx.quadraticCurveTo(x + 1.75, y + 3, x + 3.5, y)
      ctx.stroke()
      return
    case 'load':
      ctx.beginPath()
      ctx.moveTo(x - 4, y - 3)
      ctx.lineTo(x + 4, y - 3)
      ctx.lineTo(x, y + 4)
      ctx.closePath()
      ctx.fill()
      return
    case 'capacitor':
      ctx.beginPath()
      ctx.moveTo(x - 4, y - 1.5)
      ctx.lineTo(x + 4, y - 1.5)
      ctx.moveTo(x - 4, y + 1.5)
      ctx.lineTo(x + 4, y + 1.5)
      ctx.stroke()
      return
    case 'generator':
    case 'pvsystem':
    case 'storage': {
      ctx.fillStyle = 'white'
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = colour
      ctx.font = 'bold 7px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(n.type === 'generator' ? 'G' : n.type === 'pvsystem' ? 'P' : 'B', x, y + 0.5)
      ctx.textAlign = 'start'
      ctx.textBaseline = 'alphabetic'
      return
    }
    default:
      return
  }
}
