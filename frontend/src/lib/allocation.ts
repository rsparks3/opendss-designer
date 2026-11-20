// Metered-zone allocations on the drawing: which loads each one scales and
// by how much -- the same rules as core/allocations.py (zones judged on the
// base drawing, fixed and out-of-service loads left alone, a zone that
// overlaps an earlier one skipped).

import type { AppEdge, AppNode } from '../store/circuitStore'
import type { AllocationJSON, Params } from '../types/circuit'
import { buildTopology, downstream, priorityOf, type Topology } from './trace'

export function zoneLoads(topo: Topology, meterId: string): string[] {
  if (!topo.elementBuses.has(meterId)) return []
  return downstream(topo, meterId).loads.rows.map((r) => r.id)
}

export function demandFactor(p: Params, factors: Record<string, number> | null | undefined): number {
  if (!factors) return 1
  const keys = new Set<string>([priorityOf(p), ...(Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [])])
  let out = 1
  for (const [k, f] of Object.entries(factors)) if (keys.has(k)) out *= f
  return out
}

/** Load id -> its kW multiplier and allocation, for every run allocation. */
export function allocatedLoads(nodes: AppNode[], edges: AppEdge[], allocations: AllocationJSON[]):
  Map<string, { factor: number; allocation: string }> {
  const out = new Map<string, { factor: number; allocation: string }>()
  if (!allocations.length) return out
  const topo = buildTopology(nodes, edges)
  const taken = new Set<string>()
  for (const a of allocations) {
    if (a.lastFactor == null) continue
    const loads = zoneLoads(topo, a.meterElementId)
    if (!loads.length || loads.some((id) => taken.has(id))) continue
    for (const id of loads) {
      taken.add(id)
      const p = topo.nodes.get(id)!.data.params
      if (p.fixed === true || p.enabled === false) continue
      out.set(id, { factor: demandFactor(p, a.demandFactors) * a.lastFactor, allocation: a.id })
    }
  }
  return out
}

let memo: { nodes: AppNode[]; edges: AppEdge[]; allocations: AllocationJSON[]; map: ReturnType<typeof allocatedLoads> } | null = null

/** The same, kept while the drawing and the allocations are the same. */
export function allocationOf(nodes: AppNode[], edges: AppEdge[], allocations: AllocationJSON[], loadId: string) {
  if (!memo || memo.nodes !== nodes || memo.edges !== edges || memo.allocations !== allocations) {
    memo = { nodes, edges, allocations, map: allocatedLoads(nodes, edges, allocations) }
  }
  return memo.map.get(loadId)
}

/** "nonessential=0.8, hvac=0.9" -> {nonessential: 0.8, hvac: 0.9}; null when empty. */
export function parseFactors(text: string): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const part of text.split(/[,;\n]/)) {
    const m = part.trim().match(/^([^=\s]+)\s*=\s*([\d.]+)$/)
    if (m && Number.isFinite(Number(m[2]))) out[m[1]] = Number(m[2])
  }
  return Object.keys(out).length ? out : null
}

export function formatFactors(f: Record<string, number> | null | undefined): string {
  return f ? Object.entries(f).map(([k, v]) => `${k}=${v}`).join(', ') : ''
}
