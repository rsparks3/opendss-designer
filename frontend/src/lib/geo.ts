// Coordinates on the ground: the circuit's coordinate system, and Web
// Mercator, which is what map tiles are drawn in.
//
// A feeder's coordinates are kept exactly as they arrived (`geo` on a node,
// `geometry` on a line edge), in whatever system the circuit's `crs` names:
// State Plane feet, UTM metres, latitude/longitude. proj4js turns them into
// longitude/latitude for the map, and back when a bus is dragged. Both it and
// the list of named systems are loaded only when the map is first shown.

export interface CrsEntry {
  code: string
  name: string
  proj4: string
}

export interface Projection {
  /** The circuit's coordinates to [longitude, latitude]. */
  toLonLat: (x: number, y: number) => [number, number]
  /** And back. */
  fromLonLat: (lon: number, lat: number) => [number, number]
  /** What to call it: "NAD83 / Arizona Central (ft)", or the code. */
  label: string
}

let listPromise: Promise<CrsEntry[]> | null = null

/** The coordinate systems offered by name (scripts/make_crs_list.py). */
export function crsList(): Promise<CrsEntry[]> {
  listPromise ??= import('./crsList.json').then((m) => m.default as CrsEntry[])
  return listPromise
}

const EPSG_RE = /^\s*(?:epsg\s*:\s*)?(\d{4,6})\s*$/i

/** "EPSG:2223" (or just "2223"), a proj4 string, or WKT -- as a projection,
 *  or null when it names nothing proj4 can use. */
export async function projectionFor(crs: string | null | undefined): Promise<Projection | null> {
  if (!crs?.trim()) return null
  const proj4 = (await import('proj4')).default
  const text = crs.trim()
  let def = text
  let label = text.length > 60 ? `${text.slice(0, 57)}…` : text
  const epsg = EPSG_RE.exec(text)
  if (epsg) {
    const code = `EPSG:${epsg[1]}`
    const hit = (await crsList()).find((c) => c.code === code)
    if (!hit) return null
    def = hit.proj4
    label = `${hit.name} (${code})`
  }
  try {
    const conv = proj4(def, 'EPSG:4326')
    // A definition proj4 accepts can still be nonsense; one round trip at
    // its own origin tells.
    const probe = conv.forward([0, 0]) as number[]
    if (!probe.every(Number.isFinite)) return null
    return {
      toLonLat: (x, y) => conv.forward([x, y]) as [number, number],
      fromLonLat: (lon, lat) => conv.inverse([lon, lat]) as [number, number],
      label,
    }
  } catch {
    return null
  }
}

/** Is this probably longitude/latitude? Only as a suggestion: the IEEE
 *  feeders' drawing coordinates fit in the same range. */
export function looksLikeLonLat(points: { x: number; y: number }[]): boolean {
  return points.length > 0 && points.every((p) => Math.abs(p.x) <= 180 && Math.abs(p.y) <= 90)
}

// --- Web Mercator -------------------------------------------------------------

/** A tile's size in pixels; world coordinates below are pixels at zoom 0. */
export const TILE = 256
const MAX_LAT = 85.05112878

/** Longitude/latitude to world pixels at zoom 0 (0..256 across). */
export function lonLatToWorld(lon: number, lat: number): [number, number] {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180
  const x = ((lon + 180) / 360) * TILE
  const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * TILE
  return [x, y]
}

export function worldToLonLat(x: number, y: number): [number, number] {
  const lon = (x / TILE) * 360 - 180
  const n = Math.PI - (2 * Math.PI * y) / TILE
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n))
  return [lon, lat]
}

/** A tile URL from an XYZ template ("https://tile.openstreetmap.org/{z}/{x}/{y}.png";
 *  `{s}` picks a subdomain a, b or c). */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  const s = 'abc'[(x + y) % 3]
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{s}', s)
}

export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors'
