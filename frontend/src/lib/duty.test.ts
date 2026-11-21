import { describe, expect, it } from 'vitest'
import type { DutyRow } from '../types/circuit'
import { dutyBadgeText, dutyTooltip, primaryRating } from './duty'
import { dutyFactors, limitsProblem, sameLimits, DEFAULT_LIMITS } from './limits'

const row = (more: Partial<DutyRow> = {}): DutyRow => ({
  id: 'b', name: 'BRK', kind: 'breaker', bus: 'b', faultA3ph: 9700, faultA1ph: 10400, governing: '1ph', dutyA: 10400,
  checks: { interrupting: { ratingKa: 10, status: 'fail', ratio: 1.04 }, withstand: { ratingKa: null, status: 'unrated', ratio: null } },
  status: 'fail', ...more,
})

describe('duty wording', () => {
  it('shows duty against the rating, or unrated', () => {
    expect(dutyBadgeText(row())).toBe('10.4 / 10 kA')
    expect(dutyBadgeText(row({ checks: { interrupting: { ratingKa: null, status: 'unrated', ratio: null } } }))).toBe('unrated')
    expect(primaryRating(row({ kind: 'busbar', checks: { bracing: { ratingKa: 40, status: 'pass', ratio: 0.26 } } }))).toBe(40)
  })

  it('says which fault governs, the factors and that it is a screening', () => {
    const t = dutyTooltip(row(), { dutyMargin: 1.1, asymmetryFactor: 1.25 })
    expect(t).toContain('ground governs')
    expect(t).toContain('× 1.25 asymmetry')
    expect(t).toContain('with the 1.1 margin')
    expect(t).toContain('not an ANSI C37')
  })
})

describe('duty limits', () => {
  it('default to 1 for projects that predate them, and are range-checked', () => {
    expect(dutyFactors({ vminPu: 0.95, vmaxPu: 1.05, overloadPct: 100, warnPct: 80 })).toEqual({ margin: 1, asymmetry: 1 })
    expect(sameLimits({ vminPu: 0.95, vmaxPu: 1.05, overloadPct: 100, warnPct: 80 }, DEFAULT_LIMITS)).toBe(true)
    expect(limitsProblem({ ...DEFAULT_LIMITS, dutyMargin: 0.2 })).toMatch(/duty margin/)
    expect(limitsProblem({ ...DEFAULT_LIMITS, asymmetryFactor: 0.9 })).toMatch(/asymmetry/)
    expect(limitsProblem({ ...DEFAULT_LIMITS, dutyMargin: 1.1, asymmetryFactor: 1.25 })).toBeNull()
  })
})
