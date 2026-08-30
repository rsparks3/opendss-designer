import type { Params } from '../types/circuit'

/** Built-in conductor library: choosing a preset stamps its impedances into
 *  the line's params (still editable afterward), so the compiler/exporter
 *  keep working on plain r1/x1/r0/x0 — no LineCode entity round-trip needed.
 *
 *  Values are REPRESENTATIVE ohms/km for typical distribution construction
 *  (overhead: flat crossarm ~4 ft spacing; UG: 3-1/c XLPE cable, trefoil) —
 *  fine for planning studies, replace with utility data for anything real. */
export interface LineCodePreset {
  code: string
  label: string
  r1: number
  x1: number
  r0: number
  x0: number
  normamps: number
}

export const LINE_CODE_PRESETS: LineCodePreset[] = [
  { code: 'acsr-1/0', label: 'OH ACSR 1/0 (Raven)', r1: 0.696, x1: 0.494, r0: 0.874, x0: 1.482, normamps: 230 },
  { code: 'acsr-4/0', label: 'OH ACSR 4/0 (Penguin)', r1: 0.35, x1: 0.468, r0: 0.528, x0: 1.456, normamps: 340 },
  { code: 'acsr-336', label: 'OH ACSR 336.4 (Linnet)', r1: 0.19, x1: 0.451, r0: 0.368, x0: 1.439, normamps: 530 },
  { code: 'acsr-556', label: 'OH ACSR 556.5 (Dove)', r1: 0.118, x1: 0.427, r0: 0.296, x0: 1.415, normamps: 730 },
  { code: 'acsr-795', label: 'OH ACSR 795 (Drake)', r1: 0.084, x1: 0.412, r0: 0.262, x0: 1.4, normamps: 900 },
  { code: 'ug-1/0-al', label: 'UG XLPE 1/0 Al', r1: 0.552, x1: 0.156, r0: 1.06, x0: 0.52, normamps: 175 },
  { code: 'ug-4/0-al', label: 'UG XLPE 4/0 Al', r1: 0.277, x1: 0.14, r0: 0.6, x0: 0.44, normamps: 260 },
  { code: 'ug-750-al', label: 'UG XLPE 750 Al', r1: 0.081, x1: 0.122, r0: 0.28, x0: 0.35, normamps: 475 },
]

const IMPEDANCE_KEYS = ['r1', 'x1', 'r0', 'x0', 'normamps'] as const

/** Params patch that applies a preset to a line (impedances in Ω/km). */
export function presetPatch(code: string): Params | null {
  const p = LINE_CODE_PRESETS.find((c) => c.code === code)
  if (!p) return null
  return { linecode: p.code, units: 'km', r1: p.r1, x1: p.x1, r0: p.r0, x0: p.x0, normamps: p.normamps }
}

/** A manual edit of any impedance field detaches the line from its preset. */
export function detachesPreset(patch: Params): boolean {
  return IMPEDANCE_KEYS.some((k) => k in patch)
}
