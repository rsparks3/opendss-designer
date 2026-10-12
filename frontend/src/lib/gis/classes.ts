// What a GIS layer or table can be, and the properties of each that its
// columns can fill. Synonyms are the column names utilities' GIS exports
// commonly use; a column whose name matches one is mapped automatically.

export type ElementClass =
  | 'source'
  | 'line'
  | 'switch'
  | 'fuse'
  | 'recloser'
  | 'transformer'
  | 'load'
  | 'capacitor'
  | 'generator'
  | 'pvsystem'
  | 'storage'
  | 'linecode'
  | 'buscoords'
  | 'ignore'

export interface Prop {
  key: string
  label: string
  kind: 'text' | 'number' | 'phasing' | 'state'
  unit?: string
  /** Used when no column is mapped and no value typed. */
  fallback?: string | number
  synonyms: string[]
}

const name: Prop = { key: 'name', label: 'Name', kind: 'text', synonyms: ['name', 'id', 'facilityid', 'facility_id', 'assetid', 'objectid', 'fid', 'gisid', 'equipmentid', 'deviceid'] }
const bus1: Prop = { key: 'bus1', label: 'From bus', kind: 'text', synonyms: ['bus1', 'frombus', 'from_bus', 'fromnode', 'from_node', 'node1', 'upstream', 'bus', 'node', 'busname'] }
const bus2: Prop = { key: 'bus2', label: 'To bus', kind: 'text', synonyms: ['bus2', 'tobus', 'to_bus', 'tonode', 'to_node', 'node2', 'downstream'] }
const phasing: Prop = { key: 'phasing', label: 'Phasing', kind: 'phasing', synonyms: ['phasing', 'phase', 'phases_desig', 'phasedesignation', 'phasecode', 'phase_code', 'conductorphase'] }
const phases: Prop = { key: 'phases', label: 'Phase count', kind: 'number', synonyms: ['phases', 'nphases', 'numphases', 'phasecount', 'phase_count'] }
const kv: Prop = { key: 'kv', label: 'Rated kV', kind: 'number', unit: 'kV', fallback: 12.47, synonyms: ['kv', 'kvll', 'voltage', 'nominalvoltage', 'nominal_kv', 'operatingvoltage', 'basekv'] }
const normamps: Prop = { key: 'normamps', label: 'Rating', kind: 'number', unit: 'A', synonyms: ['normamps', 'ampacity', 'rating', 'ratedamps', 'amps', 'continuousrating'] }
const bus: Prop = { ...bus1, label: 'Bus' }
const closed: Prop = { key: 'closed', label: 'Normal state', kind: 'state', synonyms: ['normalstatus', 'normal_status', 'normalposition', 'status', 'state', 'closed', 'open', 'presentstatus'] }

export const CLASSES: Record<Exclude<ElementClass, 'ignore'>, { label: string; props: Prop[]; geometry: 'line' | 'point' | 'any' }> = {
  source: {
    label: 'Source (substation)',
    geometry: 'point',
    props: [name, bus,
      { key: 'basekv', label: 'Base kV', kind: 'number', unit: 'kV', fallback: 12.47, synonyms: ['basekv', 'kv', 'voltage', 'nominalvoltage'] },
      { key: 'pu', label: 'Voltage', kind: 'number', unit: 'pu', fallback: 1.0, synonyms: ['pu', 'vpu', 'setpoint'] },
      { key: 'mvasc3', label: '3φ short circuit', kind: 'number', unit: 'MVA', fallback: 2000, synonyms: ['mvasc3', 'mvasc', 'scmva'] },
      { key: 'mvasc1', label: '1φ short circuit', kind: 'number', unit: 'MVA', fallback: 2100, synonyms: ['mvasc1'] }],
  },
  line: {
    label: 'Line (conductor)',
    geometry: 'line',
    props: [name, bus1, bus2, phasing, phases,
      { key: 'length', label: 'Length', kind: 'number', synonyms: ['length', 'len', 'shape_length', 'shape_leng', 'measuredlength', 'conductorlength'] },
      { key: 'units', label: 'Length units', kind: 'text', synonyms: ['units', 'lengthunits', 'length_units', 'uom'] },
      { key: 'linecode', label: 'Line code', kind: 'text', synonyms: ['linecode', 'conductor', 'conductortype', 'conductor_type', 'wiretype', 'cable', 'cabletype', 'linetype'] },
      normamps,
      { key: 'r1', label: 'R1', kind: 'number', unit: 'Ω/unit', synonyms: ['r1', 'r_pos', 'rpos'] },
      { key: 'x1', label: 'X1', kind: 'number', unit: 'Ω/unit', synonyms: ['x1', 'x_pos', 'xpos'] },
      { key: 'r0', label: 'R0', kind: 'number', unit: 'Ω/unit', synonyms: ['r0', 'r_zero', 'rzero'] },
      { key: 'x0', label: 'X0', kind: 'number', unit: 'Ω/unit', synonyms: ['x0', 'x_zero', 'xzero'] }],
  },
  switch: { label: 'Switch', geometry: 'any', props: [name, bus1, bus2, phasing, phases, closed, normamps] },
  fuse: {
    label: 'Fuse',
    geometry: 'any',
    props: [name, bus1, bus2, phasing, phases, closed,
      { key: 'ratedcurrent', label: 'Link rating', kind: 'number', unit: 'A', fallback: 65, synonyms: ['ratedcurrent', 'linkrating', 'fusesize', 'fuse_size', 'rating', 'size'] }],
  },
  recloser: {
    label: 'Recloser',
    geometry: 'any',
    props: [name, bus1, bus2, phasing, phases, closed,
      { key: 'phasetrip', label: 'Phase pickup', kind: 'number', unit: 'A', fallback: 100, synonyms: ['phasetrip', 'phasepickup', 'phase_pickup', 'minimumtrip', 'mintrip'] },
      { key: 'groundtrip', label: 'Ground pickup', kind: 'number', unit: 'A', fallback: 50, synonyms: ['groundtrip', 'groundpickup', 'ground_pickup'] }],
  },
  transformer: {
    label: 'Transformer',
    geometry: 'any',
    props: [name, bus1, bus2, phasing, phases,
      { key: 'kva', label: 'Rating', kind: 'number', unit: 'kVA', fallback: 50, synonyms: ['kva', 'ratedkva', 'rated_kva', 'kvarating', 'kva_rating', 'size', 'capacity'] },
      { key: 'kvh', label: 'High-side kV', kind: 'number', unit: 'kV', fallback: 12.47, synonyms: ['kvh', 'primarykv', 'primary_kv', 'highsidekv', 'hv', 'primaryvoltage'] },
      { key: 'kvl', label: 'Low-side kV', kind: 'number', unit: 'kV', fallback: 0.24, synonyms: ['kvl', 'secondarykv', 'secondary_kv', 'lowsidekv', 'lv', 'secondaryvoltage'] },
      { key: 'connh', label: 'High-side connection', kind: 'text', fallback: 'wye', synonyms: ['connh', 'primaryconnection', 'conn1'] },
      { key: 'connl', label: 'Low-side connection', kind: 'text', fallback: 'wye', synonyms: ['connl', 'secondaryconnection', 'conn2'] },
      { key: 'xhl', label: 'Reactance', kind: 'number', unit: '%', fallback: 2, synonyms: ['xhl', 'impedance', 'percentimpedance', 'pctz', 'z'] }],
  },
  load: {
    label: 'Load',
    geometry: 'point',
    props: [name, bus, phasing, phases, kv,
      { key: 'kw', label: 'Demand', kind: 'number', unit: 'kW', fallback: 5, synonyms: ['kw', 'demand', 'peakkw', 'load_kw', 'kwdemand', 'avgkw'] },
      { key: 'pf', label: 'Power factor', kind: 'number', fallback: 0.95, synonyms: ['pf', 'powerfactor', 'power_factor'] },
      { key: 'numcust', label: 'Customers', kind: 'number', synonyms: ['numcust', 'customers', 'customercount', 'cust_count', 'meters'] }],
  },
  capacitor: {
    label: 'Capacitor bank',
    geometry: 'point',
    props: [name, bus, phasing, phases, kv,
      { key: 'kvar', label: 'Size', kind: 'number', unit: 'kvar', fallback: 300, synonyms: ['kvar', 'ratedkvar', 'size', 'bankkvar'] }],
  },
  generator: {
    label: 'Generator',
    geometry: 'point',
    props: [name, bus, phasing, phases, kv,
      { key: 'kw', label: 'Output', kind: 'number', unit: 'kW', fallback: 100, synonyms: ['kw', 'output', 'ratedkw', 'capacity'] },
      { key: 'kva', label: 'Rating', kind: 'number', unit: 'kVA', synonyms: ['kva', 'ratedkva'] }],
  },
  pvsystem: {
    label: 'PV system',
    geometry: 'point',
    props: [name, bus, phasing, phases, kv,
      { key: 'kva', label: 'Inverter rating', kind: 'number', unit: 'kVA', fallback: 10, synonyms: ['kva', 'inverterkva', 'acrating', 'kw_ac', 'kwac', 'capacity'] },
      { key: 'pmpp', label: 'Panel rating', kind: 'number', unit: 'kW', synonyms: ['pmpp', 'kwdc', 'kw_dc', 'dcrating'] }],
  },
  storage: {
    label: 'Storage',
    geometry: 'point',
    props: [name, bus, phasing, phases, kv,
      { key: 'kwrated', label: 'Power rating', kind: 'number', unit: 'kW', fallback: 100, synonyms: ['kwrated', 'kw', 'powerrating'] },
      { key: 'kwhrated', label: 'Energy rating', kind: 'number', unit: 'kWh', fallback: 200, synonyms: ['kwhrated', 'kwh', 'energyrating', 'capacity'] }],
  },
  linecode: {
    label: 'Line codes (table)',
    geometry: 'any',
    props: [name, phases,
      { key: 'r1', label: 'R1', kind: 'number', unit: 'Ω/unit', synonyms: ['r1', 'rpos'] },
      { key: 'x1', label: 'X1', kind: 'number', unit: 'Ω/unit', synonyms: ['x1', 'xpos'] },
      { key: 'r0', label: 'R0', kind: 'number', unit: 'Ω/unit', synonyms: ['r0', 'rzero'] },
      { key: 'x0', label: 'X0', kind: 'number', unit: 'Ω/unit', synonyms: ['x0', 'xzero'] },
      { key: 'units', label: 'Units', kind: 'text', fallback: 'km', synonyms: ['units', 'uom'] },
      normamps],
  },
  buscoords: {
    label: 'Bus coordinates (table)',
    geometry: 'any',
    props: [{ ...bus1, label: 'Bus' },
      { key: 'x', label: 'X / longitude', kind: 'number', synonyms: ['x', 'lon', 'long', 'longitude', 'easting', 'xcoord'] },
      { key: 'y', label: 'Y / latitude', kind: 'number', synonyms: ['y', 'lat', 'latitude', 'northing', 'ycoord'] }],
  },
}

/** A guess at a layer's class from its name ("OH_Primary_Conductor" ->
 *  line). The user confirms or changes it. */
export function guessClass(layerName: string, kind: 'line' | 'point' | 'table'): ElementClass {
  const n = layerName.toLowerCase()
  const has = (...words: string[]) => words.some((w) => n.includes(w))
  if (has('linecode', 'line_code', 'conductorlibrary', 'wiretype')) return 'linecode'
  if (has('coord', 'busxy', 'nodexy')) return 'buscoords'
  if (has('substation', 'source', 'circuitbreaker_head', 'feederhead')) return 'source'
  if (has('recloser')) return 'recloser'
  if (has('fuse', 'cutout')) return 'fuse'
  if (has('switch', 'breaker', 'sectionali', 'disconnect', 'elbow')) return 'switch'
  if (has('transformer', 'xfmr', 'xfr')) return 'transformer'
  if (has('capacitor', 'cap_bank', 'capbank')) return 'capacitor'
  if (has('solar', 'photovoltaic', '_pv', 'pv_', 'pvsystem')) return 'pvsystem'
  if (has('battery', 'storage', 'bess')) return 'storage'
  if (has('generator', 'genset', 'dg_')) return 'generator'
  if (has('load', 'meter', 'service', 'customer', 'premise', 'consumer')) return 'load'
  if (has('line', 'conductor', 'span', 'section', 'cable', 'primary', 'secondary', 'oh', 'ug')) return 'line'
  return kind === 'line' ? 'line' : kind === 'point' ? 'load' : 'ignore'
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Columns matched to properties by name: an exact synonym first. */
export function autoMap(props: Prop[], fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const taken = new Set<string>()
  for (const p of props) {
    const hit = fields.find((f) => !taken.has(f) && p.synonyms.map(norm).includes(norm(f)))
    if (hit) {
      out[p.key] = hit
      taken.add(hit)
    }
  }
  return out
}
