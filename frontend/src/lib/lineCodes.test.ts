import { describe, expect, it } from 'vitest'
import { detachesPreset, LINE_CODE_PRESETS, presetPatch } from './lineCodes'

describe('line code presets', () => {
  it('stamps every impedance field plus the reference tag', () => {
    const patch = presetPatch('acsr-336')!
    expect(patch.linecode).toBe('acsr-336')
    expect(patch.units).toBe('km')
    for (const k of ['r1', 'x1', 'r0', 'x0', 'normamps']) {
      expect(typeof patch[k]).toBe('number')
    }
  })

  it('returns null for an unknown code', () => {
    expect(presetPatch('bogus')).toBeNull()
  })

  it('every preset has physically sane values', () => {
    for (const p of LINE_CODE_PRESETS) {
      expect(p.r1).toBeGreaterThan(0)
      expect(p.x1).toBeGreaterThan(0)
      expect(p.r0).toBeGreaterThanOrEqual(p.r1) // zero-seq resistance ≥ positive-seq
      expect(p.normamps).toBeGreaterThan(0)
    }
  })

  it('detachesPreset flags impedance edits but not cosmetic ones', () => {
    expect(detachesPreset({ r1: 0.2 })).toBe(true)
    expect(detachesPreset({ normamps: 500 })).toBe(true)
    expect(detachesPreset({ name: 'LN9', length: 3 })).toBe(false)
  })
})
