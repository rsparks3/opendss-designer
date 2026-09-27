import type { AppEdge, AppNode } from '../store/circuitStore'
import { FIELDS, type Field } from './fields'
import { effectivePhasing } from './phasing'
import type { Params } from '../types/circuit'

export interface Picked {
  nodeIds: string[]
  edgeIds: string[]
}

/**
 * Everything downstream of an element: the part of the circuit that would
 * be cut off from every source if the element were removed, plus the element
 * itself. For a bus that is its whole lateral; for a line or device, what it
 * feeds. An element nothing feeds from a source (an island) yields its own
 * connected component, so the answer is never empty.
 */
export function downstreamOf(nodes: AppNode[], edges: AppEdge[], target: { kind: 'node' | 'edge'; id: string }): Picked {
  const adj = new Map<string, { node: string; edge: string }[]>()
  const link = (a: string, b: string, edge: string) => adj.set(a, [...(adj.get(a) ?? []), { node: b, edge }])
  for (const e of edges) {
    if (target.kind === 'edge' && e.id === target.id) continue
    link(e.source, e.target, e.id)
    link(e.target, e.source, e.id)
  }
  const blocked = target.kind === 'node' ? target.id : null
  const reach = (starts: string[]): Set<string> => {
    const seen = new Set<string>()
    const queue = starts.filter((s) => s !== blocked)
    for (const s of queue) seen.add(s)
    while (queue.length) {
      const id = queue.shift()!
      for (const { node } of adj.get(id) ?? []) {
        if (node === blocked || seen.has(node)) continue
        seen.add(node)
        queue.push(node)
      }
    }
    return seen
  }
  const sources = nodes.filter((n) => n.type === 'vsource').map((n) => n.id)
  const fed = reach(sources)

  // Seeds: the far side(s) of the element. For a node, its neighbours that
  // the sources no longer reach; for an edge, whichever end is now unfed.
  let seeds: string[]
  if (target.kind === 'node') {
    seeds = (adj.get(target.id) ?? []).map((l) => l.node).filter((id) => !fed.has(id))
  } else {
    const e = edges.find((x) => x.id === target.id)
    seeds = e ? [e.source, e.target].filter((id) => !fed.has(id)) : []
  }
  // An island (nothing upstream reaches a source): take its whole component.
  if (!seeds.length && !fed.has(target.kind === 'node' ? target.id : '')) {
    const e = target.kind === 'edge' ? edges.find((x) => x.id === target.id) : null
    seeds = target.kind === 'node' ? [target.id] : e ? [e.source, e.target] : []
  }
  const below = reach(seeds)
  if (target.kind === 'node') below.add(target.id)
  const nodeIds = nodes.filter((n) => below.has(n.id)).map((n) => n.id)
  const edgeIds = edges
    .filter((e) => (below.has(e.source) && below.has(e.target)) || e.id === target.id)
    .map((e) => e.id)
  return { nodeIds, edgeIds }
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

/** The fields every one of these types offers, by key and kind, in the order
 *  the first type lists them. Names are unique per element, so never bulk. */
export function commonFields(types: string[]): Field[] {
  if (!types.length) return []
  const first = FIELDS[types[0]] ?? []
  return first.filter(
    (f) =>
      f.key !== 'name' &&
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
