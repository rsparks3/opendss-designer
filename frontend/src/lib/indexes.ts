// Lookups by id, built once per array (or result) and shared by every
// component that asks.
//
// A symbol or an edge that finds itself with `array.find` costs O(n), and
// there is one of each per element, so a re-render of the drawing costs
// O(n^2): on a 10,000-element feeder that is a hundred million comparisons
// for every node React Flow measures. Every lookup here is O(1) after one
// O(n) pass, and the pass is cached on the array's identity -- the store
// replaces arrays rather than mutating them, so a new array is exactly a
// change.

import type { ElementResult, Issue, ReliabilityResult, SolveResult } from '../types/circuit'

function memoByIdentity<K extends object, V>(build: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>()
  return (key) => {
    let v = cache.get(key)
    if (v === undefined) {
      v = build(key)
      cache.set(key, v)
    }
    return v
  }
}

/** Items by their `id`. */
export const byId: <T extends { id: string }>(items: T[]) => Map<string, T> = memoByIdentity(
  (items: { id: string }[]) => new Map(items.map((it) => [it.id, it])),
) as never

/** A solve's element results by diagram id (node or edge). */
export const resultById: (result: SolveResult) => Map<string, ElementResult> = memoByIdentity(
  (result: SolveResult) => {
    const map = new Map<string, ElementResult>()
    for (const el of Object.values(result.elements)) if (el.id) map.set(el.id, el)
    return map
  },
)

type ReliabilityElement = ReliabilityResult['elements'][string]

/** A reliability study's entries by diagram id, and the sections by head. */
export const reliabilityIndex: (result: ReliabilityResult) => {
  elements: Map<string, { name: string; data: ReliabilityElement }>
  heads: Map<string, ReliabilityResult['sections'][number]>
  sectionOrder: Map<string, number>
} = memoByIdentity((result: ReliabilityResult) => {
  const elements = new Map<string, { name: string; data: ReliabilityElement }>()
  for (const [name, data] of Object.entries(result.elements)) if (data.id) elements.set(data.id, { name, data })
  const heads = new Map<string, ReliabilityResult['sections'][number]>()
  const sectionOrder = new Map<string, number>()
  result.sections.forEach((s, i) => {
    if (s.headId) heads.set(s.headId, s)
    sectionOrder.set(s.id, i)
  })
  return { elements, heads, sectionOrder }
})

/** The worst issue severity on each node and edge. */
export const issueSeverity: (issues: Issue[]) => Map<string, 'error' | 'warning'> = memoByIdentity(
  (issues: Issue[]) => {
    const map = new Map<string, 'error' | 'warning'>()
    for (const i of issues) {
      for (const id of [i.nodeId, i.edgeId]) {
        if (!id) continue
        if (i.severity === 'error' || !map.has(id)) map.set(id, i.severity)
      }
    }
    return map
  },
)
