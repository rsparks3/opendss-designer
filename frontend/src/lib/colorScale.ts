// Result color coding shared by node badges and edge strokes.
import type { LimitsJSON } from '../types/circuit'
import { DEFAULT_LIMITS } from './limits'

export const OK = '#2e7d32'
export const WARN = '#ed6c02'
export const VIOLATION = '#d32f2f'
export const LOW_V = '#0277bd'
export const NEUTRAL = '#546e7a'

export function voltageColor(vPu: number | null | undefined, limits: LimitsJSON = DEFAULT_LIMITS): string {
  if (vPu == null) return NEUTRAL
  if (vPu < 0.5) return NEUTRAL // de-energized
  if (vPu < limits.vminPu) return LOW_V
  if (vPu > limits.vmaxPu) return VIOLATION
  return OK
}

export function loadingColor(pct: number | null | undefined, limits: LimitsJSON = DEFAULT_LIMITS): string {
  if (pct == null) return NEUTRAL
  if (pct >= limits.overloadPct) return VIOLATION
  if (pct >= limits.warnPct) return WARN
  return OK
}
