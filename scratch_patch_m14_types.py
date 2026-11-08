"""M14 frontend types and the results-store slots for the studies."""
from pathlib import Path


def patch(path: str, pairs: list[tuple[str, str]]) -> None:
    p = Path(path)
    s = p.read_text(encoding="utf-8")
    for old, new in pairs:
        assert old in s, f"{path}: anchor missing: {old[:70]!r}"
        s = s.replace(old, new, 1)
    p.write_text(s, encoding="utf-8")


patch("frontend/src/types/circuit.ts", [(
    "/** One protection section of the reliability study",
    '''/** The headline numbers of one solved case (studies/contingency.py). */
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

/** One protection section of the reliability study''',
)])

patch("frontend/src/store/resultsStore.ts", [
    ('''export type OverlayMode =''', '''/** The M14 studies the Studies tab holds results for. */
export type StudyKey = 'n1' | 'transfer' | 'switching' | 'sweep' | 'cvr' | 'placement' | 'balance' | 'losses' | 'capacity'

export type OverlayMode ='''),
    ('''  /** The last interconnection screening, for the report. */
  screening: ScreenResult | null
  setScreening: (r: ScreenResult | null) => void''', '''  /** The last interconnection screening, for the report. */
  screening: ScreenResult | null
  setScreening: (r: ScreenResult | null) => void
  /** Results of the planning studies (Studies tab), by key. Kept across
   *  edits like the batch: each says what it was run on. */
  studies: Partial<Record<StudyKey, unknown>>
  setStudy: (key: StudyKey, result: unknown) => void
  studyRunning: Partial<Record<StudyKey, boolean>>
  studyProgress: Partial<Record<StudyKey, { done: number; total: number; message: string | null }>>
  studyAbort: Partial<Record<StudyKey, AbortController | null>>
  setStudyRunning: (key: StudyKey, running: boolean, abort?: AbortController | null) => void
  setStudyProgress: (key: StudyKey, p: { done: number; total: number; message: string | null } | null) => void'''),
    ('''  screening: null,
  setScreening: (screening) => set({ screening }),''', '''  screening: null,
  setScreening: (screening) => set({ screening }),
  studies: {},
  setStudy: (key, result) => set((s) => ({ studies: { ...s.studies, [key]: result } })),
  studyRunning: {},
  studyProgress: {},
  studyAbort: {},
  setStudyRunning: (key, running, abort = null) =>
    set((s) => ({
      studyRunning: { ...s.studyRunning, [key]: running },
      studyAbort: { ...s.studyAbort, [key]: abort },
      ...(running ? {} : { studyProgress: { ...s.studyProgress, [key]: undefined } }),
    })),
  setStudyProgress: (key, p) => set((s) => ({ studyProgress: { ...s.studyProgress, [key]: p ?? undefined } })),'''),
])

# the tie switch field on breakers
patch("frontend/src/lib/fields.tsx", [(
    '''    { key: 'normamps', label: 'Rating', kind: 'number', unit: 'A' },
    EMERGENCY_AMPS,
    { key: 'interruptingka', label: 'Interrupting rating', kind: 'number', unit: 'kA' },''',
    '''    { key: 'normamps', label: 'Rating', kind: 'number', unit: 'A' },
    EMERGENCY_AMPS,
    { key: 'interruptingka', label: 'Interrupting rating', kind: 'number', unit: 'kA' },
    { key: 'tie', label: 'Tie switch (normally open)', kind: 'checkbox', defaultOff: true },''',
)])
print("m14 types patched")
