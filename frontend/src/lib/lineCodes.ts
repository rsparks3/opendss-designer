import { create } from 'zustand'
import type { Params } from '../types/circuit'

/** Conductor preset library, served by the backend from config/linecodes.csv
 *  (user-editable; the server re-reads it per request, so a browser refresh
 *  picks up edits). Choosing a preset stamps its impedances into the line's
 *  params (still editable afterward), so the compiler/exporter keep working
 *  on plain r1/x1/r0/x0 — no LineCode entity round-trip needed. */
export interface LineCodePreset {
  code: string
  label: string
  units: string
  r1: number
  x1: number
  r0: number
  x0: number
  normamps: number
}

interface LineCodeState {
  presets: LineCodePreset[]
  setPresets: (presets: LineCodePreset[]) => void
}

export const useLineCodeStore = create<LineCodeState>((set) => ({
  presets: [],
  setPresets: (presets) => set({ presets }),
}))

/** Fetch the library once at startup (failures leave the dropdown empty —
 *  lines still work with manual R/X entry). */
export async function loadLineCodes(): Promise<void> {
  try {
    const res = await fetch('/api/linecodes')
    if (!res.ok) return
    const data = (await res.json()) as { lineCodes?: LineCodePreset[]; errors?: string[] }
    useLineCodeStore.getState().setPresets(data.lineCodes ?? [])
    if (data.errors?.length) {
      console.warn('config/linecodes.csv issues:', data.errors)
    }
  } catch {
    // backend unreachable — presets simply unavailable
  }
}

const IMPEDANCE_KEYS = ['r1', 'x1', 'r0', 'x0', 'normamps'] as const

/** Params patch that applies a preset to a line. */
export function presetPatch(code: string): Params | null {
  const p = useLineCodeStore.getState().presets.find((c) => c.code === code)
  if (!p) return null
  return {
    linecode: p.code,
    units: p.units,
    r1: p.r1,
    x1: p.x1,
    r0: p.r0,
    x0: p.x0,
    normamps: p.normamps,
  }
}

/** A manual edit of any impedance field detaches the line from its preset. */
export function detachesPreset(patch: Params): boolean {
  return IMPEDANCE_KEYS.some((k) => k in patch)
}
