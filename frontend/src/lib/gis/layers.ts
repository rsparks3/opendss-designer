// Reading GIS layers and tables in the browser: CSV, Esri shapefile (.shp,
// .dbf, .prj, loose or zipped) and GeoJSON, into one shape -- a layer of
// features, each a row of attributes with an optional point or polyline.
// No dependencies: the formats are small, and a zip is inflated by the
// browser's own DecompressionStream.

export type Value = string | number | null

export interface Feature {
  attrs: Record<string, Value>
  geometry?: { type: 'point'; coord: [number, number] } | { type: 'line'; coords: [number, number][] }
}

export interface Layer {
  /** File name without its extension ("PrimaryConductor"). */
  name: string
  kind: 'line' | 'point' | 'table'
  fields: string[]
  features: Feature[]
  /** What the coordinates are in: a .prj's WKT, "EPSG:4326" for GeoJSON,
   *  or nothing for a table or a shapefile without a .prj. */
  crs?: string
  /** What could not be read, said once per layer. */
  notes: string[]
}

export class LayerError extends Error {}

// --- CSV ----------------------------------------------------------------------

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF; the delimiter is
 *  whichever of , ; or tab the header line uses most. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '')
  const firstLine = body.slice(0, body.search(/\r?\n/) >>> 0 || body.length)
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const)
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0]
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') {
      quoted = true
    } else if (c === delim) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++
      row.push(field)
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

const asValue = (raw: string): Value => {
  const t = raw.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && /^[-+]?(\d|\.\d)/.test(t) ? n : t
}

export function csvLayer(name: string, text: string): Layer {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new LayerError(`${name}: no rows under the header.`)
  const fields = uniqueFields(rows[0].map((h) => h.trim()))
  const features = rows.slice(1).map((r) => ({
    attrs: Object.fromEntries(fields.map((f, i) => [f, asValue(r[i] ?? '')])),
  }))
  return { name, kind: 'table', fields, features, notes: [] }
}

function uniqueFields(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n, i) => {
    const base = n || `column${i + 1}`
    const k = (seen.get(base) ?? 0) + 1
    seen.set(base, k)
    return k > 1 ? `${base}_${k}` : base
  })
}

// --- shapefile ----------------------------------------------------------------

const POINT_TYPES = new Set([1, 11, 21, 8, 18, 28])
const LINE_TYPES = new Set([3, 13, 23])

/** A shapefile from its parts: .shp geometry, .dbf attributes, .prj system. */
export function shapefileLayer(
  name: string,
  shp: ArrayBuffer,
  dbf?: ArrayBuffer,
  prj?: string,
  cpg?: string,
): Layer {
  const notes: string[] = []
  const v = new DataView(shp)
  if (shp.byteLength < 100 || v.getInt32(0, false) !== 9994) throw new LayerError(`${name}.shp is not a shapefile.`)
  const shapeType = v.getInt32(32, true)
  const kind: Layer['kind'] = LINE_TYPES.has(shapeType) ? 'line' : POINT_TYPES.has(shapeType) ? 'point' : 'table'
  if (kind === 'table') notes.push(`${name}: shape type ${shapeType} is neither points nor lines; only its attributes are read.`)
  const geoms: Feature['geometry'][] = []
  let multipart = 0
  let off = 100
  while (off + 8 <= shp.byteLength) {
    const len = v.getInt32(off + 4, false) * 2
    const rec = off + 8
    const type = len >= 4 ? v.getInt32(rec, true) : 0
    if (type === 0) geoms.push(undefined)
    else if (type === 1 || type === 11 || type === 21) {
      geoms.push({ type: 'point', coord: [v.getFloat64(rec + 4, true), v.getFloat64(rec + 12, true)] })
    } else if (type === 8 || type === 18 || type === 28) {
      const n = v.getInt32(rec + 36, true)
      geoms.push(n ? { type: 'point', coord: [v.getFloat64(rec + 40, true), v.getFloat64(rec + 48, true)] } : undefined)
    } else if (LINE_TYPES.has(type)) {
      const parts = v.getInt32(rec + 36, true)
      const points = v.getInt32(rec + 40, true)
      if (parts > 1) multipart++
      // The first part: a feeder segment is one run of conductor.
      const end = parts > 1 ? v.getInt32(rec + 48, true) : points
      const base = rec + 44 + 4 * parts
      const coords: [number, number][] = []
      for (let i = 0; i < end; i++) coords.push([v.getFloat64(base + 16 * i, true), v.getFloat64(base + 16 * i + 8, true)])
      geoms.push(coords.length >= 2 ? { type: 'line', coords } : undefined)
    } else geoms.push(undefined)
    off = rec + len
  }
  if (multipart) notes.push(`${name}: ${multipart} multi-part line${multipart === 1 ? '' : 's'}; only the first part of each is used.`)
  const { fields, rows } = dbf ? parseDbf(dbf, cpg) : { fields: [], rows: [] as Record<string, Value>[] }
  const features = geoms.map((g, i) => ({ attrs: rows[i] ?? {}, ...(g ? { geometry: g } : {}) }))
  return { name, kind, fields, features, ...(prj?.trim() ? { crs: prj.trim() } : {}), notes }
}

/** dBase III/IV attribute table. Text decodes as the .cpg says, else UTF-8
 *  (falling back to Latin-1 where that fails). */
export function parseDbf(buf: ArrayBuffer, cpg?: string): { fields: string[]; rows: Record<string, Value>[] } {
  const v = new DataView(buf)
  const count = v.getUint32(4, true)
  const headerLen = v.getUint16(8, true)
  const recordLen = v.getUint16(10, true)
  const bytes = new Uint8Array(buf)
  const label = /1252|latin|8859/i.test(cpg ?? '') ? 'windows-1252' : 'utf-8'
  const text = new TextDecoder(label, { fatal: false })
  const cols: { name: string; type: string; off: number; len: number }[] = []
  let at = 32
  let rowOff = 1
  while (at + 32 <= headerLen && bytes[at] !== 0x0d) {
    const raw = bytes.subarray(at, at + 11)
    const name = new TextDecoder('ascii').decode(raw.subarray(0, raw.indexOf(0) >= 0 ? raw.indexOf(0) : 11)).trim()
    const type = String.fromCharCode(bytes[at + 11])
    const len = bytes[at + 16]
    cols.push({ name, type, off: rowOff, len })
    rowOff += len
    at += 32
  }
  const fields = uniqueFields(cols.map((c) => c.name))
  const rows: Record<string, Value>[] = []
  for (let r = 0; r < count; r++) {
    const start = headerLen + r * recordLen
    if (start + recordLen > bytes.length) break
    if (bytes[start] === 0x2a) continue // deleted
    const row: Record<string, Value> = {}
    cols.forEach((c, i) => {
      const s = text.decode(bytes.subarray(start + c.off, start + c.off + c.len)).trim()
      row[fields[i]] = c.type === 'N' || c.type === 'F' ? (s === '' ? null : Number(s)) : s === '' ? null : s
    })
    rows.push(row)
  }
  return { fields, rows }
}

// --- zip ----------------------------------------------------------------------

/** The files in a zip archive (stored or deflated), by name. */
export async function unzip(buf: ArrayBuffer): Promise<Map<string, ArrayBuffer>> {
  const v = new DataView(buf)
  const bytes = new Uint8Array(buf)
  // End of central directory: the last 0x06054b50 within the final 64 kB.
  let eocd = -1
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new LayerError('Not a zip archive.')
  const entries = v.getUint16(eocd + 10, true)
  let at = v.getUint32(eocd + 16, true)
  const out = new Map<string, ArrayBuffer>()
  for (let e = 0; e < entries; e++) {
    if (v.getUint32(at, true) !== 0x02014b50) break
    const method = v.getUint16(at + 10, true)
    const size = v.getUint32(at + 20, true)
    const nameLen = v.getUint16(at + 28, true)
    const extraLen = v.getUint16(at + 30, true)
    const commentLen = v.getUint16(at + 32, true)
    const local = v.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const data = bytes.slice(dataAt, dataAt + size)
    if (method === 0) out.set(name, data.buffer)
    else if (method === 8) out.set(name, await inflateRaw(data))
  }
  return out
}

async function inflateRaw(data: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).arrayBuffer()
}

// --- GeoJSON ------------------------------------------------------------------

export function geojsonLayer(name: string, text: string): Layer {
  let doc: { type?: string; features?: unknown[] }
  try {
    doc = JSON.parse(text)
  } catch {
    throw new LayerError(`${name}: not valid JSON.`)
  }
  const raw = doc.type === 'FeatureCollection' && Array.isArray(doc.features) ? doc.features : []
  if (!raw.length) throw new LayerError(`${name}: no features (a GeoJSON FeatureCollection was expected).`)
  const features: Feature[] = []
  const fields = new Set<string>()
  let lines = 0
  let points = 0
  for (const f of raw as { properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } }[]) {
    const attrs: Record<string, Value> = {}
    for (const [k, val] of Object.entries(f.properties ?? {})) {
      fields.add(k)
      attrs[k] = typeof val === 'number' || typeof val === 'string' ? val : val == null ? null : JSON.stringify(val)
    }
    const g = f.geometry
    let geometry: Feature['geometry']
    if (g?.type === 'Point') {
      const [x, y] = g.coordinates as number[]
      geometry = { type: 'point', coord: [x, y] }
      points++
    } else if (g?.type === 'LineString' || g?.type === 'MultiLineString') {
      const coords = (g.type === 'LineString' ? g.coordinates : (g.coordinates as number[][][])[0]) as number[][]
      geometry = { type: 'line', coords: coords.map(([x, y]) => [x, y] as [number, number]) }
      lines++
    }
    features.push({ attrs, ...(geometry ? { geometry } : {}) })
  }
  const kind: Layer['kind'] = lines >= points && lines ? 'line' : points ? 'point' : 'table'
  // RFC 7946: GeoJSON is longitude/latitude on WGS 84.
  return { name, kind, fields: [...fields], features, crs: 'EPSG:4326', notes: [] }
}

// --- files to layers --------------------------------------------------------

const stem = (n: string) => n.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
const ext = (n: string) => (n.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase()

/** Every layer in a set of picked files: CSV tables, GeoJSON, shapefiles
 *  (their parts matched by name), and the same inside zip archives. */
export async function readLayers(files: { name: string; data: ArrayBuffer }[]): Promise<{ layers: Layer[]; errors: string[] }> {
  const all: { name: string; data: ArrayBuffer }[] = []
  const errors: string[] = []
  for (const f of files) {
    if (ext(f.name) === 'zip') {
      try {
        for (const [name, data] of await unzip(f.data)) all.push({ name, data })
      } catch (err) {
        errors.push(`${f.name}: ${(err as Error).message}`)
      }
    } else all.push(f)
  }
  const layers: Layer[] = []
  const parts = new Map<string, Record<string, ArrayBuffer>>()
  const decode = (b: ArrayBuffer) => new TextDecoder().decode(b)
  for (const f of all) {
    const e = ext(f.name)
    try {
      if (e === 'csv' || e === 'txt') layers.push(csvLayer(stem(f.name), decode(f.data)))
      else if (e === 'geojson' || e === 'json') layers.push(geojsonLayer(stem(f.name), decode(f.data)))
      else if (['shp', 'dbf', 'prj', 'cpg'].includes(e)) {
        const key = stem(f.name)
        parts.set(key, { ...(parts.get(key) ?? {}), [e]: f.data })
      }
    } catch (err) {
      errors.push((err as Error).message)
    }
  }
  for (const [name, p] of parts) {
    if (!p.shp) {
      if (p.dbf) errors.push(`${name}.dbf has no ${name}.shp beside it; select both.`)
      continue
    }
    try {
      layers.push(shapefileLayer(name, p.shp, p.dbf, p.prj && decode(p.prj), p.cpg && decode(p.cpg)))
    } catch (err) {
      errors.push((err as Error).message)
    }
  }
  return { layers, errors }
}
