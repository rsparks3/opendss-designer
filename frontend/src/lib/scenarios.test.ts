import { describe, expect, it } from 'vitest'
import type { AppEdge, AppNode } from '../store/circuitStore'
import { fromCircuitJSON } from '../store/circuitStore'
import type { ScenarioJSON } from '../types/circuit'
import { applyScenario, diffScenario, levelNamed, levelProblem, newScenarioId, paramsDelta, patched, scenarioSize } from './scenarios'

const node = (id: string, type: string, params: Record<string, unknown>): AppNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: { params } }) as AppNode
const edge = (id: string, source: string, target: string, params: Record<string, unknown> = {}): AppEdge =>
  ({ id, type: 'wire', source, target, sourceHandle: 't1', targetHandle: 't1', data: { params } }) as AppEdge

const base = {
  nodes: [node('src', 'vsource', { name: 'S' }), node('brk', 'breaker', { name: 'B', closed: true }), node('ld', 'load', { name: 'L', kw: 100 })],
  edges: [edge('w1', 'src', 'brk'), edge('ln', 'brk', 'ld', { name: 'LN', length: 1 })],
}
const fromJSON = (nodes: ScenarioJSON['addedNodes'], edges: ScenarioJSON['addedEdges']) =>
  fromCircuitJSON({ version: 1, name: '', nodes, edges, busNames: {}, loadShapes: {} })

describe('paramsDelta', () => {
  it('reports changed, added and deleted keys, and nothing when equal', () => {
    expect(paramsDelta({ a: 1, b: 2 }, { a: 1, b: 2 })).toBeNull()
    expect(paramsDelta({ a: 1, b: 2 }, { a: 1, b: 3, c: 'x' })).toEqual({ b: 3, c: 'x' })
    expect(paramsDelta({ a: 1, b: 2 }, { a: 1 })).toEqual({ b: null })
    expect(paramsDelta({ w: [{ kv: 1 }] }, { w: [{ kv: 1 }] })).toBeNull()
    expect(paramsDelta({ w: [{ kv: 1 }] }, { w: [{ kv: 2 }] })).toEqual({ w: [{ kv: 2 }] })
  })
  it('patched applies a delta, null deleting', () => {
    expect(patched({ a: 1, b: 2 }, { b: null, c: 3 })).toEqual({ a: 1, c: 3 })
  })
})

describe('diffScenario and applyScenario', () => {
  it('round-trips an edit, an addition and a removal', () => {
    const now = {
      nodes: [
        base.nodes[0],
        { ...base.nodes[1], data: { params: { name: 'B', closed: false } } },
        node('pv', 'pvsystem', { name: 'PV', kva: 50 }),
      ],
      edges: [base.edges[0], edge('w2', 'brk', 'pv')],
    }
    const deltas = diffScenario(base, now)
    expect(deltas.overrides).toEqual({ brk: { closed: false } })
    expect(deltas.addedNodes.map((n) => n.id)).toEqual(['pv'])
    expect(deltas.addedEdges.map((e) => e.id)).toEqual(['w2'])
    // The load went, and the line into it is implied by the load.
    expect(deltas.removed).toEqual(['ld'])
    const sc: ScenarioJSON = { id: 's1', name: 'x', ...deltas }
    expect(scenarioSize(sc)).toBe(4)
    const again = applyScenario(base, sc, fromJSON)
    expect(again.nodes.map((n) => n.id)).toEqual(['src', 'brk', 'pv'])
    expect(again.nodes[1].data.params.closed).toBe(false)
    expect(again.edges.map((e) => e.id)).toEqual(['w1', 'w2'])
    // Moving a symbol is not a change.
    const moved = { nodes: base.nodes.map((n) => ({ ...n, position: { x: 99, y: 99 } })), edges: base.edges }
    expect(scenarioSize({ id: 's', name: 's', ...diffScenario(base, moved) })).toBe(0)
  })
  it('ignores an added edge whose end is missing and keeps the base on an id clash', () => {
    const sc: ScenarioJSON = {
      id: 's1', name: 'x', overrides: {}, removed: [],
      addedNodes: [{ id: 'brk', type: 'breaker', params: { name: 'IMPOSTOR' } }],
      addedEdges: [{ id: 'bad', type: 'wire', source: 'brk', target: 'nowhere', params: {} }],
    }
    const out = applyScenario(base, sc, fromJSON)
    expect(out.nodes.find((n) => n.id === 'brk')!.data.params.name).toBe('B')
    expect(out.edges.map((e) => e.id)).toEqual(['w1', 'ln'])
  })
  it('an edge removed on its own is recorded', () => {
    const now = { nodes: base.nodes, edges: [base.edges[0]] }
    expect(diffScenario(base, now).removed).toEqual(['ln'])
  })
})

describe('load levels', () => {
  it('levelNamed falls back to rated', () => {
    const levels = [{ name: 'Peak', loadmult: 1, rating: 'normal' as const }]
    expect(levelNamed(levels, 'Peak').name).toBe('Peak')
    expect(levelNamed(levels, 'nope').name).toBe('Rated')
    expect(levelNamed(null, null).loadmult).toBe(1)
  })
  it('levelProblem catches blanks, duplicates and bad multipliers', () => {
    expect(levelProblem([{ name: 'A', loadmult: 0.5, rating: 'normal' }])).toBeNull()
    expect(levelProblem([{ name: ' ', loadmult: 0.5, rating: 'normal' }])).toMatch(/name/)
    expect(levelProblem([{ name: 'A', loadmult: 1, rating: 'normal' }, { name: 'A', loadmult: 2, rating: 'normal' }])).toMatch(/Two/)
    expect(levelProblem([{ name: 'A', loadmult: 0, rating: 'normal' }])).toMatch(/multiplier/)
  })
  it('newScenarioId never reuses an id', () => {
    expect(newScenarioId(['sc1', 'sc2'])).toBe('sc3')
    expect(newScenarioId(['sc2'])).toBe('sc1')
  })
})
