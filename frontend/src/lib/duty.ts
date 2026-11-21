import type { DutyResult, DutyRow, DutyStatus } from '../types/circuit'

/** Equipment duty screening (studies/duty.py): colours and wording. */

export const DUTY_COLORS: Record<DutyStatus, string> = {
  pass: '#2e7d32',
  fail: '#c62828',
  unrated: '#9e9e9e',
  unknown: '#9e9e9e',
}

export function dutyRow(duty: DutyResult | null | undefined, id: string): DutyRow | undefined {
  return duty?.converged ? duty.rows.find((r) => r.id === id) : undefined
}

const kA = (a: number | null | undefined) => (a == null ? '—' : `${(a / 1000).toFixed(1)} kA`)

/** The rating a row is judged on first: interrupting for a device, bracing for a busbar. */
export function primaryRating(r: DutyRow): number | null {
  return (r.checks.interrupting ?? r.checks.bracing)?.ratingKa ?? null
}

/** "9.7 / 10 kA" on the badge; "unrated" when nothing was entered. */
export function dutyBadgeText(r: DutyRow): string {
  const rating = primaryRating(r)
  if (rating == null) return 'unrated'
  return `${r.dutyA == null ? '—' : (r.dutyA / 1000).toFixed(1)} / ${rating} kA`
}

/** The hover text: both fault currents, the factors, and every check. */
export function dutyTooltip(r: DutyRow, d: Pick<DutyResult, 'dutyMargin' | 'asymmetryFactor'>): string {
  const lines = [
    `Fault: ${kA(r.faultA3ph)} three-phase, ${kA(r.faultA1ph)} line-to-ground (${r.governing === '1ph' ? 'ground governs' : 'three-phase governs'})`,
  ]
  if (d.asymmetryFactor !== 1) lines.push(`× ${d.asymmetryFactor} asymmetry = ${kA(r.dutyA)}`)
  for (const [what, c] of Object.entries(r.checks)) {
    if (!c) continue
    lines.push(c.ratingKa == null
      ? `${what}: no rating`
      : `${what}: ${c.ratingKa} kA rating, ${c.ratio == null ? '—' : `${Math.round(c.ratio * 100)} %`} of it${d.dutyMargin !== 1 ? ` with the ${d.dutyMargin} margin` : ''} — ${c.status}`)
  }
  lines.push('Screening check, not an ANSI C37 / IEC 60909 duty study.')
  return lines.join('\n')
}
