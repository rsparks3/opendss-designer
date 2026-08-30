import { describe, expect, it } from 'vitest'
import type { TimeSeriesResult } from '../types/circuit'
import { tsIndexNearHour, tsSlice } from './tsSlice'

const ts = {
  converged: true,
  cancelled: false,
  mode: 'daily',
  stepMin: 60,
  steps: 3,
  downsampled: false,
  time: [1, 2, 3],
  totals: { kw: [100, 200, 150], lossKw: [1, 2, 1.5] },
  buses: {
    src: { vmin: [1, 1, 1], vmax: [1, 1.06, 1], kvBase: 7.2 },
    end: { vmin: [0.97, 0.94, 0.96], vmax: [0.99, 0.98, 0.99], kvBase: 7.2 },
  },
  elements: {
    'line.ln1': { id: 'e1', kw: [100, 200, 150], kvar: [10, 20, 15],
                  ampsMax: [50, 100, 75], loadingPct: [50, 101, 75] },
    'load.ld1': { id: 'n1', kw: [99, 199, 149], kvar: [9, 19, 14],
                  ampsMax: [50, 100, 75], loadingPct: [null, null, null] },
  },
  summary: null,
  nonConvergedSteps: [],
  issues: [],
  nodeBuses: { n1: ['end'] },
  lineBuses: { e1: ['src', 'end'] },
  busNames: {},
} as unknown as TimeSeriesResult

describe('tsSlice', () => {
  it('reshapes one recorded step as a SolveResult', () => {
    const r = tsSlice(ts, 1)!
    expect(r.converged).toBe(true)
    expect(r.buses.end.vminPu).toBe(0.94)
    expect(r.buses.end.vmaxPu).toBe(0.98)
    expect(r.buses.end.kvBase).toBe(7.2)
    expect(r.buses.end.violation).toBe('undervoltage')
    expect(r.buses.src.violation).toBe('overvoltage') // vmax 1.06
    expect(r.elements['line.ln1'].kw).toBe(200)
    expect(r.elements['line.ln1'].loadingPct).toBe(101)
    expect(r.elements['line.ln1'].violations).toEqual(['overload'])
    expect(r.elements['load.ld1'].loadingPct).toBeNull()
    expect(r.nodeBuses).toBe(ts.nodeBuses)
    expect(r.lineBuses).toBe(ts.lineBuses)
  })

  it('flags nothing when voltages are in band', () => {
    const r = tsSlice(ts, 0)!
    expect(r.buses.end.violation).toBeUndefined()
    expect(r.elements['line.ln1'].violations).toEqual([])
  })

  it('rejects out-of-range indices', () => {
    expect(tsSlice(ts, -1)).toBeNull()
    expect(tsSlice(ts, 3)).toBeNull()
  })
})

describe('tsIndexNearHour', () => {
  it('finds the closest recorded step', () => {
    expect(tsIndexNearHour(ts, 0)).toBe(0)
    expect(tsIndexNearHour(ts, 2.4)).toBe(1)
    expect(tsIndexNearHour(ts, 99)).toBe(2)
  })
})
