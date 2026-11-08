import { describe, expect, it } from 'vitest'
import type { SolveResult } from '../types/circuit'
import { compareResults } from './compare'

function solve(v: Record<string, number>, loading: Record<string, number>, lossKw: number): SolveResult {
  return {
    converged: true,
    iterations: 3,
    buses: Object.fromEntries(
      Object.entries(v).map(([b, pu]) => [b, { vmagPu: [pu], vangDeg: [0], vminPu: pu, vmaxPu: pu, kvBase: 7.2, nodes: [1], ...(pu < 0.95 ? { violation: 'undervoltage' } : {}) }]),
    ),
    elements: Object.fromEntries(
      Object.entries(loading).map(([e, pct]) => [
        e,
        { id: `id-${e}`, currents: [1], kw: pct * 10, kvar: 0, normAmps: 100, loadingPct: pct, violations: pct >= 100 ? ['overload'] : [], lossKw: pct / 100, lossKvar: 0 },
      ]),
    ),
    losses: { kw: lossKw, kvar: 0 },
    issues: [],
    nodeBuses: { n1: ['b1'], n2: ['b2'] },
    lineBuses: {},
    busNames: { b1: 'Main' },
    busDistances: {},
  }
}

describe('compareResults', () => {
  it('lists changes largest first and totals the headline numbers', () => {
    const before = solve({ b1: 1.0, b2: 0.97, b3: 0.99 }, { 'line.a': 50, 'line.b': 80 }, 10)
    const after = solve({ b1: 1.0, b2: 0.94, b4: 1.01 }, { 'line.a': 50, 'line.b': 101 }, 12)
    const cmp = compareResults(before, after)
    expect(cmp.lossKw).toBeCloseTo(2)
    expect(cmp.minV).toBeCloseTo(0.94 - 0.97)
    expect(cmp.maxLoading).toBeCloseTo(21)
    expect(cmp.violationsBefore).toBe(0)
    expect(cmp.violationsAfter).toBe(2)
    const changed = cmp.buses.filter((r) => r.changed)
    expect(changed.map((r) => r.key)).toEqual(['bus:b2', 'bus:b3', 'bus:b4'])
    expect(cmp.buses[0].delta).toBeCloseTo(-0.03)
    expect(cmp.buses[0].flag).toBe('violation')
    expect(cmp.buses.find((r) => r.key === 'bus:b3')!.status).toBe('gone')
    expect(cmp.buses.find((r) => r.key === 'bus:b4')!.status).toBe('new')
    expect(cmp.buses.find((r) => r.key === 'bus:b1')!.label).toBe('Main')
    expect(cmp.buses.find((r) => r.key === 'bus:b1')!.id).toBe('n1')
    const el = cmp.elements.find((r) => r.key === 'el:line.b')!
    expect(el.changed).toBe(true)
    expect(el.delta).toBeCloseTo(21)
    expect(el.deltaKw).toBeCloseTo(210)
    expect(el.id).toBe('id-line.b')
    expect(cmp.elements.find((r) => r.key === 'el:line.a')!.changed).toBe(false)
  })
})
