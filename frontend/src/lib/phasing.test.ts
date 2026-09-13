import { describe, expect, it } from 'vitest'
import { effectivePhasing, parsePhasing, phaseCount, phaseLabel } from './phasing'

describe('parsePhasing', () => {
  it('normalises case and order', () => {
    expect(parsePhasing('b')).toBe('B')
    expect(parsePhasing('ca')).toBe('AC')
    expect(parsePhasing('A-B')).toBe('AB')
  })
  it('rejects what it cannot say', () => {
    expect(parsePhasing('')).toBeNull()
    expect(parsePhasing('D')).toBeNull()
    expect(parsePhasing('AA')).toBeNull()
    expect(parsePhasing(2)).toBeNull()
    // Not 'B': a pin picked out of arbitrary text would be a confident guess.
    expect(parsePhasing('bogus')).toBeNull()
    expect(parsePhasing(undefined)).toBeNull()
  })
})

describe('phaseCount', () => {
  it('clamps to what OpenDSS accepts', () => {
    expect(phaseCount({ phases: 1 })).toBe(1)
    expect(phaseCount({ phases: 9 })).toBe(3)
    expect(phaseCount({ phases: 0 })).toBe(1)
    expect(phaseCount({ phases: '2' })).toBe(2)
    expect(phaseCount({})).toBe(3)
    expect(phaseCount(undefined)).toBe(3)
  })
})

describe('effectivePhasing', () => {
  it('falls back to the first N phases, the way the engine does', () => {
    expect(effectivePhasing({ phases: 1 })).toBe('A')
    expect(effectivePhasing({ phases: 2 })).toBe('AB')
    expect(effectivePhasing({ phases: 3 })).toBe('ABC')
  })
  it('prefers the pin', () => {
    expect(effectivePhasing({ phases: 1, phasing: 'C' })).toBe('C')
    expect(effectivePhasing({ phases: 1, phasing: 'nonsense' })).toBe('A')
  })
})

describe('phaseLabel', () => {
  it('stays quiet for a full 3-phase element', () => {
    expect(phaseLabel({ phases: 3 })).toBeNull()
    expect(phaseLabel({ phases: 3, phasing: 'ABC' })).toBeNull()
  })
  it('names a lateral', () => {
    expect(phaseLabel({ phases: 1, phasing: 'B' })).toBe('B')
    expect(phaseLabel({ phases: 1 })).toBe('A')
    expect(phaseLabel({ phases: 2, phasing: 'BC' })).toBe('B-C')
  })
})
