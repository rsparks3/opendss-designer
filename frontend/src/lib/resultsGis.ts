import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { HostingCapacityResult, ReliabilityResult, SolveResult } from '../types/circuit'
import { download } from './fileActions'

/**
 * Results to GIS: every bus and line with what the last studies said about
 * it, as GeoJSON (points for buses, lines along their routes), CSV or KML,
 * in the project's coordinate system (KML wants WGS84 and says so). The
 * properties are the ones a utility publishes on a map: voltage, loading,
 * hosting capacity, reliability section, phases.
 */

export type GisFormat = 'geojson' | 'csv' | 'kml'

interface BusRow {
  bus: string
  name: string
  nodeId: string
  x: number
  y: number
  props: Record<string, unknown>
}
interface LineRow {
  id: string
  name: string
  path: [number, number][]
  props: Record<string, unknown>
}

function busProps(bus: string, solve: SolveResult | null, hosting: HostingCapacityResult | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const b = solve?.buses[bus]
  if (b) {
    out.v_min_pu = b.vminPu
    out.v_max_pu = b.vmaxPu
    out.kv_base_ln = b.kvBase
    out.violation = b.violation ?? null
  }
  const h = hosting?.buses[bus]
  if (h) {
    out.hosting_kw = h.kw
    out.hosting_binding = h.binding
    out.hosting_kind = hosting?.kind
  }
  return out
}

function lineProps(id: string, solve: SolveResult | null, rel: ReliabilityResult | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (solve) {
    const el = Object.values(solve.elements).find((e) => e.id === id)
    if (el) {
      out.loading_pct = el.loadingPct
      out.kw = el.kw
      out.kvar = el.kvar
      out.amps = el.currents.length ? Math.max(...el.currents) : null
      out.loss_kw = el.lossKw
      out.violations = el.violations.join(',') || null
    }
  }
  if (rel) {
    const r = Object.values(rel.elements).find((e) => e.id === id)
    if (r) {
      out.section = r.sectionId
      out.fault_rate = r.faultRate
      out.customers_downstream = r.totalCustomers
    }
  }
  return out
}

export function collectRows(): { buses: BusRow[]; lines: LineRow[]; crs: string | null } {
  const s = useCircuitStore.getState()
  const rs = useResultsStore.getState()
  const solve = rs.result?.converged && !rs.stale ? rs.result : null
  const nodeBuses = solve?.nodeBuses ?? rs.hosting?.nodeBuses ?? rs.reliability?.nodeBuses ?? {}
  const busNames = solve?.busNames ?? rs.hosting?.busNames ?? {}
  const buses: BusRow[] = []
  const seen = new Set<string>()
  for (const n of s.nodes) {
    if (!n.data.geo || n.type === 'note' || n.type === 'zone') continue
    const bus = nodeBuses[n.id]?.[0]
    if (!bus || seen.has(bus)) continue
    seen.add(bus)
    buses.push({
      bus,
      name: busNames[bus] ?? String(n.data.params.name ?? bus),
      nodeId: n.id,
      x: n.data.geo.x,
      y: n.data.geo.y,
      props: { phases: rs.phases?.nodes[n.id]?.[0] ?? null, ...busProps(bus, solve, rs.hosting) },
    })
  }
  const geoOf = new Map(s.nodes.filter((n) => n.data.geo).map((n) => [n.id, n.data.geo!]))
  const lines: LineRow[] = []
  for (const e of s.edges) {
    if (e.type !== 'line') continue
    const a = geoOf.get(e.source)
    const b = geoOf.get(e.target)
    if (!a || !b) continue
    const path: [number, number][] = [[a.x, a.y], ...(e.data?.geometry ?? []).map((p) => [p.x, p.y] as [number, number]), [b.x, b.y]]
    lines.push({
      id: e.id,
      name: String(e.data?.params.name ?? e.id),
      path,
      props: { phases: e.data?.params.phasing ?? null, length: e.data?.params.length ?? null, units: e.data?.params.units ?? null, ...lineProps(e.id, solve, rs.reliability) },
    })
  }
  return { buses, lines, crs: s.crs }
}

export function resultsGeoJson(): string {
  const { buses, lines, crs } = collectRows()
  const features = [
    ...buses.map((b) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.x, b.y] }, properties: { kind: 'bus', bus: b.name, ...b.props } })),
    ...lines.map((l) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.path }, properties: { kind: 'line', name: l.name, ...l.props } })),
  ]
  const out: Record<string, unknown> = { type: 'FeatureCollection', features }
  if (crs) out.crs = { type: 'name', properties: { name: crs } }
  return JSON.stringify(out, null, 1)
}

export function resultsCsv(): string {
  const { buses, lines } = collectRows()
  const keys = new Set<string>()
  for (const r of [...buses, ...lines]) for (const k of Object.keys(r.props)) keys.add(k)
  const cols = ['kind', 'name', 'x', 'y', 'x2', 'y2', ...keys]
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [
    ...buses.map((b) => ['bus', b.name, b.x, b.y, '', '', ...[...keys].map((k) => b.props[k])]),
    ...lines.map((l) => ['line', l.name, l.path[0][0], l.path[0][1], l.path[l.path.length - 1][0], l.path[l.path.length - 1][1], ...[...keys].map((k) => l.props[k])]),
  ]
  return [cols, ...rows].map((r) => r.map(esc).join(',')).join('\n') + '\n'
}

export function resultsKml(): string {
  const { buses, lines, crs } = collectRows()
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const data = (props: Record<string, unknown>) =>
    `<ExtendedData>${Object.entries(props)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(String(v))}</value></Data>`)
      .join('')}</ExtendedData>`
  const marks = [
    ...buses.map((b) => `<Placemark><name>${esc(b.name)}</name>${data(b.props)}<Point><coordinates>${b.x},${b.y},0</coordinates></Point></Placemark>`),
    ...lines.map((l) => `<Placemark><name>${esc(l.name)}</name>${data(l.props)}<LineString><coordinates>${l.path.map(([x, y]) => `${x},${y},0`).join(' ')}</coordinates></LineString></Placemark>`),
  ]
  const note = crs && !/4326/.test(crs) ? `<description>Coordinates are in ${esc(crs)}; KML expects WGS84 longitude/latitude.</description>` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>OpenDSS Designer results</name>${note}${marks.join('\n')}</Document></kml>\n`
}

export function exportResultsToGis(format: GisFormat): boolean {
  const { buses, lines } = collectRows()
  if (!buses.length && !lines.length) {
    useResultsStore.getState().setFlash('Nothing has coordinates yet: import a file with BusCoords or GIS layers, or place elements on the map.')
    return false
  }
  const name = useCircuitStore.getState().name || 'circuit'
  if (format === 'geojson') download(`${name}-results.geojson`, resultsGeoJson(), 'application/geo+json')
  else if (format === 'csv') download(`${name}-results.csv`, resultsCsv(), 'text/csv')
  else download(`${name}-results.kml`, resultsKml(), 'application/vnd.google-earth.kml+xml')
  return true
}
