/** Which of the three phases an element connects to.
 *
 *  Mirror of `core/phasing.py`. The circuit stores letters ("B", "AC"); the
 *  compiler turns them into the node suffixes OpenDSS wants. An element with
 *  no `phasing` takes the first N phases, which is what OpenDSS assumes when a
 *  connection names no nodes -- so a drawing made before pinning existed still
 *  means exactly what it meant then.
 */
import type { BusResult, Params } from '../types/circuit'
import { NEUTRAL } from './colorScale'

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

/** The letter for an OpenDSS node number: 1 -> A, 2 -> B, 3 -> C. The neutral
 *  (0) is N; anything else is left as the number it came with, since the
 *  letters have nothing to say about it. */
export function nodeLetter(node: number | undefined): string {
  if (node == null) return '?'
  if (node === 0) return 'N'
  return PHASE_LETTERS[node - 1] ?? String(node)
}

/** Colours for the 'phases' overlay. There is no universal convention --
 *  every utility maps its own GIS colours -- so this is one constant to hand
 *  to a theme later, not a preference now. A three-phase element keeps the
 *  plain ink so a healthy trunk stays quiet, and a bus nothing reaches gets
 *  the de-energised grey the voltage overlay already uses. */
export const PHASE_COLORS: Record<string, string> = { A: '#c62828', B: '#1565c0', C: '#2e7d32' }
export const TWO_PHASE_COLOR = '#6a1b9a'
export const THREE_PHASE_COLOR = '#263238'
export const NO_PHASE_COLOR = NEUTRAL

export const PHASE_LEGEND: { label: string; color: string }[] = [
  { label: 'A', color: PHASE_COLORS.A },
  { label: 'B', color: PHASE_COLORS.B },
  { label: 'C', color: PHASE_COLORS.C },
  { label: 'Two-phase', color: TWO_PHASE_COLOR },
  { label: 'Three-phase', color: THREE_PHASE_COLOR },
  { label: 'Unfed', color: NO_PHASE_COLOR },
]

/** The stroke for a set of phase letters. `undefined`/`null` is "not known
 *  yet" (validation has not answered) and draws as plain ink; "" is "known
 *  to be nothing", which is the case worth seeing. */
export function phaseColor(letters: string | null | undefined): string {
  if (letters == null) return THREE_PHASE_COLOR
  if (letters === '') return NO_PHASE_COLOR
  const parsed = parsePhasing(letters)
  if (!parsed || parsed.length === 3) return THREE_PHASE_COLOR
  if (parsed.length === 2) return TWO_PHASE_COLOR
  return PHASE_COLORS[parsed]
}

/** How far apart the phases of a bus may sit before it counts as unbalanced
 *  on the drawing. Below this a bus is reported as one voltage. */
export const BALANCE_TOLERANCE_PU = 0.002

/** The phase that holds the bus's lowest voltage, or null when naming it
 *  would add nothing: a three-phase bus whose phases agree within the
 *  tolerance, or a step with no per-phase data (time series). A bus short of
 *  three phases always names it, since the letter then says which phase the
 *  lateral is on. */
export function weakestPhase(bus: BusResult): string | null {
  const phases = bus.nodes.filter((n) => n >= 1 && n <= 3)
  if (!phases.length || bus.vmagPu.length !== bus.nodes.length) return null
  let minIdx = -1
  let minV = Infinity
  let maxV = -Infinity
  bus.nodes.forEach((n, i) => {
    if (n < 1 || n > 3) return
    const v = bus.vmagPu[i]
    if (v < minV) {
      minV = v
      minIdx = i
    }
    if (v > maxV) maxV = v
  })
  if (phases.length === 3 && maxV - minV <= BALANCE_TOLERANCE_PU) return null
  return nodeLetter(bus.nodes[minIdx])
}
