import { describe, expect, it } from 'vitest'
import { loadingColor, LOW_V, OK, VIOLATION, voltageColor, WARN } from './colorScale'
import { legendFor } from './exportDiagram'
import { DEFAULT_LIMITS, fmtPu, limitsOf, limitsProblem } from './limits'
import { tsSlice } from './tsSlice'
import type { TimeSeriesResult } from '../types/circuit'

const tight = { vminPu: 0.97, vmaxPu: 1.03, overloadPct: 90, warnPct: 60 }

describe('limits', () => {
  it('falls back to the defaults', () => {
    expect(limitsOf(null)).toBe(DEFAULT_LIMITS)
    expect(limitsOf(tight)).toBe(tight)
  })

  it('colours by the limits it is given', () => {
    expect(voltageColor(0.96)).toBe(OK)
    expect(voltageColor(0.96, tight)).toBe(LOW_V)
    expect(voltageColor(1.04, tight)).toBe(VIOLATION)
    expect(loadingColor(70)).toBe(OK)
    expect(loadingColor(70, tight)).toBe(WARN)
    expect(loadingColor(95, tight)).toBe(VIOLATION)
  })

  it('writes the limits into the export legend', () => {
    expect(legendFor('voltage', tight).map((e) => e.label)).toEqual([
      '< 0.97 pu', '0.97–1.03 pu', '> 1.03 pu', 'de-energised',
    ])
    expect(legendFor('loading', tight).map((e) => e.label)).toEqual(['< 60 %', '60–90 %', '≥ 90 %'])
  })

  it('refuses limits that contradict each other', () => {
    expect(limitsProblem(DEFAULT_LIMITS)).toBeNull()
    expect(limitsProblem({ ...DEFAULT_LIMITS, vminPu: 1.1 })).toMatch(/below the overvoltage/)
    expect(limitsProblem({ ...DEFAULT_LIMITS, warnPct: 120 })).toMatch(/warning/)
    expect(limitsProblem({ ...DEFAULT_LIMITS, vmaxPu: NaN })).toMatch(/positive/)
  })

  it('formats per-unit values without trailing noise', () => {
    expect(fmtPu(0.95)).toBe('0.95')
    expect(fmtPu(1.05)).toBe('1.05')
    expect(fmtPu(0.975)).toBe('0.975')
  })

  it('flags time-series slices by the limits', () => {
    const ts = {
      time: [0],
      buses: { b1: { vmin: [0.96], vmax: [0.99], kvBase: 7.2 } },
      elements: { 'line.l1': { id: 'l1', kw: [1], kvar: [0], ampsMax: [1], loadingPct: [95] } },
      nodeBuses: {},
      lineBuses: {},
      busNames: {},
    } as unknown as TimeSeriesResult
    expect(tsSlice(ts, 0)!.buses.b1.violation).toBeUndefined()
    expect(tsSlice(ts, 0)!.elements['line.l1'].violations).toEqual([])
    const flagged = tsSlice(ts, 0, tight)!
    expect(flagged.buses.b1.violation).toBe('undervoltage')
    expect(flagged.elements['line.l1'].violations).toEqual(['overload'])
  })
})
