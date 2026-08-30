import { create } from 'zustand'
import { tsIndexNearHour, tsSlice } from '../lib/tsSlice'
import type { FaultResult, Issue, SolveResult, TimeSeriesResult } from '../types/circuit'

export type AnalysisMode = 'snapshot' | 'timeseries'

export type OverlayMode = 'voltage' | 'loading' | 'power' | 'fault' | 'off'

interface ResultsState {
  result: SolveResult | null
  /** Fault study result; cleared on any circuit change (it can't go stale —
   *  it's either for the current circuit or gone). */
  fault: FaultResult | null
  setFault: (f: FaultResult | null) => void
  stale: boolean
  solving: boolean
  overlay: OverlayMode
  issues: Issue[]
  flash: string | null
  flashKind: 'error' | 'info'
  /** When on, a solve runs automatically after every circuit change. */
  autoSolve: boolean
  setAutoSolve: (b: boolean) => void

  /** Snapshot vs time-series analysis. In time-series mode the canvas
   *  overlays show the scrubbed step of the recorded run, and manual
   *  Solve/Auto snapshot runs are disabled. */
  analysisMode: AnalysisMode
  setAnalysisMode: (m: AnalysisMode) => void
  /** Scrub position (index into the recorded run's arrays) and the recorded
   *  step reshaped as a SolveResult for the overlays. */
  tsIndex: number | null
  setTsIndex: (i: number | null) => void
  scrubResult: SolveResult | null

  /** Time-series run; cleared on any circuit change like `fault`. Runs are
   *  explicit (Run button) — never triggered by auto-solve. */
  timeseries: TimeSeriesResult | null
  setTimeseries: (r: TimeSeriesResult | null) => void
  tsRunning: boolean
  tsProgress: { step: number; total: number } | null
  setTsProgress: (p: { step: number; total: number } | null) => void
  tsAbort: AbortController | null
  setTsRunning: (running: boolean, abort?: AbortController | null) => void
  /** Bumped to ask the bottom panel to open the Graph tab (e.g. after a
   *  time-series run completes). */
  graphTabSignal: number
  requestGraphTab: () => void

  setResult: (r: SolveResult) => void
  markStale: () => void
  setSolving: (b: boolean) => void
  setOverlay: (m: OverlayMode) => void
  setIssues: (issues: Issue[]) => void
  setFlash: (msg: string, kind?: 'error' | 'info', durationMs?: number) => void
}

let flashTimer: ReturnType<typeof setTimeout> | undefined

export const useResultsStore = create<ResultsState>((set) => ({
  result: null,
  fault: null,
  setFault: (fault) => set({ fault }),
  stale: false,
  solving: false,
  overlay: 'voltage',
  issues: [],
  flash: null,
  flashKind: 'error',
  autoSolve: false,
  setAutoSolve: (autoSolve) => set({ autoSolve }),

  analysisMode: 'snapshot',
  setAnalysisMode: (analysisMode) => set({ analysisMode }),
  tsIndex: null,
  setTsIndex: (tsIndex) =>
    set((s) => ({
      tsIndex,
      scrubResult:
        tsIndex != null && s.timeseries ? tsSlice(s.timeseries, tsIndex) : null,
    })),
  scrubResult: null,

  timeseries: null,
  // A fresh run lands with the scrubber parked at the system peak hour.
  setTimeseries: (timeseries) => {
    const tsIndex =
      timeseries?.summary != null
        ? tsIndexNearHour(timeseries, timeseries.summary.peakHour)
        : timeseries
          ? 0
          : null
    set({
      timeseries,
      tsIndex,
      scrubResult: timeseries && tsIndex != null ? tsSlice(timeseries, tsIndex) : null,
    })
  },
  tsRunning: false,
  tsProgress: null,
  setTsProgress: (tsProgress) => set({ tsProgress }),
  tsAbort: null,
  setTsRunning: (tsRunning, tsAbort = null) =>
    set({ tsRunning, tsAbort, ...(tsRunning ? {} : { tsProgress: null }) }),
  graphTabSignal: 0,
  requestGraphTab: () => set((s) => ({ graphTabSignal: s.graphTabSignal + 1 })),

  setResult: (result) => set({ result, stale: false }),
  markStale: () =>
    set({ stale: true, fault: null, timeseries: null, tsIndex: null, scrubResult: null }),
  setSolving: (solving) => set({ solving }),
  setOverlay: (overlay) => set({ overlay }),
  setIssues: (issues) => set({ issues }),
  setFlash: (msg, kind = 'error', durationMs = 4000) => {
    clearTimeout(flashTimer)
    set({ flash: msg, flashKind: kind })
    flashTimer = setTimeout(() => set({ flash: null }), durationMs)
  },
}))

/** What the canvas overlays should render: the scrubbed time-series step in
 *  time-series mode, the last snapshot solve otherwise. */
export function activeResult(s: ResultsState): SolveResult | null {
  return s.analysisMode === 'timeseries' ? s.scrubResult : s.result
}

/** Staleness for whatever activeResult returns. The scrubbed time-series
 *  view is never stale — any circuit edit clears the run outright — while
 *  the `stale` flag itself describes the last snapshot solve. (Without this
 *  distinction, editing the circuit and then running a time series left the
 *  overlays suppressed/dimmed by the snapshot's staleness.) */
export function activeStale(s: ResultsState): boolean {
  return s.analysisMode === 'timeseries' ? false : s.stale
}

/** Bus result for a node (its first terminal), respecting staleness. */
export function busForNode(state: ResultsState, nodeId: string) {
  const r = state.result
  if (!r || !r.converged) return null
  const bus = r.nodeBuses[nodeId]?.[0]
  return bus ? { bus, data: r.buses[bus] } : null
}

export function elementForId(state: ResultsState, diagramId: string) {
  const r = state.result
  if (!r || !r.converged) return null
  for (const [name, el] of Object.entries(r.elements)) {
    if (el.id === diagramId) return { name, data: el }
  }
  return null
}
