import { describe, expect, it } from 'vitest'
import campusJson from '../../../src/opendss_designer/samples/installation-campus.oneline.json'
import { fromCircuitJSON } from '../store/circuitStore'
import type { CircuitJSON } from '../types/circuit'
import { allocatedLoads, demandFactor, parseFactors } from './allocation'

const campus = fromCircuitJSON(campusJson as unknown as CircuitJSON)

describe('allocations on the drawing', () => {
  it('scales the zone below the meter, skips fixed loads, and refuses an overlapping zone', () => {
    const nodes = campus.nodes.map((n) => (n.id === 'ld_clinic' ? { ...n, data: { ...n.data, params: { ...n.data.params, fixed: true } } } : n))
    const m = allocatedLoads(nodes, campus.edges, [
      { id: 'f1', meterElementId: 'brk_f1', targetKW: 1000, lastFactor: 0.9 },
      { id: 'all', meterElementId: 'brk_m', targetKW: 4000, lastFactor: 1.1 }, // overlaps f1: skipped
      { id: 'f3', meterElementId: 'brk_f3', targetKW: 1500, lastFactor: 1.2, demandFactors: { nonessential: 0.5 } },
      { id: 'notrun', meterElementId: 'brk_f2', targetKW: 1500 },
    ])
    expect(m.get('ld_hosp')).toEqual({ factor: 0.9, allocation: 'f1' })
    expect(m.has('ld_clinic')).toBe(false)
    expect(m.get('ld_hous')!.factor).toBeCloseTo(0.6)
    expect(m.get('ld_school')!.factor).toBeCloseTo(1.2)
    expect(m.has('ld_ops')).toBe(false)
  })

  it('parses demand factors and matches them by priority or tag', () => {
    expect(parseFactors('nonessential=0.8, hvac = 0.9; junk')).toEqual({ nonessential: 0.8, hvac: 0.9 })
    expect(parseFactors('')).toBeNull()
    expect(demandFactor({ priority: 'nonessential', tags: ['hvac'] }, { nonessential: 0.8, hvac: 0.5 })).toBeCloseTo(0.4)
  })
})
