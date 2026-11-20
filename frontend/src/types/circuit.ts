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
  /** A text annotation: no terminals, never compiled or solved. */
  | 'note'
  /** A labelled rectangle behind a group of elements; drawing only. */
  | 'zone'
export type EdgeKind = 'wire' | 'line'

export type Params = Record<string, unknown>

export interface Winding {
  kv: number
  kva: number
  conn: 'wye' | 'delta'
  /** Off-nominal tap (pu), when not 1. */
  tap?: number
  /** This winding's %r, when the windings differ (a centre-tapped unit). */
  pctr?: number
}

/** A point in the circuit's coordinate system (`CircuitJSON.crs`). */
export interface GeoPoint {
  x: number
  y: number
}

export interface CircuitNodeJSON {
  id: string
  type: NodeType
  position?: { x: number; y: number } | null
  width?: number | null
  height?: number | null
  params: Params
  /** Where it is on the ground (a bus's BusCoords, a GIS point), in the
   *  circuit's `crs`. Absent for elements that have no place yet. */
  geo?: GeoPoint | null
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
  /** A line's route on the ground between its two buses: the interior
   *  vertices of a GIS polyline, in the circuit's `crs`. */
  geometry?: GeoPoint[] | null
}

/** A user-defined time-current curve: multiples of the device's pickup
 *  against seconds to operate, like the engine's own curves. */
export interface TccCurveJSON {
  multiples: number[]
  seconds: number[]
  source?: string | null
}

/** A conductor definition lines refer to by name (OpenDSS's `LineCode`):
 *  either a full phase impedance matrix, `nphases` square, in ohms and nF per
 *  `units`, or the sequence values the engine expands to one. A real feeder
 *  is nearly always the first kind; the matrix carries the mutual coupling
 *  between phases that four sequence numbers cannot. */
export interface LineCodeJSON {
  nphases: number
  units: string
  rmatrix?: number[][] | null
  xmatrix?: number[][] | null
  cmatrix?: number[][] | null
  r1?: number | null
  x1?: number | null
  r0?: number | null
  x0?: number | null
  c1?: number | null
  c0?: number | null
  normamps?: number | null
  /** "imported", "typed in", "geometry:<name>", "preset:<code>". */
  source?: string | null
}

/** A general x-y curve (OpenDSS XYCurve): a smart inverter's volt-var or
 *  volt-watt characteristic, in per-unit voltage against per-unit power. */
export interface XYCurveJSON {
  x: number[]
  y: number[]
  /** "ieee1547:catB:voltvar", "imported", "typed in". */
  source?: string | null
}

/** A load condition studies run at: a multiplier on every load, optional
 *  multipliers by load class on top, and which rating loading is judged
 *  against. */
export interface LoadLevelJSON {
  name: string
  loadmult: number
  rating: 'normal' | 'emergency'
  classMult?: Record<string, number>
}

/** An alternative to the base circuit, as element-level deltas. */
export interface ScenarioJSON {
  id: string
  name: string
  description?: string
  /** element id -> {param: value}; null deletes the param. */
  overrides: Record<string, Params>
  addedNodes: CircuitNodeJSON[]
  addedEdges: CircuitEdgeJSON[]
  removed: string[]
}

/** A conductor (OpenDSS WireData / CNData / TSData). */
export interface WireDataJSON {
  kind: 'wire' | 'cn' | 'ts'
  rdc?: number | null
  rac?: number | null
  runits: string
  gmr?: number | null
  gmrunits: string
  radius?: number | null
  radunits: string
  normamps?: number | null
  emergamps?: number | null
  extra?: Record<string, number>
  source?: string | null
}

/** A pole or trench configuration (OpenDSS LineGeometry). */
export interface LineGeometryJSON {
  nconds: number
  nphases: number
  reduce: boolean
  units: string
  rhoEarth?: number | null
  conductors: { wire: string; x: number; h: number }[]
  source?: string | null
}

/** One change to the model, for the audit trail. */
export interface HistoryEntryJSON {
  t: number
  who: string
  id: string
  param: string
  old?: unknown
  new?: unknown
  scenario?: string | null
}

export interface WireLibraryEntry {
  code: string
  label: string
  kind: 'wire' | 'cn' | 'ts'
  spec: WireDataJSON
}

export interface TransformerCatalogEntry {
  code: string
  label: string
  phases: number
  kva: number | null
  kvh: number | null
  kvl: number | null
  connh: string
  connl: string
  xhl: number | null
  pctloadloss: number | null
  pctnoloadloss: number | null
  splitphase: boolean
}

export interface QaResult {
  score: number
  elements: number
  findings: { severity: 'warning' | 'info'; code: string; message: string; nodeId: string | null; edgeId: string | null }[]
  warnings: number
  infos: number
  loops: number
  completeness: { class: string; count: number; fields: number; missing: Record<string, number>; pct: number }[]
  voltageBases: number[]
}

export interface TlmResult {
  converged: boolean
  cancelled: boolean
  mode: 'daily' | 'yearly'
  stepMin: number
  ambientC: number
  transformers: { id: string; name: string; kva: number; peakPct: number; peakHour: number; hoursOver100: number; hoursOver150: number; equivalentAging: number | null; maxHotSpotC: number; lossOfLifePctPerYear: number; flag: string | null }[]
  services: { id: string; name: string; kv: number; bus: string; minVpu: number; minV120: number; minHour: number; maxVpu: number; maxV120: number; flag: string | null }[]
  summary: { transformers: number; overloaded: number; aging: number; services: number; lowVoltage: number; highVoltage: number }
  loadLevel: LoadLevelJSON
  issues: Issue[]
}

export interface AllocationResult {
  converged: boolean
  overrides: Record<string, Params>
  loadShapes: Record<string, LoadShapeJSON>
  matched: { id: string; name: string; key: unknown; kw: number; from: string; before: number | null; points?: number }[]
  unmatched: string[]
  noData: string[]
  headKwBefore: number | null
  headKwAfter: number | null
  targetHeadKw: number | null
  scale: number | null
  totalKw: number
  issues: Issue[]
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
  lineCodes?: Record<string, LineCodeJSON>
  /** Elements an imported .dss file had that the editor does not model,
   *  verbatim (core/passthrough.py). */
  passthrough?: PassthroughJSON[]
  /** Comment lines from an imported file, keyed by lowercase "class.name"
   *  ("circuit" for the header), written back above each element on export. */
  comments?: Record<string, string>
  /** Line-to-line kV bases bus voltages are reported against, as an imported
   *  file's `set voltagebases` gave them; absent means derived from ratings. */
  voltageBases?: number[] | null
  /** Coordinate system of `geo`/`geometry`: "EPSG:4326", another EPSG code,
   *  or a proj4/WKT definition. Absent: no known place on Earth. */
  crs?: string | null
  /** Abnormal-condition criteria; absent means DEFAULT_LIMITS (lib/limits). */
  limits?: LimitsJSON | null
  /** The study report's title block. */
  study?: StudyInfoJSON | null
  /** Conductors and pole configurations, keyed by name. */
  wireData?: Record<string, WireDataJSON>
  lineGeometries?: Record<string, LineGeometryJSON>
  /** The audit trail, newest last. */
  history?: HistoryEntryJSON[]
  /** Inverter volt-var / volt-watt curves, keyed by name. */
  xyCurves?: Record<string, XYCurveJSON>
  /** The load conditions studies run at; absent means rated only. */
  loadLevels?: LoadLevelJSON[] | null
  /** The level the next solve uses (a name); absent/null is rated. */
  activeLevel?: string | null
  /** Alternatives to this base circuit, and which one is open. */
  scenarios?: ScenarioJSON[] | null
  activeScenario?: string | null
  /** Tag names the project offers on loads (suggestions; any tag is allowed). */
  tagVocabulary?: string[] | null
  /** Load allocations to metered values, by zone (a meter element). */
  allocations?: AllocationJSON[] | null
}

/** Scale the loads below a meter point so the solve agrees with a measured
 *  value. The factor found is stored and applied when the circuit compiles,
 *  so the loads keep the values entered; *Bake* writes them in. */
export interface AllocationJSON {
  id: string
  /** The series element (or source) the measurement was taken at. */
  meterElementId: string
  targetKW: number
  targetKvar?: number | null
  targetPF?: number | null
  /** Multiplier by load priority or tag, applied before the scaling. */
  demandFactors?: Record<string, number> | null
  /** Where the measurement came from (free text, for the report). */
  source?: string
  /** The factor the last run found, applied at compile time; absent until run. */
  lastFactor?: number | null
  /** The kvar factor, when a kvar or PF target was given. */
  lastKvarFactor?: number | null
  lastAchievedKW?: number | null
  lastIterations?: number | null
  lastConverged?: boolean | null
}

export interface LimitsJSON {
  vminPu: number
  vmaxPu: number
  /** Loading at or above this is an overload... */
  overloadPct: number
  /** ...and at or above this, a warning. */
  warnPct: number
}

export interface StudyInfoJSON {
  title: string
  caseName: string
  engineer: string
  company: string
  description: string
  /** Exported images get a sheet border and this block as a title block. */
  sheet?: boolean
  /** How the report prints lengths. */
  units?: 'metric' | 'imperial'
}

export interface PassthroughJSON {
  /** "Monitor.m1", as the file spelled it. */
  name: string
  /** Its New line, then any Edits of it. */
  text: string
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
  /** Generators, PV and storage are rated in kVA, not amps; their loading
   *  is apparent power against this. Absent in time-series slices. */
  ratingKva?: number | null
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
  /** What the solve was run at. Absent from older results. */
  loadLevel?: LoadLevelJSON
  scenario?: string | null
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
  totals: { kw: number[]; lossKw: number[]; controlOps?: number[] }
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
  /** Tap changes per regulator and switching operations per capacitor
   *  bank over the run. Absent from older results. */
  controlOps?: {
    regulators: Record<string, { id: string | null; tapChanges: number }>
    capacitors: Record<string, { id: string | null; switchings: number }>
    total: number
  }
  loadLevel?: LoadLevelJSON
  scenario?: string | null
}

/** A background study on the server (core/jobs.py). */
export interface JobSnapshot<T = unknown> {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  created: number
  started: number | null
  finished: number | null
  progress: { done: number; total: number; message: string | null }
  engineSeconds: number
  error?: string
  result?: T
}

/** One cell of a batch run: a scenario at a load level. */
export interface BatchCell {
  scenario: string | null
  scenarioName: string
  level: string | null
  levelName: string
  loadmult: number
  rating: 'normal' | 'emergency'
  converged: boolean
  iterations: number | null
  minVpu: number | null
  minVBus: string | null
  maxVpu: number | null
  maxVBus: string | null
  maxLoadingPct: number | null
  maxLoadingElement: string | null
  maxLoadingId: string | null
  lossKw: number | null
  sourceKw: number | null
  undervoltages: number
  overvoltages: number
  overloads: number
  loadingWarnings: number
  errors: string[]
  /** Per-element numbers for the compare table (studies/batch.py). */
  detail?: {
    busVmin: Record<string, number | null>
    loading: Record<string, number>
    unservedKw: Record<'critical' | 'essential' | 'nonessential' | 'unassigned', number>
  } | null
}

export interface BatchResult {
  cells: BatchCell[]
  scenarios: { id: string | null; name: string }[]
  levels: (string | null)[]
  cancelled: boolean
  solves: number
}

/** What a hosting-capacity run evaluates and how (studies/hosting_capacity.py). */
export interface HostingCapacityOptions {
  kind: 'der' | 'load'
  method: 'iterative' | 'sensitivity'
  criteria: Record<string, boolean>
  buses?: string[] | null
  minKv: number
  threePhaseOnly: boolean
  vmaxPu?: number | null
  vminPu?: number | null
  deviationPct: number
  thermalPct: number
  substationExportKw: number
  faultIncreasePct: number
  interruptingPct: number
  islandingRatio: number
  derType: 'inverter' | 'synchronous'
  maxKw: number
  toleranceKw: number
  hours: number[] | null
}

export interface HostingBusResult {
  /** The capacity, kW; 0 when the base case already binds. */
  kw: number
  /** The criterion that bound ('none' when the search cap was reached). */
  binding: string | null
  violations: string[]
  /** The sensitivity method's estimate per criterion, kW. */
  byCriterion: Record<string, number | null>
  capped: boolean
  kvBase: number
  phases: number
  section: string | null
  sectionLoadKw: number
  baseFaultA: number | null
  /** Time-granular runs: the capacity at each evaluated hour. */
  kwByHour?: Record<string, number>
}

export interface HostingCapacityResult {
  converged: boolean
  cancelled: boolean
  kind: 'der' | 'load'
  method: 'iterative' | 'sensitivity'
  criteria: Record<string, boolean>
  options: Record<string, unknown>
  loadLevel: LoadLevelJSON
  scenario: string | null
  buses: Record<string, HostingBusResult>
  hours: number[]
  exclusions: Record<string, string[]>
  summary: {
    candidates: number
    evaluated: number
    minKw: number | null
    medianKw: number | null
    maxKw: number | null
    bindingCounts: Record<string, number>
    solves: number
    seconds: number
  }
  issues: Issue[]
  nodeBuses: Record<string, string[]>
  busNames: Record<string, string>
}

/** What one interconnection screening run is given (studies/screening.py). */
export interface ScreenOptions {
  kw: number
  pf: number
  kva: number | null
  derType: 'inverter' | 'synchronous'
  export: boolean
  aggregatePct: number
  minLoadPct: number
  faultIncreasePct: number
  interruptingPct: number
  deviationPct: number
  thermalPct: number
  inverterCategory: 'A' | 'B'
}

export interface ScreenRow {
  key: string
  label: string
  value: number | null
  limit: number | null
  unit: string
  /** null: informational, or could not be judged. */
  pass: boolean | null
  note: string
}

export interface ScreenResult {
  converged: boolean
  bus: string
  busName: string
  kvBase: number
  phases: number
  unit: { kw: number; pf: number; kva: number; derType: string; export: boolean }
  section: { head: string; peakLoadKw: number; minLoadKw: number; existingDerKw: number; minLoadMult: number }
  screens: ScreenRow[]
  failed: string[]
  outcome: 'pass' | 'supplemental' | 'fail'
  loadLevel: LoadLevelJSON
  scenario: string | null
  issues: Issue[]
  nodeBuses: Record<string, string[]>
  busNames: Record<string, string>
}

/** The headline numbers of one solved case (studies/contingency.py). */
export interface CaseSummary {
  minVpu: number | null
  minVBus: string | null
  maxVpu: number | null
  maxVBus: string | null
  maxLoadingPct: number | null
  maxLoadingElement: string | null
  undervoltages: number
  overvoltages: number
  overloads: number
  violations: number
}

export interface N1Case {
  id: string
  element: string
  kind: string
  converged: boolean
  unservedKw: number | null
  darkBuses?: number
  noAction?: CaseSummary
  bestTie: (CaseSummary & { tie: string; tieName: string; restoredKw: number; remainingUnservedKw: number; newViolations: number }) | null
  remainingUnservedKw: number | null
}

export interface N1Result {
  converged: boolean
  cancelled: boolean
  base: CaseSummary & { totalLoadKw: number; darkBuses: number }
  ties: { id: string; name: string }[]
  cases: N1Case[]
  summary: { candidates: number; evaluated: number; withLostLoad: number; restorable: number; solves: number }
  loadLevel: LoadLevelJSON
  issues: Issue[]
}

export interface TransferResult {
  converged: boolean
  tie: string
  tieName: string
  directions: (Partial<CaseSummary> & {
    sideBus: string
    isolatingDevice: string | null
    isolatingName: string | null
    transferredLoadKw?: number
    transferredLoads?: number
    kw: number | null
    multiplier?: number
    carriesPresentLoad?: boolean
    note?: string
  })[]
  loadLevel: LoadLevelJSON
  issues: Issue[]
}

export interface SwitchingResult {
  converged: boolean
  steps: (Partial<CaseSummary> & { step: number; action: string; id?: string; element?: string; converged?: boolean; unservedKw: number | null; darkBuses: number | null; skipped?: boolean })[]
  totalLoadKw: number
  issues: Issue[]
}

export interface DailyRunSummary {
  energyKwh: number
  lossesKwh: number
  lossPct: number | null
  minVpu: number | null
  maxVpu: number | null
  minLoadVpu: number | null
  meanVpu: number | null
  controlOps: number
  undervoltageBusSteps: number
  overvoltageBusSteps: number
  overloadSteps: number
  nonConverged: number
  steps: number
}

export interface SweepResult {
  converged: boolean
  cancelled: boolean
  stepMin: number
  targets: { id: string; name: string; property: string; values: number[] }[]
  rows: (DailyRunSummary & { settings: Record<string, number> })[]
  loadLevel: LoadLevelJSON
  issues: Issue[]
}

export interface CvrResult {
  converged: boolean
  how: string
  reductionV: number
  base: DailyRunSummary
  reduced: DailyRunSummary
  energySavedKwh: number
  energySavedPct: number | null
  voltageReducedPct: number | null
  cvrFactor: number | null
  lossesSavedKwh: number
  lowestLoadVpu: number | null
  lowestLoadV120: number | null
  cvrLoads: number
  loadLevel: LoadLevelJSON
  issues: Issue[]
}

export interface PlacementRow {
  bus: string
  kvBase: number
  lossKw: number
  lossReductionKw: number
  minVpu: number
  voltageLiftPu: number
  maxVpu: number
  overvoltage: boolean
}

export interface PlacementResult {
  converged: boolean
  cancelled: boolean
  kvar: number
  banks: number
  base: { lossKw: number; minVpu: number }
  placed: PlacementRow[]
  rounds: { bank: number; best: PlacementRow; candidates: PlacementRow[] }[]
  totalLossReductionKw: number
  candidates: number
  solves: number
  issues: Issue[]
  nodeBuses: Record<string, string[]>
  busNames: Record<string, string>
}

export interface BalanceMeasure {
  headCurrentsA: number[] | null
  currentUnbalancePct: number | null
  voltageUnbalancePct: number | null
  voltageUnbalanceBus: string | null
  lossKw: number | null
}

export interface BalanceResult {
  converged: boolean
  cancelled: boolean
  base: BalanceMeasure
  laterals: { id: string; name: string; rootBuses: string[]; phase: string; loadKw: number; elements: number; members: number }[]
  candidates: (BalanceMeasure & {
    lateral: string
    name: string
    loadKw: number
    elements: number
    fromPhase: string
    toPhase: string
    currentImprovementPct: number | null
    lossChangeKw: number | null
    overrides: Record<string, Params>
  })[]
  solves: number
  issues: Issue[]
}

export interface LossResult {
  converged: boolean
  cancelled: boolean
  mode: 'daily' | 'yearly'
  stepMin: number
  steps: number
  energyKwh: number
  lossesKwh: number
  lossPct: number | null
  byClass: { class: string; label: string; kwh: number; share: number | null; cost: number | null }[]
  pricePerKwh: number
  costTotal: number | null
  peakKw: number
  peakLossKw: number
  peakHour: number
  peakLossPct: number | null
  lossSeriesKw: number[]
  nonConverged: number
  issues: Issue[]
}

export interface CapacityResult {
  converged: boolean
  atCapacity: boolean
  capped?: boolean
  binding: string
  baseMult: number
  capacityMult: number
  capacityKw: number | null
  headroomKw: number
  base: { minVpu: number | null; minVBus: string | null; maxLoadingPct: number; maxLoadingElement: string | null; sourceKw: number }
  atLimit: { minVpu: number | null; minVBus: string | null; maxLoadingPct: number; maxLoadingElement: string | null; sourceKw: number }
  solves: number
  loadLevel: LoadLevelJSON
  issues: Issue[]
}

export interface FaultLineResult {
  converged: boolean
  line: string
  fraction: number
  kind: string
  rOhm: number
  faultA: number | null
  faultPhaseA: number[]
  devices: Record<string, { id: string; amps: number }>
  issues: Issue[]
}

export interface ReachResult {
  converged: boolean
  cancelled: boolean
  rOhm: number
  margin: number
  devices: {
    id: string
    name: string
    kind: string
    phasePickupA: number | null
    groundPickupA: number | null
    sectionBuses: number
    endBus: string | null
    minFaultKind: string | null
    minFaultA: number | null
    minLLA: number | null
    minLGrA: number | null
    derInfeedA: number
    seenByDeviceA: number | null
    reachRatio: number | null
    groundReachRatio: number | null
    ok: boolean
  }[]
  loadLevel: LoadLevelJSON
  issues: Issue[]
}

export interface FuseSavingResult {
  converged: boolean
  rOhm: number
  clearOverMelt: number
  pairs: {
    fuse: string
    fuseId: string
    recloser: string
    recloserId: string
    maxFaultA: number | null
    minFaultA: number | null
    recloserFastS: number | null
    fuseMeltS: number | null
    fuseClearS: number | null
    recloserDelayedS: number | null
    fuseSaving: boolean
    fuseBlowing: boolean
    clearFrom: string
    note: string
  }[]
  issues: Issue[]
}

export interface RecloserPlacementResult {
  converged: boolean
  cancelled: boolean
  base: { saifi: number | null; saidi: number | null; caidi: number | null; custHours: number }
  candidates: { line: string; name: string; lengthKm: number; saifi: number | null; saidi: number | null; saifiChange: number | null; saidiChange: number; custHoursSaved: number }[]
  issues: Issue[]
}

export interface HarmonicsResult {
  converged: boolean
  cancelled: boolean
  orders: number[]
  limits: { thdPct: number; individualPct: number }
  buses: Record<string, { thdPct: number; worstHarmonic: number | null; worstPct: number; spectrum: Record<string, number>; over: boolean }>
  summary: { buses: number; overLimit: number; worstThdPct: number; worstBus: string | null }
  loadLevel: LoadLevelJSON
  issues: Issue[]
  nodeBuses: Record<string, string[]>
  busNames: Record<string, string>
}

export interface RvcResult {
  converged: boolean
  kind: 'motorStart' | 'derTrip'
  bus: string
  label: string
  stepAtBusPct: number | null
  worstStepPct: number | null
  worstBus: string | null
  limitPct: number
  pass: boolean | null
  steps: Record<string, number>
  busesOver: number
  issues: Issue[]
  nodeBuses: Record<string, string[]>
  busNames: Record<string, string>
}

/** One protection section of the reliability study: the branches from a
 *  fuse, recloser or relay down to the next one. A fault anywhere in it
 *  interrupts every customer downstream of its head. */
export interface ReliabilitySection {
  /** "<meter>:<n>", unique across zones. */
  id: string
  meter: string
  /** The head device: engine name, diagram id, and the drawing's type. */
  head: string
  headId: string | null
  device: string
  /** Customers on the section's own buses, and downstream of its head. */
  customers: number
  totalCustomers: number
  branches: number
  lengthKm: number
  /** Permanent faults per year, summed over the section's branches. */
  lambda: number
  avgRepairHrs: number | null
  custInterrupts: number
  custHours: number
}

export interface ReliabilityElement {
  id: string
  meter: string
  sectionId: string | null
  /** This branch's permanent faults per year, and that plus everything
   *  downstream of it. */
  lambda: number
  accumulatedLambda: number
  customers: number
  totalCustomers: number
  repairHrs: number
  faultRate: number
  pctPerm: number
}

export interface ReliabilityMeter {
  name: string
  element: string
  elementId: string | null
  customers: number
  saifi: number | null
  saidi: number | null
  caidi: number | null
  saifiKw: number | null
  custInterrupts: number
  custHours: number
  sections: string[]
}

/** SAIFI, SAIDI and CAIDI from the engine's EnergyMeter reliability
 *  calculation (core/reliability.py), over every metered zone. */
export interface ReliabilityResult {
  converged: boolean
  issues: Issue[]
  totalCustomers: number
  /** Interruptions per customer per year. */
  saifi: number | null
  /** Hours out per customer per year. */
  saidi: number | null
  /** Hours per interruption. */
  caidi: number | null
  saifiKw: number | null
  custInterrupts: number
  custHours: number
  meters: ReliabilityMeter[]
  sections: ReliabilitySection[]
  elements: Record<string, ReliabilityElement>
  /** Branches between a meter and the first protective device, which the
   *  engine counts for nothing. */
  unsectioned: { count: number; lambda: number }
  /** The further indices (core/reliability.py extra_indices); absent from
   *  older results. */
  maifi?: number | null
  asai?: number | null
  cemi?: Record<string, number>
  asifi?: number | null
  outageCost?: number | null
  outageCostRates?: Record<string, { perInterruption: number; perHour: number }>
  nodeBuses: Record<string, string[]>
  lineBuses: Record<string, string[]>
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
