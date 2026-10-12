import { describe, expect, it } from 'vitest'
import { csvLayer, geojsonLayer, parseCsv, readLayers, shapefileLayer, unzip } from './layers'

// --- writers for the binary formats, test-only -------------------------------

function shp(type: 1 | 3, records: number[][][]): ArrayBuffer {
  // records: per feature, a list of [x, y] (one for a point).
  const bodies = records.map((pts) => {
    if (type === 1) {
      const b = new DataView(new ArrayBuffer(20))
      b.setInt32(0, 1, true)
      b.setFloat64(4, pts[0][0], true)
      b.setFloat64(12, pts[0][1], true)
      return b.buffer
    }
    const b = new DataView(new ArrayBuffer(44 + 4 + 16 * pts.length))
    b.setInt32(0, 3, true)
    b.setInt32(36, 1, true) // parts
    b.setInt32(40, pts.length, true)
    b.setInt32(44, 0, true)
    pts.forEach(([x, y], i) => {
      b.setFloat64(48 + 16 * i, x, true)
      b.setFloat64(56 + 16 * i, y, true)
    })
    return b.buffer
  })
  const total = 100 + bodies.reduce((n, b) => n + 8 + b.byteLength, 0)
  const out = new DataView(new ArrayBuffer(total))
  out.setInt32(0, 9994, false)
  out.setInt32(24, total / 2, false)
  out.setInt32(28, 1000, true)
  out.setInt32(32, type, true)
  let at = 100
  bodies.forEach((b, i) => {
    out.setInt32(at, i + 1, false)
    out.setInt32(at + 4, b.byteLength / 2, false)
    new Uint8Array(out.buffer).set(new Uint8Array(b), at + 8)
    at += 8 + b.byteLength
  })
  return out.buffer
}

function dbf(fields: { name: string; type: 'C' | 'N'; len: number }[], rows: (string | number)[][]): ArrayBuffer {
  const headerLen = 32 + 32 * fields.length + 1
  const recordLen = 1 + fields.reduce((n, f) => n + f.len, 0)
  const buf = new Uint8Array(headerLen + recordLen * rows.length + 1)
  const v = new DataView(buf.buffer)
  buf[0] = 3
  v.setUint32(4, rows.length, true)
  v.setUint16(8, headerLen, true)
  v.setUint16(10, recordLen, true)
  fields.forEach((f, i) => {
    const at = 32 + 32 * i
    buf.set(new TextEncoder().encode(f.name), at)
    buf[at + 11] = f.type.charCodeAt(0)
    buf[at + 16] = f.len
  })
  buf[headerLen - 1] = 0x0d
  rows.forEach((r, i) => {
    let at = headerLen + i * recordLen
    buf[at++] = 0x20
    fields.forEach((f, j) => {
      const s = String(r[j]).padEnd(f.len, ' ').slice(0, f.len)
      buf.set(new TextEncoder().encode(s), at)
      at += f.len
    })
  })
  buf[buf.length - 1] = 0x1a
  return buf.buffer
}

async function zip(files: { name: string; data: Uint8Array; deflate?: boolean }[]): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = new TextEncoder().encode(f.name)
    const body = f.deflate
      ? new Uint8Array(await new Response(new Blob([f.data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
      : f.data
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(8, f.deflate ? 8 : 0, true)
    local.setUint32(18, body.length, true)
    local.setUint32(22, f.data.length, true)
    local.setUint16(26, name.length, true)
    const dir = new DataView(new ArrayBuffer(46))
    dir.setUint32(0, 0x02014b50, true)
    dir.setUint16(10, f.deflate ? 8 : 0, true)
    dir.setUint32(20, body.length, true)
    dir.setUint32(24, f.data.length, true)
    dir.setUint16(28, name.length, true)
    dir.setUint32(42, offset, true)
    chunks.push(new Uint8Array(local.buffer), name, body)
    central.push(new Uint8Array(dir.buffer), name)
    offset += 30 + name.length + body.length
  }
  const dirLen = central.reduce((n, c) => n + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, dirLen, true)
  end.setUint32(16, offset, true)
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out.buffer
}

describe('CSV', () => {
  it('handles quotes, doubled quotes, CRLF and a semicolon delimiter', () => {
    expect(parseCsv('a;b\r\n"x;1";"say ""hi"""\r\n\r\n')).toEqual([['a', 'b'], ['x;1', 'say "hi"']])
    const l = csvLayer('loads', 'name,kw,kv\nL1,5.5,0.24\nL2,,0.24\n')
    expect(l.fields).toEqual(['name', 'kw', 'kv'])
    expect(l.features[0].attrs).toEqual({ name: 'L1', kw: 5.5, kv: 0.24 })
    expect(l.features[1].attrs.kw).toBeNull()
  })
})

describe('shapefile', () => {
  it('reads lines, their attributes and the .prj', () => {
    const l = shapefileLayer(
      'Primary',
      shp(3, [[[0, 0], [10, 0], [20, 5]], [[20, 5], [30, 5]]]),
      dbf([{ name: 'FACILITYID', type: 'C', len: 8 }, { name: 'PHASE', type: 'C', len: 3 }, { name: 'AMPS', type: 'N', len: 6 }],
        [['L1', 'ABC', 400], ['L2', 'B', '']]),
      'PROJCS["NAD83 / UTM zone 12N"]',
    )
    expect(l.kind).toBe('line')
    expect(l.crs).toContain('UTM zone 12N')
    expect(l.fields).toEqual(['FACILITYID', 'PHASE', 'AMPS'])
    expect(l.features[0]).toEqual({
      attrs: { FACILITYID: 'L1', PHASE: 'ABC', AMPS: 400 },
      geometry: { type: 'line', coords: [[0, 0], [10, 0], [20, 5]] },
    })
    expect(l.features[1].attrs.AMPS).toBeNull()
  })

  it('reads points', () => {
    const l = shapefileLayer('Meters', shp(1, [[[5, 6]]]))
    expect(l.kind).toBe('point')
    expect(l.features[0].geometry).toEqual({ type: 'point', coord: [5, 6] })
  })
})

describe('zip and readLayers', () => {
  it('unzips stored and deflated entries', async () => {
    const files = await unzip(await zip([
      { name: 'a.txt', data: new TextEncoder().encode('stored') },
      { name: 'dir/b.txt', data: new TextEncoder().encode('deflated '.repeat(50)), deflate: true },
    ]))
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('stored')
    expect(new TextDecoder().decode(files.get('dir/b.txt'))).toBe('deflated '.repeat(50))
  })

  it('groups a zipped shapefile\'s parts, and reads loose CSV and GeoJSON beside it', async () => {
    const archive = await zip([
      { name: 'gis/Primary.shp', data: new Uint8Array(shp(3, [[[0, 0], [1, 1]]])), deflate: true },
      { name: 'gis/Primary.dbf', data: new Uint8Array(dbf([{ name: 'ID', type: 'C', len: 4 }], [['L1']])) },
      { name: 'gis/Primary.prj', data: new TextEncoder().encode('GEOGCS["WGS 84"]') },
      { name: 'gis/Orphan.dbf', data: new Uint8Array(dbf([{ name: 'ID', type: 'C', len: 4 }], [['x']])) },
    ])
    const geojson = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { id: 'S1' }, geometry: { type: 'Point', coordinates: [-111.9, 33.4] } }],
    })
    const { layers, errors } = await readLayers([
      { name: 'feeder.zip', data: archive },
      { name: 'codes.csv', data: new TextEncoder().encode('name,r1\nc1,0.1\n').buffer },
      { name: 'subs.geojson', data: new TextEncoder().encode(geojson).buffer },
    ])
    expect(layers.map((l) => `${l.name}:${l.kind}`).sort()).toEqual(['Primary:line', 'codes:table', 'subs:point'])
    expect(layers.find((l) => l.name === 'Primary')!.features[0].attrs).toEqual({ ID: 'L1' })
    expect(layers.find((l) => l.name === 'subs')!.crs).toBe('EPSG:4326')
    expect(errors).toEqual(['Orphan.dbf has no Orphan.shp beside it; select both.'])
  })
})

describe('GeoJSON', () => {
  it('takes the first part of a MultiLineString and refuses an empty file', () => {
    const l = geojsonLayer('x', JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { a: 1, b: { nested: true } }, geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[5, 5], [6, 6]]] } }],
    }))
    expect(l.kind).toBe('line')
    expect(l.features[0].geometry).toEqual({ type: 'line', coords: [[0, 0], [1, 1]] })
    expect(l.features[0].attrs.b).toBe('{"nested":true}')
    expect(() => geojsonLayer('y', '{"type":"FeatureCollection","features":[]}')).toThrow(/no features/)
  })
})
