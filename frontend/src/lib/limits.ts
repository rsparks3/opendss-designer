import type { LimitsJSON, StudyInfoJSON } from '../types/circuit'

/** ANSI C84.1 Range A, and a line at its rating. The backend's
 *  core/model.Limits has the same defaults. */
export const DEFAULT_LIMITS: LimitsJSON = {
  vminPu: 0.95,
  vmaxPu: 1.05,
  overloadPct: 100,
  warnPct: 80,
  dutyMargin: 1,
  asymmetryFactor: 1,
}

/** The duty-screening multipliers, 1 when a project predates them. */
export function dutyFactors(l: LimitsJSON | null | undefined): { margin: number; asymmetry: number } {
  return { margin: l?.dutyMargin ?? 1, asymmetry: l?.asymmetryFactor ?? 1 }
}

export const EMPTY_STUDY: StudyInfoJSON = {
  title: '',
  caseName: '',
  engineer: '',
  company: '',
  description: '',
  sheet: false,
}

/** Whether a study block says anything worth saving. */
export function studyIsEmpty(s: StudyInfoJSON): boolean {
  return !s.sheet && !Object.values(s).some((v) => typeof v === 'string' && v.trim())
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
    a.warnPct === b.warnPct &&
    (a.dutyMargin ?? 1) === (b.dutyMargin ?? 1) &&
    (a.asymmetryFactor ?? 1) === (b.asymmetryFactor ?? 1)
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
  const { margin, asymmetry } = dutyFactors(l)
  if (!Number.isFinite(margin) || margin < 0.5 || margin > 3) return 'The duty margin must be between 0.5 and 3.'
  if (!Number.isFinite(asymmetry) || asymmetry < 1 || asymmetry > 3) return 'The asymmetry factor must be between 1 and 3.'
  return null
}

/** Compact wording for legends and report headers: "0.95–1.05 pu". */
export function fmtPu(v: number): string {
  return v.toFixed(3).replace(/0$/, '')
}
