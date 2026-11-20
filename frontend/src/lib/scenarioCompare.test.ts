import { describe, expect, it } from 'vitest'
import type { BatchCell, BatchResult } from '../types/circuit'
import { compareTable } from './scenarioCompare'

const cell = (scenario: string | null, name: string, d: Partial<NonNullable<BatchCell['detail']>>): BatchCell => ({
  scenario, scenarioName: name, level: null, levelName: 'Rated', loadmult: 1, rating: 'normal', converged: true,
  iterations: 2, minVpu: 1, minVBus: null, maxVpu: 1, maxVBus: null, maxLoadingPct: 1, maxLoadingElement: null,
  maxLoadingId: null, lossKw: 1, sourceKw: 1, undervoltages: 0, overvoltages: 0, overloads: 0, loadingWarnings: 0,
  errors: [],
  detail: {
    busVmin: {}, loading: {}, unservedKw: { critical: 0, essential: 0, nonessential: 0, unassigned: 0 }, ...d,
  },
} as BatchCell)

const result: BatchResult = {
  scenarios: [{ id: null, name: 'Base case' }, { id: 'a', name: 'A' }],
  levels: [null],
  cancelled: false,
  solves: 2,
  cells: [
    cell(null, 'Base case', { busVmin: { b1: 1.0, b2: 0.98 }, loading: { x: 50, y: 10 } }),
    cell('a', 'A', {
      busVmin: { b1: 1.0, b2: 0.0 }, loading: { x: 90, y: 10 },
      unservedKw: { critical: 150, essential: 0, nonessential: 1200, unassigned: 0 },
    }),
  ],
}

describe('compareTable', () => {
  it('one column per scenario; worst per row; rows that differ most first', () => {
    const v = compareTable(result, null, 'voltage')
    expect(v.columns.map((c) => c.name)).toEqual(['Base case', 'A'])
    expect(v.rows[0]).toMatchObject({ label: 'b2', values: [0.98, 0], worst: 1 })
    expect(v.rows[1]).toMatchObject({ label: 'b1', worst: null })
    const l = compareTable(result, null, 'loading', (id) => id.toUpperCase())
    expect(l.rows[0]).toMatchObject({ label: 'X', elementId: 'x', worst: 1 })
    const u = compareTable(result, null, 'unserved')
    expect(u.rows.find((r) => r.key === 'critical')).toMatchObject({ values: [0, 150], worst: 1 })
    expect(u.rows.find((r) => r.key === 'total')!.values).toEqual([0, 1350])
  })
})
