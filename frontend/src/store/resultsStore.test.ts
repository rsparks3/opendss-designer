import { beforeEach, describe, expect, it } from 'vitest'
import type { SolveResult, TimeSeriesResult } from '../types/circuit'
import { activeResult, activeStale, useResultsStore } from './resultsStore'

const ts = {
  converged: true,
  cancelled: false,
  mode: 'daily',
  stepMin: 60,
  steps: 3,
  downsampled: false,
  time: [1, 2, 3],
  totals: { kw: [100, 200, 150], lossKw: [1, 2, 1.5] },
  buses: { end: { vmin: [0.97, 0.94, 0.96], vmax: [0.99, 0.98, 0.99], kvBase: 7.2 } },
  elements: {
    'line.ln1': { id: 'e1', kw: [100, 200, 150], kvar: [10, 20, 15],
                  ampsMax: [50, 100, 75], loadingPct: [50, 99, 75] },
  },
  summary: { energyKwh: 1, lossesKwh: 0, peakKw: 200, peakHour: 2,
             minVpu: null, maxVpu: null },
  nonConvergedSteps: [],
  issues: [],
  nodeBuses: {},
  lineBuses: {},
  busNames: {},
} as unknown as TimeSeriesResult

const snapshot = { converged: true } as SolveResult

beforeEach(() => {
  useResultsStore.setState({
    result: null, stale: false, timeseries: null, tsIndex: null,
    scrubResult: null, analysisMode: 'snapshot',
  })
})

describe('time-series scrub state', () => {
  it('setTimeseries parks the scrubber at the peak hour with a scrub slice', () => {
    useResultsStore.getState().setTimeseries(ts)
    const s = useResultsStore.getState()
    expect(s.tsIndex).toBe(1) // time[1] === peakHour 2
    expect(s.scrubResult?.elements['line.ln1'].loadingPct).toBe(99)
  })

  it('markStale clears the run, its scrub position, and the slice', () => {
    useResultsStore.getState().setTimeseries(ts)
    useResultsStore.getState().markStale()
    const s = useResultsStore.getState()
    expect(s.timeseries).toBeNull()
    expect(s.tsIndex).toBeNull()
    expect(s.scrubResult).toBeNull()
    expect(s.stale).toBe(true)
  })

  it('activeResult follows the analysis mode', () => {
    useResultsStore.setState({ result: snapshot })
    useResultsStore.getState().setTimeseries(ts)
    expect(activeResult(useResultsStore.getState())).toBe(snapshot)
    useResultsStore.getState().setAnalysisMode('timeseries')
    expect(activeResult(useResultsStore.getState())?.elements['line.ln1']).toBeDefined()
  })

  it('a fresh time-series run is never stale, even after a circuit edit', () => {
    // Regression: edit circuit (markStale) -> run time series -> the snapshot
    // stale flag must not suppress the scrubbed overlays (loading pies etc.).
    useResultsStore.getState().markStale()
    useResultsStore.getState().setTimeseries(ts)
    useResultsStore.getState().setAnalysisMode('timeseries')
    const s = useResultsStore.getState()
    expect(s.stale).toBe(true) // snapshot view genuinely is stale
    expect(activeStale(s)).toBe(false) // ...but the scrub view is fresh
    useResultsStore.getState().setAnalysisMode('snapshot')
    expect(activeStale(useResultsStore.getState())).toBe(true)
  })
})
