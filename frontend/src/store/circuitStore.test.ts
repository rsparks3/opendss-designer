import { beforeEach, describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/full-circuit.oneline.json'
import type { CircuitJSON } from '../types/circuit'
import { useResultsStore } from './resultsStore'
import {
  busbarHandleCount,
  fromCircuitJSON,
  toCircuitJSON,
  useCircuitStore,
  validateConnection,
  type AppEdge,
  type AppNode,
} from './circuitStore'

const FIXTURE = fixture as unknown as CircuitJSON

function node(id: string, type: string): AppNode {
  return { id, type, position: { x: 0, y: 0 }, data: { params: {} } } as AppNode
}

function resetStores() {
  useCircuitStore.setState({
    name: 'test',
    nodes: [],
    edges: [],
    busNames: {},
    placementType: null,
    connectMode: 'wire',
    dirty: false,
  })
  useResultsStore.setState({ flash: null, issues: [], result: null })
}

beforeEach(resetStores)

describe('busbarHandleCount', () => {
  it('gives one handle per 20px of width', () => {
    expect(busbarHandleCount(240)).toBe(12)
    expect(busbarHandleCount(60)).toBe(3)
  })
  it('never drops below 2 handles', () => {
    expect(busbarHandleCount(40)).toBe(2)
    expect(busbarHandleCount(10)).toBe(2)
    expect(busbarHandleCount(0)).toBe(2)
  })
})

describe('validateConnection', () => {
  const base = {
    nodes: [node('a', 'load'), node('b', 'busbar'), node('c', 'busbar')],
    edges: [] as AppEdge[],
    connectMode: 'wire' as const,
  }

  it('rejects missing endpoints', () => {
    expect(validateConnection({ source: null, target: 'a' }, base)).toMatch(/endpoint/)
    expect(validateConnection({ source: 'a', target: null }, base)).toMatch(/endpoint/)
  })

  it('rejects self-connections', () => {
    expect(validateConnection({ source: 'a', target: 'a' }, base)).toMatch(/itself/)
  })

  it('rejects references to elements that do not exist', () => {
    expect(validateConnection({ source: 'a', target: 'ghost' }, base)).toMatch(/missing element/)
  })

  it('rejects busbar-to-busbar plain wires but allows lines', () => {
    expect(validateConnection({ source: 'b', target: 'c' }, base)).toMatch(/plain wire/)
    expect(
      validateConnection({ source: 'b', target: 'c' }, { ...base, connectMode: 'line' }),
    ).toBeNull()
  })

  it('rejects duplicates in either direction, comparing handles', () => {
    const withEdge = {
      ...base,
      edges: [
        {
          id: 'e1',
          source: 'a',
          sourceHandle: 't1',
          target: 'b',
          targetHandle: 'b0',
        } as AppEdge,
      ],
    }
    const dup = { source: 'a', sourceHandle: 't1', target: 'b', targetHandle: 'b0' }
    const reversed = { source: 'b', sourceHandle: 'b0', target: 'a', targetHandle: 't1' }
    const otherHandle = { source: 'a', sourceHandle: 't1', target: 'b', targetHandle: 'b1' }
    expect(validateConnection(dup, withEdge)).toMatch(/already connected/)
    expect(validateConnection(reversed, withEdge)).toMatch(/already connected/)
    expect(validateConnection(otherHandle, withEdge)).toBeNull()
  })

  it('allows an ordinary new connection', () => {
    expect(validateConnection({ source: 'a', target: 'b' }, base)).toBeNull()
  })
})

describe('circuit JSON round trip', () => {
  it('fromCircuitJSON → toCircuitJSON reproduces the schema fixture exactly', () => {
    const { nodes, edges } = fromCircuitJSON(FIXTURE)
    const out = toCircuitJSON({
      name: FIXTURE.name,
      nodes,
      edges,
      busNames: FIXTURE.busNames,
    })
    // Serialize both so undefined-vs-absent differences disappear.
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(JSON.stringify(FIXTURE)))
  })
})

describe('setBusbarWidth handle re-homing', () => {
  it('moves edges whose handle no longer exists onto the last handle', () => {
    const bus = { ...node('bus', 'busbar'), width: 240 }
    useCircuitStore.setState({
      nodes: [bus, node('ld', 'load'), node('src', 'vsource')],
      edges: [
        { id: 'e1', source: 'ld', sourceHandle: 't1', target: 'bus', targetHandle: 'c11' },
        { id: 'e2', source: 'bus', sourceHandle: 'b1', target: 'src', targetHandle: 't1' },
      ] as AppEdge[],
    })
    useCircuitStore.getState().setBusbarWidth('bus', 60) // 3 handles per row now
    const edges = useCircuitStore.getState().edges
    expect(edges.find((e) => e.id === 'e1')?.targetHandle).toBe('c2')
    expect(edges.find((e) => e.id === 'e2')?.sourceHandle).toBe('b1') // still valid, untouched
    expect(useCircuitStore.getState().nodes.find((n) => n.id === 'bus')?.width).toBe(60)
  })
})

describe('onConnect', () => {
  it('adds an edge of the current connect mode', () => {
    useCircuitStore.setState({
      nodes: [node('b1', 'busbar'), node('b2', 'busbar')],
      connectMode: 'line',
    })
    useCircuitStore.getState().onConnect({
      source: 'b1',
      sourceHandle: 'c0',
      target: 'b2',
      targetHandle: 'b0',
    })
    const edges = useCircuitStore.getState().edges
    expect(edges).toHaveLength(1)
    expect(edges[0].type).toBe('line')
    expect(edges[0].data?.params.r1).toBeDefined() // seeded with line defaults
  })

  it('forces plain wire while a placement mode is active', () => {
    useCircuitStore.setState({
      nodes: [node('b1', 'busbar'), node('ld', 'load')],
      connectMode: 'line',
      placementType: 'load',
    })
    useCircuitStore.getState().onConnect({
      source: 'ld',
      sourceHandle: 't1',
      target: 'b1',
      targetHandle: 'c0',
    })
    expect(useCircuitStore.getState().edges[0].type).toBe('wire')
  })

  it('rejects an invalid connection with a flash message and no new edge', () => {
    useCircuitStore.setState({ nodes: [node('b1', 'busbar'), node('b2', 'busbar')] })
    useCircuitStore.getState().onConnect({
      source: 'b1',
      sourceHandle: 'c0',
      target: 'b2',
      targetHandle: 'b0',
    })
    expect(useCircuitStore.getState().edges).toHaveLength(0)
    expect(useResultsStore.getState().flash).toMatch(/plain wire/)
  })
})
