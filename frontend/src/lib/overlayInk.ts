// The overlay's colours for drawings painted on a canvas (the overview of a
// large circuit, the map): buses by voltage or by the phases that reach
// them, lines by loading. The symbols on the one-line work the same out
// in their own components; this is the one place the canvases do.

import type { LimitsJSON, PhaseMap, SolveResult } from '../types/circuit'
import { loadingColor, voltageColor } from './colorScale'
import { resultById } from './indexes'
import { phaseColor } from './phasing'
import type { OverlayMode } from '../store/resultsStore'

export interface OverlayInk {
  /** A node's colour: its bus's voltage, or the phases reaching it. */
  bus: (nodeId: string) => string
  /** A line's colour: its loading, else that of the bus at its start. */
  line: (edgeId: string | null, fromNodeId: string) => string
}

export function overlayInk(opts: {
  overlay: OverlayMode
  result: SolveResult | null
  stale: boolean
  phases: PhaseMap | null
  limits: LimitsJSON
  ink: string
}): OverlayInk {
  const { overlay, phases, limits, ink } = opts
  const solved = opts.result?.converged && !opts.stale ? opts.result : null
  const elements = solved ? resultById(solved) : null
  const bus = (nodeId: string): string => {
    if (overlay === 'voltage' && solved) {
      const name = solved.nodeBuses[nodeId]?.[0]
      const v = name ? solved.buses[name]?.vminPu : null
      if (v != null) return voltageColor(v, limits)
    }
    if (overlay === 'phases') {
      const letters = phases?.nodes[nodeId]?.[0]
      if (letters !== undefined) return phaseColor(letters)
    }
    return ink
  }
  const line = (edgeId: string | null, fromNodeId: string): string => {
    if (edgeId && overlay === 'loading' && elements) {
      const pct = elements.get(edgeId)?.loadingPct
      if (pct != null) return loadingColor(pct, limits)
    }
    return bus(fromNodeId)
  }
  return { bus, line }
}
