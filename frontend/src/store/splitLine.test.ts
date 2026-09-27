import { beforeEach, describe, expect, it } from 'vitest'
import { toCircuitJSON, useCircuitStore } from './circuitStore'
import type { CircuitJSON } from '../types/circuit'

const circuit: CircuitJSON = {
  version: 1,
  name: 'split',
  nodes: [
    { id: 'a', type: 'busbar', position: { x: 0, y: 0 }, width: 120, params: { name: 'BUSA', basekv: 4.16 } },
    { id: 'b', type: 'busbar', position: { x: 0, y: 400 }, width: 120, params: { name: 'BUSB', basekv: 4.16 } },
  ],
  edges: [
    {
      id: 'l1',
      type: 'line',
      source: 'a',
      sourceHandle: 'c2',
      target: 'b',
      targetHandle: 'b2',
      params: { name: 'LN1', length: 2, units: 'km', r1: 0.1, x1: 0.3, phases: 3 },
    },
  ],
} as unknown as CircuitJSON

describe('splitLine', () => {
  beforeEach(() => {
    useCircuitStore.getState().loadCircuit(circuit)
    useCircuitStore.temporal.getState().clear()
  })

  it('puts a bus in the middle with the length divided and everything else kept', () => {
    const bar = useCircuitStore.getState().splitLine('l1')!
    const c = toCircuitJSON(useCircuitStore.getState())
    const node = c.nodes.find((n) => n.id === bar)!
    expect(node.type).toBe('busbar')
    expect(node.params.name).toBe('LN1_MID')
    expect(node.params.basekv).toBe(4.16)
    const [first, second] = [c.edges.find((e) => e.id === 'l1')!, c.edges.find((e) => e.id !== 'l1')!]
    expect(first.source).toBe('a')
    expect(first.target).toBe(bar)
    expect(second.source).toBe(bar)
    expect(second.target).toBe('b')
    expect(first.params.length).toBe(1)
    expect(second.params.length).toBe(1)
    expect(second.params.name).toBe('LN1_2')
    expect(second.params.r1).toBe(0.1)
    // A line running down meets the bar from above and leaves below.
    expect(first.targetHandle).toBe('b1')
    expect(second.sourceHandle).toBe('c1')
  })

  it('divides at the click, in proportion to the drawn length', () => {
    // Node centres: a at (60, 7), b at (60, 407); click a quarter of the way.
    useCircuitStore.getState().splitLine('l1', { x: 60, y: 107 })
    const edges = toCircuitJSON(useCircuitStore.getState()).edges
    expect(edges.find((e) => e.id === 'l1')!.params.length).toBe(0.5)
    expect(edges.find((e) => e.id !== 'l1')!.params.length).toBe(1.5)
  })

  it('is one undo step', () => {
    useCircuitStore.getState().splitLine('l1')
    expect(useCircuitStore.getState().edges).toHaveLength(2)
    useCircuitStore.temporal.getState().undo()
    expect(useCircuitStore.getState().edges).toHaveLength(1)
    expect(useCircuitStore.getState().nodes).toHaveLength(2)
  })

  it('leaves wires alone', () => {
    const c = structuredClone(circuit)
    c.edges[0].type = 'wire'
    useCircuitStore.getState().loadCircuit(c)
    expect(useCircuitStore.getState().splitLine('l1')).toBeNull()
  })
})

