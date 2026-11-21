import type { Params } from '../types/circuit'

/** Generator and battery sizing against an island (studies/sizing.py). */

export interface SizingOptions {
  elementId: string
  shape: string | null
  mode: 'daily' | 'yearly'
  marginPct: number
  countPv: boolean
  generatorKw: number | null
  efficiencyPct: number
  reservePct: number
  verify: boolean
}

export interface SizingResult {
  ok: boolean
  elementId: string
  elementName: string
  mode: 'daily' | 'yearly'
  hours: number
  islandBus: string | null
  islandKv: number
  loads: number
  pvCount: number
  profile: { loadKw: number[]; pvKw: number[]; netKw: number[] }
  generator: {
    requiredKw: number
    peakNetKw: number
    peakHour: number
    marginPct: number
    chosenKw: number
    hoursAbove80: number
    existing: { id: string; name: string; fuelHours?: number | null }[]
  }
  battery: {
    kw: number
    kwh: number
    usableKwh: number
    drawdownKwh: number
    drawdownFrom: number
    drawdownTo: number
    efficiencyPct: number
    reservePct: number
    energyBalanceKwh: number
    cycleCloses: boolean
    emptiesAfterHours: number | null
    dispatchKw: number[]
  }
  reversePowerHours: number[]
  reversePowerCount: number
  verification: null | {
    ran: boolean
    why?: string
    converged?: boolean
    passed?: boolean
    generatorKva?: number
    maxGenLoadingPct?: number
    minSocPct?: number | null
    reverseHours?: number
    /** Carried through the day from a full battery, but the day is short of energy. */
    oneDayOnly?: boolean
    hours?: { hour: number; genKw: number; genLoadingPct: number; socPct: number | null }[]
  }
  issues: { severity: string; message: string }[]
}

export const GEN_PF = 0.8

/** The new units a result asks for, as element params: a standby generator
 *  rated at its kW / 0.8, and a battery following the computed dispatch
 *  (`shape` names the loadshape that carries it). */
export function sizedUnits(r: SizingResult, shape: string | null): { generator: Params | null; storage: Params | null } {
  const generator = r.generator.chosenKw > 0
    ? {
        name: `GEN ${r.elementName}`.slice(0, 40), kv: r.islandKv, kw: r.generator.chosenKw,
        kva: Math.round((r.generator.chosenKw / GEN_PF) * 10) / 10, pf: 0.9, phases: 3, standby: true,
        islandMode: 'grid', enabled: false,
      }
    : null
  const storage = r.battery.kwh > 0
    ? {
        name: `BESS ${r.elementName}`.slice(0, 40), kv: r.islandKv, kwrated: r.battery.kw, kwhrated: r.battery.kwh,
        soc: 100, reserve: r.battery.reservePct, phases: 3,
        ...(shape ? { dispatch: 'follow', loadshape: shape } : {}),
      }
    : null
  return { generator, storage }
}

/** The dispatch as a loadshape: kW over the battery's rating, + discharging. */
export function dispatchShape(r: SizingResult): number[] {
  return r.battery.kw > 0 ? r.battery.dispatchKw.map((d) => Math.round((d / r.battery.kw) * 1e4) / 1e4) : []
}

/** "08:00" for an hour of the day; "day 12, 08:00" over a year. */
export function hourLabel(h: number, yearly: boolean): string {
  const hh = `${String(h % 24).padStart(2, '0')}:00`
  return yearly ? `day ${Math.floor(h / 24) + 1}, ${hh}` : hh
}
