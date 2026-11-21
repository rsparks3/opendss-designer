import { describe, expect, it } from 'vitest'
import type { TimeSeriesResult } from '../types/circuit'
import { probeSummary, spareAtPeak, timeSeriesPeaks, type HeadroomCell, type ProbeResult } from './headroom'

describe('headroom helpers', () => {
  it('takes the worst loading of a time-series run per element', () => {
    const ts = {
      elements: {
        'transformer.xf': { id: 'xf', kw: [], kvar: [], ampsMax: [], loadingPct: [40, null, 72, 65] },
        'line.l1': { id: 'l1', kw: [], kvar: [], ampsMax: [], loadingPct: [null, null] },
      },
    } as unknown as TimeSeriesResult
    expect(timeSeriesPeaks(ts)).toEqual({ xf: 72 })
    expect(timeSeriesPeaks(null)).toEqual({})
  })

  it('reads spare kVA at that peak on the snapshot rating', () => {
    const cell = { ratingKva: 500 } as HeadroomCell
    expect(spareAtPeak(cell, 60)).toBe(200)
    expect(spareAtPeak(cell, 110)).toBe(-50)
    expect(spareAtPeak(undefined, 60)).toBeNull()
  })

  it('says what bound and where', () => {
    const p: ProbeResult = {
      nodeId: 'lv', name: 'LV', bus: 'lv', kw: 190, kva: 200, binding: 'thermal',
      where: { element: 'transformer.xf', id: 'xf', value: 100.4 }, scenario: null, level: 'Rated', at: 0,
    }
    expect(probeSummary(p, () => 'XF')).toBe('up to 190 kW (200 kVA) more; thermal: XF reaches 100 % of its rating')
    expect(probeSummary({ ...p, binding: 'voltage', where: { bus: 'far', value: 0.9499 } }, () => null))
      .toBe('up to 190 kW (200 kVA) more; voltage: bus far falls to 0.950 pu')
  })
})
