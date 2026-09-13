/** Which of the three phases an element connects to.
 *
 *  Mirror of `core/phasing.py`. The circuit stores letters ("B", "AC"); the
 *  compiler turns them into the node suffixes OpenDSS wants. An element with
 *  no `phasing` takes the first N phases, which is what OpenDSS assumes when a
 *  connection names no nodes -- so a drawing made before pinning existed still
 *  means exactly what it meant then.
 */
import type { Params } from '../types/circuit'

export const PHASE_LETTERS = 'ABC'

/** Unique A/B/C letters in ABC order, or null if the text says nothing usable. */
export function parsePhasing(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Separators are courtesy ("A-B", "a, c"); every remaining character has to
  // be a phase. Picking the letters out of arbitrary text instead would turn
  // a typo into a confident, wrong pin.
  const seen = [...raw.toUpperCase()].filter((c) => !' -,._/+'.includes(c))
  if (!seen.length || new Set(seen).size !== seen.length) return null
  if (seen.some((c) => !PHASE_LETTERS.includes(c))) return null
  return [...new Set(seen)].sort((a, b) => PHASE_LETTERS.indexOf(a) - PHASE_LETTERS.indexOf(b)).join('')
}

export function phaseCount(params: Params | undefined): number {
  const n = Number(params?.phases)
  if (!Number.isFinite(n)) return 3
  return Math.min(Math.max(Math.trunc(n), 1), 3)
}

/** What the element actually connects to: the pin, or the default for its
 *  phase count. */
export function effectivePhasing(params: Params | undefined): string {
  return parsePhasing(params?.phasing) ?? PHASE_LETTERS.slice(0, phaseCount(params))
}

/** A label for the one-line, or null when there is nothing worth saying --
 *  a plain 3-phase element is the common case and labelling it every time
 *  would bury the laterals that do carry information. */
export function phaseLabel(params: Params | undefined): string | null {
  const phasing = effectivePhasing(params)
  return phasing === PHASE_LETTERS ? null : phasing.split('').join('-')
}
