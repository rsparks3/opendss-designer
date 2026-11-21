import { describe, expect, it } from 'vitest'
import { sizingSvg } from './report/charts'
import { dispatchShape, hourLabel, sizedUnits, type SizingResult } from './sizing'

const result = (more: Partial<SizingResult['battery']> = {}): SizingResult => ({
  ok: true, elementId: 'brk', elementName: '52-F1', mode: 'daily', hours: 24, islandBus: 'b', islandKv: 13.2,
  loads: 2, pvCount: 1,
  profile: { loadKw: Array(24).fill(100), pvKw: Array(24).fill(0).map((_, h) => (h >= 8 && h < 16 ? 50 : 0)), netKw: Array(24).fill(0).map((_, h) => (h >= 8 && h < 16 ? 50 : 100)) },
  generator: { requiredKw: 120, peakNetKw: 100, peakHour: 0, marginPct: 20, chosenKw: 90, hoursAbove80: 16, existing: [] },
  battery: {
    kw: 40, kwh: 222.2, usableKwh: 177.8, drawdownKwh: 160, drawdownFrom: 16, drawdownTo: 32, efficiencyPct: 90, reservePct: 20,
    energyBalanceKwh: 128, cycleCloses: true, emptiesAfterHours: null,
    dispatchKw: Array(24).fill(0).map((_, h) => (h >= 8 && h < 16 ? -40 : 10)), ...more,
  },
  reversePowerHours: [], reversePowerCount: 0, verification: null, issues: [],
})

describe('backup sizing', () => {
  it('turns the sizes into a standby generator and a following battery', () => {
    const { generator, storage } = sizedUnits(result(), 'backup_dispatch')
    expect(generator).toMatchObject({ kw: 90, kva: 112.5, standby: true, enabled: false, kv: 13.2 })
    expect(storage).toMatchObject({ kwrated: 40, kwhrated: 222.2, reserve: 20, dispatch: 'follow', loadshape: 'backup_dispatch' })
    expect(sizedUnits(result({ kwh: 0, kw: 0 }), null).storage).toBeNull()
  })

  it('writes the dispatch as a share of the battery rating, + discharging', () => {
    const shape = dispatchShape(result())
    expect(shape).toHaveLength(24)
    expect(shape[0]).toBe(0.25)
    expect(shape[10]).toBe(-1)
  })

  it('labels hours and draws the chart', () => {
    expect(hourLabel(8, false)).toBe('08:00')
    expect(hourLabel(24 * 11 + 8, true)).toBe('day 12, 08:00')
    const svg = sizingSvg(result())
    expect(svg).toContain('<svg')
    expect(svg).toContain('Net load')
  })
})
