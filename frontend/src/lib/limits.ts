import type { LimitsJSON, StudyInfoJSON } from '../types/circuit'

/** ANSI C84.1 Range A, and a line at its rating. The backend's
 *  core/model.Limits has the same defaults. */
export const DEFAULT_LIMITS: LimitsJSON = {
  vminPu: 0.95,
  vmaxPu: 1.05,
  overloadPct: 100,
  warnPct: 80,
}

export const EMPTY_STUDY: StudyInfoJSON = {
  title: '',
  caseName: '',
  engineer: '',
  company: '',
  description: '',
}

/** The limits a circuit applies: its own, or the defaults. */
export function limitsOf(limits: LimitsJSON | null | undefined): LimitsJSON {
  return limits ?? DEFAULT_LIMITS
}

export function sameLimits(a: LimitsJSON, b: LimitsJSON): boolean {
  return (
    a.vminPu === b.vminPu &&
    a.vmaxPu === b.vmaxPu &&
    a.overloadPct === b.overloadPct &&
    a.warnPct === b.warnPct
  )
}

/** Why a set of limits cannot be used, or null when it can. */
export function limitsProblem(l: LimitsJSON): string | null {
  const nums = [l.vminPu, l.vmaxPu, l.overloadPct, l.warnPct]
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return 'Every limit must be a positive number.'
  if (l.vminPu >= l.vmaxPu) return 'The undervoltage limit must be below the overvoltage limit.'
  if (l.vmaxPu >= 2) return 'Voltage limits are in per unit, below 2.'
  if (l.warnPct > l.overloadPct) return 'The warning level cannot be above the overload level.'
  if (l.overloadPct > 1000) return 'Loading limits are percentages, at most 1000.'
  return null
}

/** Compact wording for legends and report headers: "0.95–1.05 pu". */
export function fmtPu(v: number): string {
  return v.toFixed(3).replace(/0$/, '')
}
