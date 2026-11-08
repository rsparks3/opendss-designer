import type { AppEdge, AppNode } from '../store/circuitStore'
import type { LoadLevelJSON, Params, ScenarioJSON, XYCurveJSON } from '../types/circuit'

/**
 * Scenarios: a base circuit plus element-level deltas.
 *
 * The store swaps a scenario's effective drawing in while it is being
 * edited, so the canvas and every panel work on ordinary nodes and edges;
 * on the way out the drawing is diffed against the base and the difference
 * is what the scenario stores. The Python side (core/scenarios.py) applies
 * the same deltas, so a saved project carries the base plus deltas and
 * either end can rebuild any alternative.
 */

/** What every circuit solved before load levels existed. */
export const RATED_LEVEL: LoadLevelJSON = { name: 'Rated', loadmult: 1, rating: 'normal' }

/** The levels a new project is offered. */
export const DEFAULT_LOAD_LEVELS: LoadLevelJSON[] = [
  { name: 'Peak', loadmult: 1, rating: 'normal' },
  { name: 'Minimum daytime', loadmult: 0.3, rating: 'normal' },
  { name: 'Emergency peak', loadmult: 1, rating: 'emergency' },
]

export function levelNamed(levels: LoadLevelJSON[] | null, name: string | null): LoadLevelJSON {
  if (name && levels) {
    const hit = levels.find((l) => l.name === name)
    if (hit) return hit
  }
  return RATED_LEVEL
}

export function levelProblem(levels: LoadLevelJSON[]): string | null {
  const names = new Set<string>()
  for (const l of levels) {
    const name = l.name.trim()
    if (!name) return 'Every load level needs a name.'
    if (names.has(name)) return `Two load levels are called "${name}".`
    names.add(name)
    if (!Number.isFinite(l.loadmult) || l.loadmult <= 0 || l.loadmult > 100) {
      return `"${name}": the load multiplier must be between 0 and 100.`
    }
  }
  return null
}

/** IEEE 1547-2018 default smart-inverter characteristics, as XY curves in
 *  per-unit voltage against per-unit reactive power (volt-var) or active
 *  power (volt-watt). Category B is what most interconnection rules now
 *  require; Category A is the gentler default for low-DER systems. */
export const IEEE1547_CURVES: Record<string, XYCurveJSON & { label: string }> = {
  vv_catA: {
    label: 'IEEE 1547 Cat A volt-var',
    x: [0.5, 0.9, 1.0, 1.1, 1.5],
    y: [0.25, 0.25, 0, -0.25, -0.25],
    source: 'ieee1547:catA:voltvar',
  },
  vv_catB: {
    label: 'IEEE 1547 Cat B volt-var',
    x: [0.5, 0.92, 0.98, 1.02, 1.08, 1.5],
    y: [0.44, 0.44, 0, 0, -0.44, -0.44],
    source: 'ieee1547:catB:voltvar',
  },
  vw_catB: {
    label: 'IEEE 1547 Cat B volt-watt',
    x: [0.5, 1.06, 1.1, 1.5],
    y: [1, 1, 0.2, 0.2],
    source: 'ieee1547:catB:voltwatt',
  },
}

/** Scenario ids are short and never reused within a project. */
export function newScenarioId(taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let i = 1; ; i++) {
    const id = `sc${i}`
    if (!used.has(id)) return id
  }
}

// --- deltas ---------------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a === 'object' && a && b) return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/** The parameter changes from `base` to `now`: changed and added keys hold
 *  their new value, deleted keys null. Empty when nothing changed. */
export function paramsDelta(base: Params, now: Params): Params | null {
  const out: Params = {}
  let any = false
  for (const key of new Set([...Object.keys(base), ...Object.keys(now)])) {
    if (!(key in now)) {
      out[key] = null
      any = true
    } else if (!(key in base) || !sameValue(base[key], now[key])) {
      out[key] = now[key]
      any = true
    }
  }
  return any ? out : null
}

export interface Drawing {
  nodes: AppNode[]
  edges: AppEdge[]
}

/** What differs between the base drawing and the one on screen, as the
 *  scenario stores it. Positions, sizes and selection are not part of a
 *  scenario: a moved symbol is the same element. */
export function diffScenario(base: Drawing, now: Drawing): Pick<ScenarioJSON, 'overrides' | 'addedNodes' | 'addedEdges' | 'removed'> {
  const overrides: Record<string, Params> = {}
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]))
  const baseEdges = new Map(base.edges.map((e) => [e.id, e]))
  const nowNodes = new Map(now.nodes.map((n) => [n.id, n]))
  const nowEdges = new Map(now.edges.map((e) => [e.id, e]))
  const addedNodes: ScenarioJSON['addedNodes'] = []
  const addedEdges: ScenarioJSON['addedEdges'] = []
  const removed: string[] = []

  for (const n of now.nodes) {
    const b = baseNodes.get(n.id)
    if (!b) {
      addedNodes.push({
        id: n.id,
        type: n.type as ScenarioJSON['addedNodes'][number]['type'],
        position: n.position,
        width: (n.width ?? (n.style?.width as number)) || null,
        ...(n.type === 'zone' ? { height: (n.height ?? (n.style?.height as number)) || null } : {}),
        params: n.data.params,
        ...(n.data.geo ? { geo: n.data.geo } : {}),
      })
      continue
    }
    const d = paramsDelta(b.data.params, n.data.params)
    if (d) overrides[n.id] = d
  }
  for (const b of base.nodes) if (!nowNodes.has(b.id)) removed.push(b.id)

  for (const e of now.edges) {
    const b = baseEdges.get(e.id)
    if (!b) {
      addedEdges.push({
        id: e.id,
        type: (e.type as 'wire' | 'line') ?? 'wire',
        source: e.source,
        sourceHandle: e.sourceHandle ?? null,
        target: e.target,
        targetHandle: e.targetHandle ?? null,
        params: e.data?.params ?? {},
        waypoints: e.data?.waypoints?.length ? e.data.waypoints : null,
        ...(e.data?.geometry?.length ? { geometry: e.data.geometry } : {}),
      })
      continue
    }
    const d = paramsDelta(b.data?.params ?? {}, e.data?.params ?? {})
    if (d) overrides[e.id] = d
  }
  for (const b of base.edges) {
    // An edge whose end went with a removed node is implied by the node.
    if (!nowEdges.has(b.id) && !removed.includes(b.source) && !removed.includes(b.target)) removed.push(b.id)
  }
  return { overrides, addedNodes, addedEdges, removed }
}

export function patched(params: Params, patch: Params): Params {
  const out = { ...params }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = value
  }
  return out
}

/** The base drawing with a scenario's deltas applied. `fromJSON` turns the
 *  scenario's stored nodes and edges into drawing nodes (the store's
 *  `fromCircuitJSON`), so this module does not depend on the store. */
export function applyScenario(
  base: Drawing,
  scenario: ScenarioJSON,
  fromJSON: (nodes: ScenarioJSON['addedNodes'], edges: ScenarioJSON['addedEdges']) => Drawing,
): Drawing {
  const removed = new Set(scenario.removed)
  const nodes: AppNode[] = []
  for (const n of base.nodes) {
    if (removed.has(n.id)) continue
    const patch = scenario.overrides[n.id]
    nodes.push(patch ? { ...n, data: { ...n.data, params: patched(n.data.params, patch) } } : n)
  }
  const kept = new Set(nodes.map((n) => n.id))
  const edges: AppEdge[] = []
  for (const e of base.edges) {
    if (removed.has(e.id) || !kept.has(e.source) || !kept.has(e.target)) continue
    const patch = scenario.overrides[e.id]
    edges.push(patch ? { ...e, data: { ...(e.data ?? { params: {} }), params: patched(e.data?.params ?? {}, patch) } } : e)
  }
  const extra = fromJSON(scenario.addedNodes, scenario.addedEdges)
  for (const n of extra.nodes) {
    if (!kept.has(n.id)) {
      nodes.push(n)
      kept.add(n.id)
    }
  }
  const edgeIds = new Set(edges.map((e) => e.id))
  for (const e of extra.edges) {
    if (!edgeIds.has(e.id) && kept.has(e.source) && kept.has(e.target)) {
      edges.push(e)
      edgeIds.add(e.id)
    }
  }
  return { nodes, edges }
}

/** How many things a scenario changes, for its row in the list. */
export function scenarioSize(s: ScenarioJSON): number {
  return Object.keys(s.overrides).length + s.addedNodes.length + s.addedEdges.length + s.removed.length
}
