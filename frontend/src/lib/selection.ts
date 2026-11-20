import type { AppEdge, AppNode } from '../store/circuitStore'
import { FIELDS, type Field } from './fields'
import { effectivePhasing } from './phasing'
import { buildTopology, downstream, energized, highlightOf } from './trace'
import type { Params } from '../types/circuit'

export interface Picked {
  nodeIds: string[]
  edgeIds: string[]
}

/**
 * Everything downstream of an element: what would lose every source if the
 * element opened (a series element) or went (a bus), plus the element
 * itself. Open switches and elements out of service already break the path
 * (lib/trace). An element no source reaches (an island) yields its own
 * connected component, so the answer is never empty.
 */
export function downstreamOf(nodes: AppNode[], edges: AppEdge[], target: { kind: 'node' | 'edge'; id: string }): Picked {
  const topo = buildTopology(nodes, edges)
  const buses = topo.elementBuses.get(target.id) ?? []
  const live = energized(topo)
  if (buses.length && !buses.some((b) => live.has(b))) {
    // An island: everything joined to it by anything at all, open or not.
    const seen = new Set<string>([target.id])
    const queue = [target.id]
    const adj = new Map<string, string[]>()
    for (const e of edges) {
      adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
      adj.set(e.target, [...(adj.get(e.target) ?? []), e.source])
    }
    if (target.kind === 'edge') {
      const e = edges.find((x) => x.id === target.id)
      for (const id of e ? [e.source, e.target] : []) if (!seen.has(id)) { seen.add(id); queue.push(id) }
    }
    for (let i = 0; i < queue.length; i++) {
      for (const next of adj.get(queue[i]) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
    return {
      nodeIds: nodes.filter((n) => seen.has(n.id)).map((n) => n.id),
      edgeIds: edges.filter((e) => (seen.has(e.source) && seen.has(e.target)) || e.id === target.id).map((e) => e.id),
    }
  }
  const d = downstream(topo, target.id)
  const lit = highlightOf(topo, d.buses, [...d.nodeIds, ...d.edgeIds])
  const nodeIds = new Set([...d.nodeIds, ...lit.nodeIds])
  if (target.kind === 'node') nodeIds.add(target.id)
  const edgeIds = new Set([...d.edgeIds, ...lit.edgeIds])
  if (target.kind === 'edge') edgeIds.add(target.id)
  // Wires from the element to what it feeds.
  for (const e of edges) {
    if ((e.source === target.id || e.target === target.id) && e.type !== 'line') {
      const other = e.source === target.id ? e.target : e.source
      if (nodeIds.has(other)) edgeIds.add(e.id)
    }
  }
  return {
    nodeIds: nodes.filter((n) => nodeIds.has(n.id)).map((n) => n.id),
    edgeIds: edges.filter((e) => edgeIds.has(e.id)).map((e) => e.id),
  }
}

/** Every element of one type; 'line' means line edges. */
export function allOfType(nodes: AppNode[], edges: AppEdge[], type: string): Picked {
  if (type === 'line') return { nodeIds: [], edgeIds: edges.filter((e) => e.type === 'line').map((e) => e.id) }
  return { nodeIds: nodes.filter((n) => n.type === type).map((n) => n.id), edgeIds: [] }
}

/** Whether an element is on the given phase, pinned or by default. */
export function onPhase(params: Params | undefined, letter: string): boolean {
  return effectivePhasing(params).includes(letter)
}

/** A field that belongs to one element alone: a name is unique, and a
 *  note's words and arrow (or a zone's label) are what make it that one. */
const OWN_FIELDS = new Set(['name', 'text', 'target', 'label'])

/** The fields every one of these types offers, by key and kind, in the order
 *  the first type lists them. Names are unique per element, so never bulk. */
export function commonFields(types: string[]): Field[] {
  if (!types.length) return []
  const first = FIELDS[types[0]] ?? []
  return first.filter(
    (f) =>
      !OWN_FIELDS.has(f.key) &&
      types.every((t) => (FIELDS[t] ?? []).some((g) => g.key === f.key && g.kind === f.kind)),
  )
}

/** The value all elements share, or `mixed` when they differ. */
export function commonValue(values: unknown[]): { value: unknown; mixed: boolean } {
  if (!values.length) return { value: undefined, mixed: false }
  const first = JSON.stringify(values[0] ?? null)
  const mixed = values.some((v) => JSON.stringify(v ?? null) !== first)
  return { value: mixed ? undefined : values[0], mixed }
}

/**
 * A number typed into a bulk field: a plain value sets it; `×1.1` (also
 * `x1.1`, `*1.1`) or `/2` scales each element's own value; `+5` or `-5`
 * shifts it; `=-5` sets a negative number. Returns the new value for one
 * element given its current one, or null when the text is not a number.
 */
export function applyNumberEdit(text: string, current: unknown): number | null {
  const t = text.trim().replace(',', '.')
  const cur = typeof current === 'number' ? current : Number(current)
  const m = t.match(/^([×x*\/+\-=])\s*(-?\d+(?:\.\d+)?)$/i)
  if (m) {
    const k = Number(m[2])
    const op = m[1].toLowerCase()
    if (op === '=') return k
    if (!Number.isFinite(cur)) return null
    if (op === '+') return cur + k
    if (op === '-') return cur - k
    if (op === '/') return k === 0 ? null : cur / k
    return cur * k // × x *
  }
  const n = Number(t)
  return t !== '' && Number.isFinite(n) ? n : null
}

/** True when the text is a relative edit (scale or shift) rather than a value. */
export function isRelativeEdit(text: string): boolean {
  return /^[×x*\/+\-]\s*\d/i.test(text.trim())
}

/**
 * The Elements table filter. Terms are separated by spaces and all must
 * hold. A bare term matches the name (contains, case-insensitive); a term
 * with an operator tests one parameter: `kw>100`, `kv=4.16`, `model!=1`,
 * `loadshape:day` (contains), `phasing=B`. A quoted value keeps its spaces.
 */
export function matchesFilter(params: Params, query: string): boolean {
  const terms = query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  return terms.every((raw) => {
    const term = raw.replace(/"/g, '')
    const m = term.match(/^([A-Za-z_][\w]*)\s*(>=|<=|!=|=|>|<|:)\s*(.*)$/)
    if (!m) {
      return String(params.name ?? '').toLowerCase().includes(term.toLowerCase())
    }
    const [, key, op, want] = m
    const have = params[key]
    const haveText = have == null ? '' : String(have).toLowerCase()
    const wantText = want.toLowerCase()
    if (op === ':') return haveText.includes(wantText)
    if (op === '=' || op === '!=') {
      const equal = haveText === wantText || (Number.isFinite(Number(have)) && Number(have) === Number(want))
      return op === '=' ? equal : !equal
    }
    const a = Number(have)
    const b = Number(want)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b
  })
}
