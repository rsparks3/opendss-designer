import { beforeEach, describe, expect, it } from 'vitest'
import { detachesPreset, presetPatch, useLineCodeStore, type LineCodePreset } from './lineCodes'

const PRESETS: LineCodePreset[] = [
  { code: 'test-oh', label: 'Test OH', units: 'km', r1: 0.19, x1: 0.45, r0: 0.37, x0: 1.44, normamps: 530 },
  { code: 'test-ug', label: 'Test UG', units: 'mi', r1: 0.28, x1: 0.14, r0: 0.6, x0: 0.44, normamps: 260 },
]

beforeEach(() => useLineCodeStore.setState({ presets: PRESETS }))

describe('line code presets', () => {
  it('stamps every impedance field, the units, and the reference tag', () => {
    const patch = presetPatch('test-ug')!
    expect(patch.linecode).toBe('test-ug')
    expect(patch.units).toBe('mi') // per-row units honored
    expect(patch).toMatchObject({ r1: 0.28, x1: 0.14, r0: 0.6, x0: 0.44, normamps: 260 })
  })

  it('returns null for an unknown code', () => {
    expect(presetPatch('bogus')).toBeNull()
  })

  it('returns null when the library has not loaded', () => {
    useLineCodeStore.setState({ presets: [] })
    expect(presetPatch('test-oh')).toBeNull()
  })

  it('detachesPreset flags impedance edits but not cosmetic ones', () => {
    expect(detachesPreset({ r1: 0.2 })).toBe(true)
    expect(detachesPreset({ normamps: 500 })).toBe(true)
    expect(detachesPreset({ name: 'LN9', length: 3 })).toBe(false)
  })
})
