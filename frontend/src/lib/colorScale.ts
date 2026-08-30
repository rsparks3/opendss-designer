// Result color coding shared by node badges and edge strokes.

export const OK = '#2e7d32'
export const WARN = '#ed6c02'
export const VIOLATION = '#d32f2f'
export const LOW_V = '#0277bd'
export const NEUTRAL = '#546e7a'

export function voltageColor(vPu: number | null | undefined): string {
  if (vPu == null) return NEUTRAL
  if (vPu < 0.5) return NEUTRAL // de-energized
  if (vPu < 0.95) return LOW_V
  if (vPu > 1.05) return VIOLATION
  return OK
}

export function loadingColor(pct: number | null | undefined): string {
  if (pct == null) return NEUTRAL
  if (pct >= 100) return VIOLATION
  if (pct >= 80) return WARN
  return OK
}
