import { describe, expect, it } from 'vitest'
import type { Params, Winding } from '../types/circuit'
import { windingGet, windingPatch } from './fields'

const params: Params = {
  name: 'T1',
  windings: [
    { kv: 115, kva: 10000, conn: 'delta' },
    { kv: 12.47, kva: 10000, conn: 'wye' },
  ] satisfies Winding[],
}

describe('windingGet', () => {
  it('resolves w<i>.<field> keys into the windings array', () => {
    expect(windingGet(params, 'w0.kv')).toBe(115)
    expect(windingGet(params, 'w1.conn')).toBe('wye')
  })

  it('passes plain keys through', () => {
    expect(windingGet(params, 'name')).toBe('T1')
  })

  it('returns undefined for a winding that does not exist', () => {
    expect(windingGet(params, 'w5.kv')).toBeUndefined()
    expect(windingGet({}, 'w0.kv')).toBeUndefined()
  })
})

describe('windingPatch', () => {
  it('patches only the addressed winding, immutably', () => {
    const patch = windingPatch(params, 'w1.kv', 4.16)
    const windings = patch.windings as Winding[]
    expect(windings[1].kv).toBe(4.16)
    expect(windings[0]).toEqual({ kv: 115, kva: 10000, conn: 'delta' })
    // original untouched
    expect((params.windings as Winding[])[1].kv).toBe(12.47)
  })

  it('turns a plain key into a simple patch object', () => {
    expect(windingPatch(params, 'xhl', 8.5)).toEqual({ xhl: 8.5 })
  })
})

describe('windingPatch', () => {
  const params = {
    name: 'T1',
    windings: [
      { kv: 115, kva: 10000, conn: 'delta' },
      { kv: 12.47, kva: 10000, conn: 'wye' },
    ],
  }
  it('edits one winding and leaves the rest alone', () => {
    const patch = windingPatch(params, 'w1.kv', 13.2) as { windings: { kv: number }[] }
    expect(patch.windings.map((w) => w.kv)).toEqual([115, 13.2])
  })
  it('does nothing for a winding the transformer does not have', () => {
    // The spreadsheet shows a tertiary column for every transformer; a
    // two-winding unit must not grow a half-made third winding from it.
    expect(windingPatch(params, 'w2.kv', 4.16)).toEqual({})
  })
  it('passes plain keys through', () => {
    expect(windingPatch(params, 'xhl', 9)).toEqual({ xhl: 9 })
  })
})
