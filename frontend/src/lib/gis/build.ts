// GIS layers and tables, mapped to element classes, as an OpenDSS model.
//
// The result is ordinary .dss text plus a bus-coordinate file, which the
// app's importer then reads like any other model -- so a GIS import is
// exactly as faithful as the engine's reading of what this writes, and the
// same text could be compiled in stock OpenDSS.
//
// Topology: where bus columns are mapped, they name the buses. Where they
// are not, it comes from the geometry, as GIS networks are drawn: line ends
// within the snap tolerance of each other are one bus; a device drawn as a
// point attaches to the nearest bus within the attach radius -- a load
// preferring a transformer's secondary -- and a switch or transformer drawn
// as a point is inserted at its bus, everything downstream of it moved to a
// new bus on its far side. "Downstream" is away from the source, found by
// walking the network out from it.

import { CLASSES, type ElementClass, type Prop } from './classes'
import type { Feature, Layer, Value } from './layers'

export interface LayerPlan {
  layer: Layer
  cls: ElementClass
  /** Property key -> column name. */
  columns: Record<string, string>
  /** Property key -> typed value, used when no column is mapped. */
  values: Record<string, string>
}

export interface BuildOptions {
  circuitName: string
  /** Line ends closer than this (in the layers' units) are one bus. */
  snap: number
  /** How far a point device may be from the bus it attaches to. */
  attach: number
  /** The source's bus when no Source layer is mapped. */
  sourceBus?: string
  sourceKv?: number
}

export interface BuildResult {
  files: { name: string; text: string }[]
  /** Interior vertices of each line's route, by lower-case element name. */
  routes: Map<string, [number, number][]>
  /** What was made, by class. */
  counts: Partial<Record<ElementClass, number>>
  /** Elements left out, with why. */
  skipped: string[]
  notes: string[]
}

export class BuildError extends Error {}

const SQRT3 = Math.sqrt(3)
const LINE_CLASSES = new Set<ElementClass>(['line', 'switch', 'fuse', 'recloser', 'transformer'])
const SHUNTS = new Set<ElementClass>(['load', 'capacitor', 'generator', 'pvsystem', 'storage'])

/** OpenDSS names: no dots, spaces or punctuation the parser reads. */
export function dssName(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '') || 'x'
}

/** "ABC", "B", "AN", "A-B", "1.2" -> phase letters in order; '' if none. */
export function phaseLetters(raw: Value | undefined): string {
  if (raw == null) return ''
  const s = String(raw).toUpperCase()
  const set = new Set<string>()
  for (const ch of s) {
    if (ch === 'A' || ch === '1') set.add('A')
    else if (ch === 'B' || ch === '2') set.add('B')
    else if (ch === 'C' || ch === '3') set.add('C')
  }
  return ['A', 'B', 'C'].filter((c) => set.has(c)).join('')
}

const suffix = (letters: string) => letters.split('').map((c) => `.${'ABC'.indexOf(c) + 1}`).join('')

/** Is a switch's state value open? ("open", "O", "NO", "0", "false"...) */
export function isOpen(raw: Value | undefined): boolean {
  if (raw == null) return false
  const s = String(raw).trim().toLowerCase()
  return ['open', 'o', 'no', 'n.o.', 'normally open', 'normallyopen', '0', 'false', 'f', 'opened'].includes(s)
}

/** Distance unit of a coordinate system's text ("ft", "m" or "deg"). */
export function crsUnits(crs: string | undefined): 'ft' | 'm' | 'deg' {
  const c = crs ?? ''
  if (/EPSG:4326|EPSG:4269|\+proj=longlat|^GEOGCS|GEOGCRS\[/i.test(c) && !/PROJCS|PROJCRS/i.test(c)) return 'deg'
  if (/us-ft|\+units=ft|foot|feet/i.test(c)) return 'ft'
  return 'm'
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180
  const dLat = (b[1] - a[1]) * r
  const dLon = (b[0] - a[0]) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h))
}

interface Branch {
  dss: 'line' | 'switch' | 'fuse' | 'recloser' | 'transformer'
  name: string
  b1: string
  b2: string
  props: Record<string, Value>
  letters: string
  phases: number
}

export function buildModel(plans: LayerPlan[], opts: BuildOptions): BuildResult {
  const active = plans.filter((p) => p.cls !== 'ignore')
  const crs = active.find((p) => p.layer.crs)?.layer.crs
  const units = crsUnits(crs)
  const notes: string[] = []
  const skipped: string[] = []
  const counts: Partial<Record<ElementClass, number>> = {}
  const count = (c: ElementClass) => (counts[c] = (counts[c] ?? 0) + 1)
  const routes = new Map<string, [number, number][]>()

  // --- names ---
  const used = new Map<string, Set<string>>()
  const unique = (dssClass: string, raw: string): string => {
    const set = used.get(dssClass) ?? new Set<string>()
    used.set(dssClass, set)
    let n = dssName(raw)
    for (let i = 2; set.has(n.toLowerCase()); i++) n = `${dssName(raw)}_${i}`
    set.add(n.toLowerCase())
    return n
  }

  // --- buses: names, coordinates, a spatial hash to snap by ---
  const coords = new Map<string, [number, number]>()
  const cell = Math.max(opts.snap, 1e-12)
  const grid = new Map<string, string[]>()
  let auto = 0
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  const index = (bus: string, x: number, y: number) => {
    const k = key(x, y)
    const list = grid.get(k)
    if (list) list.push(bus)
    else grid.set(k, [bus])
  }
  const nearestWithin = (x: number, y: number, radius: number, among?: (b: string) => boolean): string | null => {
    const r = Math.ceil(radius / cell)
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    let best: string | null = null
    let bestD = radius
    // A large radius against a fine grid would visit millions of cells.
    if ((2 * r + 1) ** 2 > 40_000) {
      for (const [b, p] of coords) {
        if (among && !among(b)) continue
        const d = Math.hypot(p[0] - x, p[1] - y)
        if (d <= bestD) [best, bestD] = [b, d]
      }
      return best
    }
    for (let i = cx - r; i <= cx + r; i++) {
      for (let j = cy - r; j <= cy + r; j++) {
        for (const b of grid.get(`${i},${j}`) ?? []) {
          if (among && !among(b)) continue
          const p = coords.get(b)!
          const d = Math.hypot(p[0] - x, p[1] - y)
          if (d <= bestD) [best, bestD] = [b, d]
        }
      }
    }
    return best
  }
  const busAt = (x: number, y: number): string => {
    const hit = nearestWithin(x, y, opts.snap)
    if (hit) return hit
    const name = `b${++auto}`
    coords.set(name, [x, y])
    index(name, x, y)
    return name
  }
  const namedBus = (raw: Value, at?: [number, number]): string => {
    const name = dssName(String(raw))
    if (at && !coords.has(name)) {
      coords.set(name, at)
      index(name, at[0], at[1])
    }
    return name
  }

  const getter = (plan: LayerPlan) => {
    const props = new Map<string, Prop>(CLASSES[plan.cls as Exclude<ElementClass, 'ignore'>].props.map((p) => [p.key, p]))
    return (f: Feature, k: string): Value => {
      const col = plan.columns[k]
      if (col) {
        const v = f.attrs[col]
        if (v != null && v !== '') return v
      }
      const typed = plan.values[k]
      if (typed != null && typed.trim() !== '') {
        const n = Number(typed)
        return props.get(k)?.kind === 'number' && Number.isFinite(n) ? n : typed.trim()
      }
      return props.get(k)?.fallback ?? null
    }
  }
  const num = (v: Value, fallback: number): number => {
    if (v == null || v === '') return fallback
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  const by = (cls: ElementClass) => active.filter((p) => p.cls === cls)

  // --- bus coordinate tables first, so named buses have places ---
  for (const plan of by('buscoords')) {
    const get = getter(plan)
    for (const f of plan.layer.features) {
      const b = get(f, 'bus1')
      const x = get(f, 'x')
      const y = get(f, 'y')
      const pt = f.geometry?.type === 'point' ? f.geometry.coord : null
      if (b == null) continue
      const at: [number, number] | undefined = pt ?? (x != null && y != null ? [num(x, 0), num(y, 0)] : undefined)
      if (at) namedBus(b, at)
    }
  }

  // --- line codes ---
  const codes = new Map<string, string>()
  const codeLines: string[] = []
  for (const plan of by('linecode')) {
    const get = getter(plan)
    plan.layer.features.forEach((f, i) => {
      const name = unique('linecode', String(get(f, 'name') ?? `code${i + 1}`))
      codes.set(name.toLowerCase(), name)
      const parts = [`New LineCode.${name} nphases=${num(get(f, 'phases'), 3)}`]
      for (const k of ['r1', 'x1', 'r0', 'x0']) {
        const v = get(f, k)
        if (v != null) parts.push(`${k}=${num(v, 0)}`)
      }
      const amps = get(f, 'normamps')
      if (amps != null) parts.push(`normamps=${num(amps, 400)}`)
      parts.push(`units=${String(get(f, 'units') ?? 'km')}`)
      codeLines.push(parts.join(' '))
      count('linecode')
    })
  }

  // --- branches drawn as lines (or given by bus columns) ---
  const branches: Branch[] = []
  const pointDevices: { plan: LayerPlan; f: Feature; i: number }[] = []
  let defaultImpedance = 0
  const missingCodes = new Set<string>()
  for (const cls of ['line', 'switch', 'fuse', 'recloser', 'transformer'] as const) {
    for (const plan of by(cls)) {
      const get = getter(plan)
      plan.layer.features.forEach((f, i) => {
        const g = f.geometry
        const hasBuses = plan.columns.bus1 && plan.columns.bus2
        if (!hasBuses && g?.type === 'point') {
          pointDevices.push({ plan, f, i })
          return
        }
        const dssClass = cls === 'transformer' ? 'transformer' : 'line'
        const name = unique(dssClass, String(get(f, 'name') ?? `${cls}${i + 1}`))
        let b1: string | null = null
        let b2: string | null = null
        const line = g?.type === 'line' ? g.coords : null
        if (hasBuses) {
          b1 = namedBus(get(f, 'bus1')!, line?.[0])
          b2 = namedBus(get(f, 'bus2')!, line?.[line.length - 1])
        } else if (line) {
          b1 = busAt(...line[0])
          b2 = busAt(...line[line.length - 1])
        }
        if (!b1 || !b2) {
          skipped.push(`${CLASSES[cls].label} ${name}: no geometry and no bus columns`)
          return
        }
        if (b1 === b2) {
          skipped.push(`${CLASSES[cls].label} ${name}: both ends are the same bus (shorter than the snap tolerance)`)
          return
        }
        const letters = phaseLetters(get(f, 'phasing'))
        const phases = num(get(f, 'phases'), letters.length || 3)
        const props: Record<string, Value> = {}
        for (const p of CLASSES[cls].props) props[p.key] = get(f, p.key)
        if (cls === 'line') {
          if (line && line.length > 2) routes.set(name.toLowerCase(), line.slice(1, -1))
          if (props.length == null && line) {
            let len = 0
            for (let k = 1; k < line.length; k++) {
              len += units === 'deg' ? haversineKm(line[k - 1], line[k]) : Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1])
            }
            props.length = Math.round(len * 1e4) / 1e4
            props.units = units === 'deg' ? 'km' : units
          }
          const code = props.linecode != null ? codes.get(dssName(String(props.linecode)).toLowerCase()) : undefined
          if (props.linecode != null && !code) missingCodes.add(String(props.linecode))
          props.linecode = code ?? null
          if (!code && props.r1 == null) defaultImpedance++
        }
        branches.push({ dss: cls, name, b1, b2, props, letters, phases })
        count(cls)
      })
    }
  }
  if (missingCodes.size) {
    const list = [...missingCodes]
    notes.push(`${list.length} line code${list.length === 1 ? '' : 's'} named in the lines but in no line-code table ` +
      `(${list.slice(0, 5).join(', ')}${list.length > 5 ? ', …' : ''}): those lines use typical overhead values.`)
  }
  if (defaultImpedance) {
    notes.push(`${defaultImpedance} line${defaultImpedance === 1 ? '' : 's'} had no impedance or line code; ` +
      'typical overhead values (0.12 + j0.38 Ω/km) were used.')
  }

  // --- the source ---
  const sources: { name: string; bus: string; props: Record<string, Value> }[] = []
  for (const plan of by('source')) {
    const get = getter(plan)
    plan.layer.features.forEach((f, i) => {
      const name = unique('vsource', String(get(f, 'name') ?? `source${i + 1}`))
      const b = get(f, 'bus1')
      const pt = f.geometry?.type === 'point' ? f.geometry.coord : null
      const bus = b != null ? namedBus(b, pt ?? undefined) : pt ? nearestWithin(pt[0], pt[1], opts.attach) : null
      if (!bus) {
        skipped.push(`Source ${name}: no bus within the attach radius`)
        return
      }
      const props: Record<string, Value> = {}
      for (const p of CLASSES.source.props) props[p.key] = get(f, p.key)
      sources.push({ name, bus, props })
      count('source')
    })
  }
  if (!sources.length && opts.sourceBus?.trim()) {
    sources.push({ name: 'source', bus: dssName(opts.sourceBus), props: { basekv: opts.sourceKv ?? 12.47, pu: 1, mvasc3: 2000, mvasc1: 2100 } })
  }
  if (!sources.length) {
    throw new BuildError('Nothing says where the source is: map a layer as Source (substation), or name the source bus.')
  }

  // --- orient the network away from the source ---
  const adj = new Map<string, Branch[]>()
  const addAdj = (br: Branch) => {
    for (const b of [br.b1, br.b2]) {
      const l = adj.get(b)
      if (l) l.push(br)
      else adj.set(b, [br])
    }
  }
  branches.forEach(addAdj)
  const distance = (): Map<string, number> => {
    const dist = new Map<string, number>()
    const queue: string[] = []
    for (const s of sources) {
      dist.set(s.bus, 0)
      queue.push(s.bus)
    }
    for (let q = 0; q < queue.length; q++) {
      const b = queue[q]
      for (const br of adj.get(b) ?? []) {
        const other = br.b1 === b ? br.b2 : br.b1
        if (!dist.has(other)) {
          dist.set(other, dist.get(b)! + 1)
          queue.push(other)
        }
      }
    }
    return dist
  }

  // --- devices drawn as points, inserted at their bus ---
  const secondaries = new Map<string, Branch>() // secondary bus -> transformer
  const byTransformerName = new Map<string, Branch>()
  let dist = distance()
  for (const { plan, f, i } of pointDevices) {
    const cls = plan.cls as Branch['dss']
    const get = getter(plan)
    const dssClass = cls === 'transformer' ? 'transformer' : 'line'
    const name = unique(dssClass, String(get(f, 'name') ?? `${cls}${i + 1}`))
    const pt = (f.geometry as { coord: [number, number] }).coord
    const at = plan.columns.bus1 ? namedBus(get(f, 'bus1')!, pt) : nearestWithin(pt[0], pt[1], opts.attach)
    if (!at) {
      skipped.push(`${CLASSES[cls].label} ${name}: no bus within the attach radius`)
      continue
    }
    const far = unique('bus', `${at}_${name}`)
    const farAt = coords.get(at) ?? pt
    coords.set(far, farAt)
    index(far, farAt[0], farAt[1])
    // Everything on the far side of the device -- connections at this bus
    // that lead away from the source -- moves to the new bus.
    const here = dist.get(at)
    for (const br of [...(adj.get(at) ?? [])]) {
      const other = br.b1 === at ? br.b2 : br.b1
      const d = dist.get(other)
      if (here === undefined || d === undefined || d <= here) continue
      if (br.b1 === at) br.b1 = far
      else br.b2 = far
      adj.set(at, (adj.get(at) ?? []).filter((x) => x !== br))
      adj.set(far, [...(adj.get(far) ?? []), br])
    }
    const letters = phaseLetters(get(f, 'phasing'))
    const props: Record<string, Value> = {}
    for (const p of CLASSES[cls].props) props[p.key] = get(f, p.key)
    const br: Branch = { dss: cls, name, b1: at, b2: far, props, letters, phases: num(get(f, 'phases'), letters.length || 3) }
    branches.push(br)
    addAdj(br)
    if (cls === 'transformer') {
      secondaries.set(far, br)
      byTransformerName.set(name.toLowerCase(), br)
    }
    count(cls)
    dist = distance()
  }
  for (const br of branches) {
    if (br.dss === 'transformer') {
      secondaries.set(br.b2, br)
      byTransformerName.set(br.name.toLowerCase(), br)
    }
  }

  // --- shunts ---
  const shunts: { cls: ElementClass; name: string; bus: string; props: Record<string, Value>; letters: string; phases: number; via?: Branch }[] = []
  for (const cls of ['load', 'capacitor', 'generator', 'pvsystem', 'storage'] as const) {
    for (const plan of by(cls)) {
      const get = getter(plan)
      plan.layer.features.forEach((f, i) => {
        const name = unique(cls, String(get(f, 'name') ?? `${cls}${i + 1}`))
        const pt = f.geometry?.type === 'point' ? f.geometry.coord : null
        const raw = get(f, 'bus1')
        let bus: string | null = null
        let via: Branch | undefined
        if (raw != null && plan.columns.bus1) {
          via = byTransformerName.get(dssName(String(raw)).toLowerCase())
          bus = via ? via.b2 : namedBus(raw, pt ?? undefined)
        } else if (pt) {
          // Customers hang off a transformer's secondary when one is near.
          const lowVoltage = cls === 'load' || cls === 'pvsystem' || cls === 'storage'
          const sec = lowVoltage ? nearestWithin(pt[0], pt[1], opts.attach, (b) => secondaries.has(b)) : null
          bus = sec ?? nearestWithin(pt[0], pt[1], opts.attach)
          via = sec ? secondaries.get(sec) : undefined
        }
        if (!bus) {
          skipped.push(`${CLASSES[cls].label} ${name}: ${pt ? 'no bus within the attach radius' : 'no bus column and no location'}`)
          return
        }
        const letters = phaseLetters(get(f, 'phasing'))
        const props: Record<string, Value> = {}
        for (const p of CLASSES[cls].props) props[p.key] = get(f, p.key)
        // On a transformer's secondary, a load is at the secondary's
        // voltage unless a column says otherwise.
        if (via && !plan.columns.kv && !plan.values.kv?.trim()) props.kv = via.props.kvl
        const kv = num(props.kv, 12.47)
        const phases = num(get(f, 'phases'), letters.length || (via ? via.phases : kv < 1 ? 1 : 3))
        shunts.push({ cls, name, bus, props, letters, phases, via })
        count(cls)
      })
    }
  }

  // --- write it ---
  const bases = new Set<number>()
  const lines: string[] = []
  const src = sources[0]
  const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6)
  const basekv = num(src.props.basekv, 12.47)
  bases.add(basekv)
  lines.push(`New Circuit.${dssName(opts.circuitName) || 'gis'} bus1=${src.bus} basekv=${fmt(basekv)} ` +
    `pu=${fmt(num(src.props.pu, 1))} mvasc3=${fmt(num(src.props.mvasc3, 2000))} mvasc1=${fmt(num(src.props.mvasc1, 2100))}`)
  for (const s of sources.slice(1)) {
    const kv = num(s.props.basekv, basekv)
    bases.add(kv)
    lines.push(`New Vsource.${s.name} bus1=${s.bus} basekv=${fmt(kv)} pu=${fmt(num(s.props.pu, 1))} ` +
      `mvasc3=${fmt(num(s.props.mvasc3, 2000))} mvasc1=${fmt(num(s.props.mvasc1, 2100))}`)
  }
  lines.push(...codeLines)
  const after: string[] = []
  const perKm = { km: 1, m: 1 / 1000, ft: 1 / 3280.84, kft: 1 / 3.28084, mi: 1.609344 } as Record<string, number>
  let ln1 = 0
  for (const br of branches) {
    const sfx = br.letters && br.letters.length < 3 ? suffix(br.letters) : ''
    const ph = br.letters ? br.letters.length : br.phases
    const p = br.props
    if (br.dss === 'transformer') {
      const kva = num(p.kva, 50)
      let kvh = num(p.kvh, 12.47)
      const kvl = num(p.kvl, 0.24)
      // A single-phase unit's windings are rated line-to-neutral; GIS
      // usually records the system's line-to-line voltage instead.
      if (ph === 1 && kvh >= 1 && Math.abs(kvh - basekv) < 0.02 * basekv) {
        kvh = kvh / SQRT3
        ln1++
      }
      bases.add(ph === 1 ? kvh * SQRT3 : kvh)
      bases.add(ph === 1 && kvl < 1 ? kvl * SQRT3 : kvl)
      lines.push(`New Transformer.${br.name} phases=${ph} windings=2 buses=(${br.b1}${sfx}, ${br.b2}${ph === 1 ? '.1' : ''}) ` +
        `conns=(${String(p.connh ?? 'wye')}, ${String(p.connl ?? 'wye')}) kvs=(${fmt(kvh)}, ${fmt(kvl)}) ` +
        `kvas=(${fmt(kva)}, ${fmt(kva)}) xhl=${fmt(num(p.xhl, 2))}`)
      continue
    }
    const parts = [`New Line.${br.name} bus1=${br.b1}${sfx} bus2=${br.b2}${sfx} phases=${ph}`]
    if (br.dss === 'line') {
      const u = String(p.units ?? 'km').toLowerCase()
      const unitsOk = u in perKm || u === 'none'
      parts.push(`length=${fmt(num(p.length, 0.1))} units=${unitsOk ? u : 'km'}`)
      if (p.linecode) parts.push(`linecode=${p.linecode}`)
      else {
        const scale = perKm[unitsOk ? u : 'km'] ?? 1
        const z = (k: string, typical: number) => fmt(p[k] != null ? num(p[k], typical) : typical * scale)
        parts.push(`r1=${z('r1', 0.12)} x1=${z('x1', 0.38)} r0=${z('r0', 0.4)} x0=${z('x0', 1.2)}`)
      }
    } else {
      parts.push('switch=yes')
    }
    if (p.normamps != null) parts.push(`normamps=${fmt(num(p.normamps, 400))}`)
    lines.push(parts.join(' '))
    const open = isOpen(p.closed)
    const watch = `monitoredobj=Line.${br.name} switchedobj=Line.${br.name}`
    if (br.dss === 'fuse') lines.push(`New Fuse.${br.name} ${watch} ratedcurrent=${fmt(num(p.ratedcurrent, 65))}`)
    if (br.dss === 'recloser') {
      lines.push(`New Recloser.${br.name} ${watch} phasetrip=${fmt(num(p.phasetrip, 100))} groundtrip=${fmt(num(p.groundtrip, 50))}`)
    }
    // Only this order holds for a protective device (see the compiler).
    if (open && (br.dss === 'fuse' || br.dss === 'recloser')) after.push(`Disable ${br.dss}.${br.name}`)
    if (open) after.push(`Open Line.${br.name} term=1`)
  }
  if (ln1) notes.push(`${ln1} single-phase transformer${ln1 === 1 ? '' : 's'} recorded at the system's line-to-line ` +
    'voltage were rated line-to-neutral instead.')
  let mvLoads = 0
  for (const s of shunts) {
    const p = s.props
    const ph = s.letters ? s.letters.length : s.phases
    let kv = num(p.kv, 12.47)
    if (ph === 1 && kv >= 1 && Math.abs(kv - basekv) < 0.02 * basekv) {
      kv = kv / SQRT3
      mvLoads++
    }
    const onSecondary = s.via && s.via.phases === 1
    const sfx = onSecondary ? (ph === 1 ? '.1' : '.1.2') : s.letters && s.letters.length < 3 ? suffix(s.letters) : ''
    const bus = `bus1=${s.bus}${sfx} phases=${ph} kv=${fmt(kv)}`
    if (s.cls === 'load') {
      const cust = p.numcust != null ? ` numcust=${Math.round(num(p.numcust, 1))}` : ''
      lines.push(`New Load.${s.name} ${bus} kw=${fmt(num(p.kw, 5))} pf=${fmt(num(p.pf, 0.95))}${cust}`)
    } else if (s.cls === 'capacitor') {
      lines.push(`New Capacitor.${s.name} ${bus} kvar=${fmt(num(p.kvar, 300))}`)
    } else if (s.cls === 'generator') {
      const kva = p.kva != null ? ` kva=${fmt(num(p.kva, 0))}` : ''
      lines.push(`New Generator.${s.name} ${bus} kw=${fmt(num(p.kw, 100))}${kva} pf=1`)
    } else if (s.cls === 'pvsystem') {
      const kva = num(p.kva, 10)
      lines.push(`New PVSystem.${s.name} ${bus} kva=${fmt(kva)} pmpp=${fmt(num(p.pmpp, kva))} irradiance=1 pf=1`)
    } else if (s.cls === 'storage') {
      lines.push(`New Storage.${s.name} ${bus} kwrated=${fmt(num(p.kwrated, 100))} kwhrated=${fmt(num(p.kwhrated, 200))}`)
    }
  }
  if (mvLoads) notes.push(`${mvLoads} single-phase element${mvLoads === 1 ? '' : 's'} recorded at the system's ` +
    'line-to-line voltage were rated line-to-neutral instead.')
  lines.push(...after)
  const sortedBases = [...bases].filter((b) => b > 0).sort((a, b) => a - b).map(fmt)
  lines.push(`Set voltagebases=[${[...new Set(sortedBases)].join(', ')}]`, 'Calcvoltagebases')
  const files = [{ name: 'gis.dss', text: '' }]
  if (coords.size) {
    lines.push('BusCoords gis_buscoords.csv')
    files.push({ name: 'gis_buscoords.csv', text: [...coords].map(([b, [x, y]]) => `${b}, ${x}, ${y}`).join('\n') + '\n' })
  }
  files[0].text = `! Built by OpenDSS Designer from GIS layers and tables\n${lines.join('\n')}\n`

  // Elements the source does not reach: usually a snap tolerance too tight.
  const reached = distance()
  const island = branches.filter((b) => !reached.has(b.b1) && !reached.has(b.b2)).length +
    shunts.filter((s) => !reached.has(s.bus)).length
  if (island) {
    notes.push(`${island} element${island === 1 ? ' is' : 's are'} not connected to the source; ` +
      'a larger snap tolerance may join line ends that nearly meet.')
  }
  if (skipped.length) notes.push(`${skipped.length} feature${skipped.length === 1 ? ' was' : 's were'} left out.`)
  return { files, routes, counts, skipped, notes }
}

export { LINE_CLASSES, SHUNTS }
