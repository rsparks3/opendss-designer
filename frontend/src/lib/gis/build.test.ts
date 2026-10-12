import { describe, expect, it } from 'vitest'
import { buildModel, crsUnits, isOpen, phaseLetters, type LayerPlan } from './build'
import type { Feature, Layer } from './layers'

const line = (coords: [number, number][], attrs: Record<string, string | number | null> = {}): Feature => ({
  attrs,
  geometry: { type: 'line', coords },
})
const point = (coord: [number, number], attrs: Record<string, string | number | null> = {}): Feature => ({
  attrs,
  geometry: { type: 'point', coord },
})
const layer = (name: string, kind: Layer['kind'], features: Feature[], crs = 'EPSG:26912'): Layer => ({
  name,
  kind,
  fields: [...new Set(features.flatMap((f) => Object.keys(f.attrs)))],
  features,
  crs,
  notes: [],
})
const plan = (l: Layer, cls: LayerPlan['cls'], columns: Record<string, string> = {}, values: Record<string, string> = {}): LayerPlan => ({
  layer: l,
  cls,
  columns,
  values,
})
const opts = { circuitName: 'gis test', snap: 1, attach: 30 }
const dss = (r: ReturnType<typeof buildModel>) => r.files[0].text

describe('buildModel from geometry', () => {
  // A three-span primary heading east from a substation at the origin, its
  // ends meeting to within half a metre, with a tap to the north.
  const primary = layer('OH_Primary', 'line', [
    line([[0, 0], [50, 0], [100, 0]], { FACILITYID: 'L1', PHASE: 'ABC' }),
    line([[100.4, 0.3], [200, 0]], { FACILITYID: 'L2', PHASE: 'ABC' }),
    line([[200, 0], [200, 100]], { FACILITYID: 'L3', PHASE: 'B' }),
  ])
  const sub = layer('Substation', 'point', [point([0.2, 0], { NAME: 'Sub1', KV: 12.47 })])

  it('joins line ends within the snap tolerance and keeps each line\'s route', () => {
    const r = buildModel([plan(primary, 'line', { name: 'FACILITYID', phasing: 'PHASE' }), plan(sub, 'source', { name: 'NAME', basekv: 'KV' })], opts)
    const text = dss(r)
    expect(text).toMatch(/New Circuit\.gis_test bus1=b1 basekv=12\.47/)
    expect(text).toMatch(/New Line\.L1 bus1=b1 bus2=b2 phases=3 length=100 units=m/)
    expect(text).toMatch(/New Line\.L2 bus1=b2 bus2=b3 phases=3/) // 0.5 m apart: one bus
    expect(text).toMatch(/New Line\.L3 bus1=b3\.2 bus2=b4\.2 phases=1/)
    expect(r.routes.get('l1')).toEqual([[50, 0]])
    expect(r.files[1].name).toBe('gis_buscoords.csv')
    expect(r.counts).toMatchObject({ line: 3, source: 1 })
    expect(r.notes.join(' ')).toContain('typical overhead values')
  })

  it('inserts a switch drawn as a point, moving what is downstream of it', () => {
    const sw = layer('Switch', 'point', [point([100, 0], { ID: 'SW1', NORMALSTATUS: 'Open' })])
    const r = buildModel([plan(primary, 'line', { name: 'FACILITYID' }), plan(sub, 'source'), plan(sw, 'switch', { name: 'ID', closed: 'NORMALSTATUS' })], opts)
    const text = dss(r)
    // L2 leaves the switch's far side; the switch joins the two; it is open.
    expect(text).toMatch(/New Line\.L2 bus1=b2_SW1 bus2=b3/)
    expect(text).toMatch(/New Line\.SW1 bus1=b2 bus2=b2_SW1 phases=3 switch=yes/)
    expect(text).toContain('Open Line.SW1 term=1')
  })

  it('hangs customers off a nearby transformer at its secondary voltage', () => {
    const xf = layer('Transformers', 'point', [point([200, 100], { ID: 'T1', KVA: 25, PHASE: 'B' })])
    const meters = layer('ServicePoints', 'point', [point([210, 105], { ID: 'M1', KW: 3 }), point([500, 500], { ID: 'far' })])
    const r = buildModel([
      plan(primary, 'line', { name: 'FACILITYID', phasing: 'PHASE' }),
      plan(sub, 'source', {}, { basekv: '12.47' }),
      plan(xf, 'transformer', { name: 'ID', kva: 'KVA', phasing: 'PHASE' }),
      plan(meters, 'load', { name: 'ID', kw: 'KW' }),
    ], opts)
    const text = dss(r)
    // 12.47 kV recorded on a single-phase unit is rated 7.2 kV phase-to-ground.
    expect(text).toMatch(/New Transformer\.T1 phases=1 windings=2 buses=\(b4\.2, b4_T1\.1\) conns=\(wye, wye\) kvs=\(7\.199\d*, 0\.24\)/)
    expect(text).toMatch(/New Load\.M1 bus1=b4_T1\.1 phases=1 kv=0\.24 kw=3/)
    expect(r.skipped).toEqual(['Load far: no bus within the attach radius'])
    expect(r.notes.join(' ')).toContain('rated line-to-neutral')
    expect(text).toMatch(/Set voltagebases=\[0\.415692, 12\.47\]/)
  })

  it('needs to know where the source is', () => {
    expect(() => buildModel([plan(primary, 'line')], opts)).toThrow(/source/)
  })
})

describe('buildModel from tables', () => {
  it('takes topology from bus columns and impedance from a line-code table', () => {
    const lines = layer('lines', 'table', [
      { attrs: { id: 'a', from: 'src', to: 'n1', len: 0.5, code: '336 ACSR' } },
      { attrs: { id: 'b', from: 'n1', to: 'n2', len: 0.2, code: 'unknown' } },
    ], undefined as never)
    const codes = layer('codes', 'table', [{ attrs: { name: '336 ACSR', r1: 0.19, x1: 0.42, r0: 0.6, x0: 1.4 } }], undefined as never)
    const loads = layer('loads', 'table', [{ attrs: { name: 'ld1', bus: 'n2', kw: 50, kv: 12.47 } }], undefined as never)
    const r = buildModel([
      plan(lines, 'line', { name: 'id', bus1: 'from', bus2: 'to', length: 'len', linecode: 'code' }),
      plan(codes, 'linecode', { name: 'name', r1: 'r1', x1: 'x1', r0: 'r0', x0: 'x0' }),
      plan(loads, 'load', { name: 'name', bus1: 'bus', kw: 'kw', kv: 'kv' }),
    ], { ...opts, sourceBus: 'src', sourceKv: 12.47 })
    const text = dss(r)
    expect(text).toContain('New LineCode.336_ACSR nphases=3 r1=0.19 x1=0.42 r0=0.6 x0=1.4 units=km')
    expect(text).toContain('New Line.a bus1=src bus2=n1 phases=3 length=0.5 units=km linecode=336_ACSR')
    expect(text).toMatch(/New Line\.b bus1=n1 bus2=n2 phases=3 length=0\.2 units=km r1=0\.12/)
    expect(text).toContain('New Load.ld1 bus1=n2 phases=3 kv=12.47 kw=50 pf=0.95')
    expect(r.files).toHaveLength(1) // no coordinates anywhere
    expect(r.notes.join(' ')).toContain('unknown')
  })
})

describe('helpers', () => {
  it('reads phasing, switch states and coordinate units', () => {
    expect(phaseLetters('CBA')).toBe('ABC')
    expect(phaseLetters('B-N')).toBe('B')
    expect(phaseLetters('1.3')).toBe('AC')
    expect(phaseLetters(null)).toBe('')
    expect(isOpen('Normally Open')).toBe(true)
    expect(isOpen('CLOSED')).toBe(false)
    expect(isOpen(0)).toBe(true)
    expect(crsUnits('EPSG:4326')).toBe('deg')
    expect(crsUnits('+proj=tmerc +units=us-ft')).toBe('ft')
    expect(crsUnits('PROJCS["NAD83 / UTM zone 12N",GEOGCS["NAD83"],UNIT["metre",1]]')).toBe('m')
  })
})
