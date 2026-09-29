import type { LimitsJSON, SolveResult, TimeSeriesResult } from '../types/circuit'
import { DEFAULT_LIMITS } from './limits'

/** One step of a recorded time-series run, reshaped as a SolveResult so the
 *  canvas overlays (badges, edge colors, tooltips) can render it unchanged.
 *
 *  Only recorded quantities are present: per-bus vmin/vmax (no per-phase
 *  magnitudes/angles — vmagPu stays empty and consumers fall back), and
 *  per-element kW/kvar/loading (currents stays empty; ampsMax feeds nothing
 *  directly, loading covers it). For downsampled (yearly) runs each index is
 *  a min/max envelope bucket, not an exact instant.
 */
export function tsSlice(
  ts: TimeSeriesResult,
  index: number,
  limits: LimitsJSON = DEFAULT_LIMITS,
): SolveResult | null {
  if (index < 0 || index >= ts.time.length) return null
  const buses: SolveResult['buses'] = {}
  for (const [name, env] of Object.entries(ts.buses)) {
    const vmin = env.vmin[index]
    const vmax = env.vmax[index]
    if (vmin == null || vmax == null) continue
    buses[name] = {
      vmagPu: [],
      vangDeg: [],
      vminPu: vmin,
      vmaxPu: vmax,
      kvBase: env.kvBase,
      nodes: [],
      ...(vmin > 0.05 && vmin < limits.vminPu
        ? { violation: 'undervoltage' }
        : vmax > limits.vmaxPu
          ? { violation: 'overvoltage' }
          : {}),
    }
  }
  const elements: SolveResult['elements'] = {}
  for (const [name, s] of Object.entries(ts.elements)) {
    elements[name] = {
      id: s.id,
      currents: [],
      kw: s.kw[index] ?? 0,
      kvar: s.kvar[index] ?? 0,
      normAmps: null,
      loadingPct: s.loadingPct[index] ?? null,
      violations: (s.loadingPct[index] ?? 0) >= limits.overloadPct ? ['overload'] : [],
      lossKw: null,
      lossKvar: null,
    }
  }
  return {
    converged: true,
    iterations: 0,
    buses,
    elements,
    losses: null,
    issues: [],
    nodeBuses: ts.nodeBuses,
    lineBuses: ts.lineBuses ?? {},
    busNames: ts.busNames,
    busDistances: {},
  }
}

/** Index of the recorded step nearest to the given simulation hour. */
export function tsIndexNearHour(ts: TimeSeriesResult, hour: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < ts.time.length; i++) {
    const d = Math.abs(ts.time[i] - hour)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}
