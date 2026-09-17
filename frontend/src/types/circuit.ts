// TypeScript mirror of the backend Pydantic schema (src/opendss_designer/core/model.py)

export type NodeType =
  | 'vsource'
  | 'busbar'
  | 'transformer'
  | 'load'
  | 'breaker'
  | 'capacitor'
  | 'generator'
  | 'pvsystem'
  | 'storage'
  | 'regulator'
  | 'fuse'
  | 'recloser'
  | 'relay'
export type EdgeKind = 'wire' | 'line'

export type Params = Record<string, unknown>

export interface Winding {
  kv: number
  kva: number
  conn: 'wye' | 'delta'
}

export interface CircuitNodeJSON {
  id: string
  type: NodeType
  position?: { x: number; y: number } | null
  width?: number | null
  height?: number | null
  params: Params
}

export interface CircuitEdgeJSON {
  id: string
  type: EdgeKind
  source: string
  sourceHandle?: string | null
  target: string
  targetHandle?: string | null
  params: Params
  waypoints?: { x: number; y: number }[] | null
}

/** A user-defined time-current curve: multiples of the device's pickup
 *  against seconds to operate, like the engine's own curves. */
export interface TccCurveJSON {
  multiples: number[]
  seconds: number[]
  source?: string | null
}

export interface LoadShapeJSON {
  /** Library category: drives the Shapes tabs, dropdown filtering, and
   *  kind-mismatch validation. Absent (older files) means 'load'. */
  kind?: 'load' | 'irradiance'
  /** Minutes per point (60 or 15). */
  intervalMin: number
  points: number[]
  /** Provenance tag, e.g. "csv", "nrel:resstock/3a/single-family_detached",
   *  or "nsrdb:39.74,-104.99/2018". */
  source?: string | null
}

export interface CircuitJSON {
  version: number
  name: string
  nodes: CircuitNodeJSON[]
  edges: CircuitEdgeJSON[]
  busNames: Record<string, string>
  loadShapes: Record<string, LoadShapeJSON>
  tccCurves?: Record<string, TccCurveJSON>
}

export interface Issue {
  severity: 'error' | 'warning'
  code: string
  message: string
  nodeId?: string | null
  edgeId?: string | null
}

/** Which phases reach each element, from the validation walk (no solve
 *  needed). `nodes` holds the letters at each terminal in terminal order;
 *  `wires` the letters on the bus a wire belongs to. "" means the walk never
 *  got there. */
export interface PhaseMap {
  nodes: Record<string, string[]>
  wires: Record<string, string>
}

export interface BusResult {
  vmagPu: number[]
  vangDeg: number[]
  vminPu: number | null
  vmaxPu: number | null
  kvBase: number
  nodes: number[]
  violation?: string
}

export interface ElementResult {
  id: string
  currents: number[]
  /** Node number (1=A, 2=B, 3=C) each entry of `currents` flows on. Absent in
   *  time-series slices, which record no currents. */
  phaseNodes?: number[]
  kw: number
  kvar: number
  normAmps: number | null
  loadingPct: number | null
  violations: string[]
  /** Series elements (lines, transformers) only; null for shunt elements. */
  lossKw: number | null
  lossKvar: number | null
}

export interface SolveResult {
  converged: boolean
  iterations: number
  buses: Record<string, BusResult>
  elements: Record<string, ElementResult>
  losses: { kw: number; kvar: number } | null
  issues: Issue[]
  nodeBuses: Record<string, string[]>
  lineBuses: Record<string, string[]>
  busNames: Record<string, string>
  /** Electrical km from the source to each bus (voltage profile x-axis). */
  busDistances: Record<string, number>
}

export interface TimeSeriesResult {
  converged: boolean
  cancelled: boolean
  mode: 'daily' | 'yearly'
  stepMin: number
  steps: number
  /** When true, `time` holds [bucketStart, bucketEnd] pairs and every series
   *  holds [min, max] per bucket (envelope-preserving polyline data). */
  downsampled: boolean
  time: number[]
  totals: { kw: number[]; lossKw: number[] }
  buses: Record<string, { vmin: number[]; vmax: number[]; kvBase: number }>
  elements: Record<
    string,
    { id: string; kw: number[]; kvar: number[]; ampsMax: number[]; loadingPct: (number | null)[] }
  >
  summary: {
    energyKwh: number
    lossesKwh: number
    peakKw: number
    peakHour: number
    minVpu: { bus: string; hour: number; value: number } | null
    maxVpu: { bus: string; hour: number; value: number } | null
  } | null
  nonConvergedSteps: number[]
  issues: Issue[]
  nodeBuses: Record<string, string[]>
  lineBuses: Record<string, string[]>
  busNames: Record<string, string>
}

export interface FaultBusResult {
  kvBase: number
  if3phA: number | null
  if1phA: number | null
  scMva3: number | null
  zsc1: { r: number; x: number }
  zsc0: { r: number; x: number }
}

export interface FaultResult {
  converged: boolean
  buses: Record<string, FaultBusResult>
  nodeBuses: Record<string, string[]>
  issues: Issue[]
}
