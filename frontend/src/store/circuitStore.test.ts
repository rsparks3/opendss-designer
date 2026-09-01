import { beforeEach, describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/full-circuit.oneline.json'
import type { CircuitJSON } from '../types/circuit'
import { useResultsStore } from './resultsStore'
import {
  beginGesture,
  busbarHandleCount,
  edgesAtTerminal,
  endGesture,
  fromCircuitJSON,
  terminalEdgeMap,
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
    loadShapes: {},
    placementType: null,
    connectMode: 'wire',
    dirty: false,
  })
  useResultsStore.setState({ flash: null, issues: [], result: null })
  useCircuitStore.temporal.getState().clear()
  endGesture()
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
      loadShapes: FIXTURE.loadShapes,
    })
    // Serialize both so undefined-vs-absent differences disappear.
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(JSON.stringify(FIXTURE)))
  })
})

describe('loadShapes', () => {
  const shape = { intervalMin: 60, points: [0.5, 1.0, 0.75] }

  it('setLoadShape stores a shape and records one undo step', () => {
    useCircuitStore.getState().setLoadShape('day3', shape)
    expect(useCircuitStore.getState().loadShapes.day3).toEqual(shape)
    expect(useCircuitStore.temporal.getState().pastStates).toHaveLength(1)
    useCircuitStore.temporal.getState().undo()
    expect(useCircuitStore.getState().loadShapes.day3).toBeUndefined()
  })

  it('deleteLoadShape clears element references to the deleted shape', () => {
    useCircuitStore.setState({
      nodes: [{ ...node('ld', 'load'), data: { params: { loadshape: 'day3' } } }],
      loadShapes: { day3: shape },
    })
    useCircuitStore.getState().deleteLoadShape('day3')
    const s = useCircuitStore.getState()
    expect(s.loadShapes.day3).toBeUndefined()
    expect(s.nodes[0].data.params.loadshape).toBe('')
  })

  it('renameLoadShape rewrites element references', () => {
    useCircuitStore.setState({
      nodes: [{ ...node('ld', 'load'), data: { params: { loadshape: 'day3' } } }],
      loadShapes: { day3: shape },
    })
    useCircuitStore.getState().renameLoadShape('day3', 'weekday')
    const s = useCircuitStore.getState()
    expect(s.loadShapes.weekday).toEqual(shape)
    expect(s.loadShapes.day3).toBeUndefined()
    expect(s.nodes[0].data.params.loadshape).toBe('weekday')
  })

  it('survives the JSON round trip and clearAll', () => {
    useCircuitStore.getState().setLoadShape('day3', shape)
    const json = toCircuitJSON(useCircuitStore.getState())
    expect(json.loadShapes.day3).toEqual(shape)
    useCircuitStore.getState().clearAll()
    expect(useCircuitStore.getState().loadShapes).toEqual({})
    useCircuitStore.getState().loadCircuit(json)
    expect(useCircuitStore.getState().loadShapes.day3).toEqual(shape)
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

describe('copy / paste / duplicate', () => {
  function seedSelected() {
    const a: AppNode = {
      ...node('a', 'load'),
      selected: true,
      data: { params: { name: 'LOAD1', kw: 500 } },
    }
    const b: AppNode = {
      ...node('b', 'busbar'),
      selected: true,
      data: { params: { name: 'BUS1' } },
    }
    const e1 = {
      id: 'e1',
      type: 'wire',
      source: 'a',
      sourceHandle: 't1',
      target: 'b',
      targetHandle: 'c0',
      data: { params: {} },
    } as AppEdge
    useCircuitStore.setState({ nodes: [a, b], edges: [e1] })
  }

  it('pastes clones with new ids, remapped edges, and fresh names', () => {
    seedSelected()
    expect(useCircuitStore.getState().copySelection()).toBe(2)
    useCircuitStore.getState().pasteClipboard()
    const s = useCircuitStore.getState()
    expect(s.nodes).toHaveLength(4)
    expect(s.edges).toHaveLength(2)

    const pasted = s.nodes.filter((n) => n.selected)
    expect(pasted).toHaveLength(2) // pasted content becomes the selection
    expect(s.nodes.find((n) => n.id === 'a')?.selected).toBe(false)

    const newEdge = s.edges.find((e) => e.id !== 'e1')!
    const pastedIds = new Set(pasted.map((n) => n.id))
    expect(pastedIds.has(newEdge.source)).toBe(true)
    expect(pastedIds.has(newEdge.target)).toBe(true)
    expect(newEdge.sourceHandle).toBe('t1') // handles survive the remap

    const newLoad = pasted.find((n) => n.type === 'load')!
    expect(newLoad.position).toEqual({ x: 30, y: 30 })
    expect(newLoad.data.params.name).not.toBe('LOAD1') // no OpenDSS name clash
    expect(newLoad.data.params.kw).toBe(500)
  })

  it('cascades the offset on repeated paste', () => {
    seedSelected()
    useCircuitStore.getState().copySelection()
    useCircuitStore.getState().pasteClipboard()
    useCircuitStore.getState().pasteClipboard()
    const loads = useCircuitStore.getState().nodes.filter((n) => n.type === 'load')
    expect(loads.map((n) => n.position.x).sort((x, y) => x - y)).toEqual([0, 30, 60])
  })

  it('copies only edges whose both endpoints are selected', () => {
    seedSelected()
    // Deselect the busbar: the wire to it must not be copied.
    useCircuitStore.setState({
      nodes: useCircuitStore.getState().nodes.map((n) =>
        n.id === 'b' ? { ...n, selected: false } : n,
      ),
    })
    expect(useCircuitStore.getState().copySelection()).toBe(1)
    useCircuitStore.getState().pasteClipboard()
    expect(useCircuitStore.getState().edges).toHaveLength(1)
    expect(useCircuitStore.getState().nodes).toHaveLength(3)
  })

  it('duplicateSelection does not disturb the clipboard', () => {
    seedSelected()
    useCircuitStore.getState().copySelection() // clipboard: load + busbar
    useCircuitStore.getState().selectOnly('node', 'b')
    useCircuitStore.getState().duplicateSelection() // duplicates just the busbar
    expect(useCircuitStore.getState().nodes).toHaveLength(3)
    useCircuitStore.getState().pasteClipboard() // still pastes both
    expect(useCircuitStore.getState().nodes).toHaveLength(5)
  })
})

describe('rotateNodes', () => {
  it('cycles rotation in 90° steps and skips busbars', () => {
    useCircuitStore.setState({ nodes: [node('ld', 'load'), node('bus', 'busbar')] })
    const rot = (id: string) =>
      Number(useCircuitStore.getState().nodes.find((n) => n.id === id)?.data.params.rotation) || 0
    useCircuitStore.getState().rotateNodes(['ld', 'bus'])
    expect(rot('ld')).toBe(90)
    expect(rot('bus')).toBe(0)
    useCircuitStore.getState().rotateNodes(['ld'])
    useCircuitStore.getState().rotateNodes(['ld'])
    useCircuitStore.getState().rotateNodes(['ld'])
    expect(rot('ld')).toBe(0) // full circle
  })
})

describe('undo gestures', () => {
  const past = () => useCircuitStore.temporal.getState().pastStates

  it('groups every change inside a gesture into one undo step', () => {
    useCircuitStore.setState({ nodes: [node('a', 'load')] })
    useCircuitStore.temporal.getState().clear()
    const move = (x: number) =>
      useCircuitStore.getState().onNodesChange([{ type: 'position', id: 'a', position: { x, y: 0 } }])
    beginGesture()
    move(10)
    move(20)
    move(30)
    endGesture()
    expect(past()).toHaveLength(1)
    useCircuitStore.temporal.getState().undo()
    expect(useCircuitStore.getState().nodes[0].position.x).toBe(0)
  })

  it('records discrete actions as separate steps', () => {
    useCircuitStore.setState({ nodes: [node('a', 'load')] })
    useCircuitStore.temporal.getState().clear()
    useCircuitStore.getState().updateNodeParams('a', { kw: 1 })
    useCircuitStore.getState().updateNodeParams('a', { kw: 2 })
    expect(past()).toHaveLength(2)
  })

  it('ignores selection-only changes', () => {
    useCircuitStore.setState({ nodes: [node('a', 'load'), node('b', 'load')] })
    useCircuitStore.temporal.getState().clear()
    useCircuitStore.getState().selectOnly('node', 'a')
    useCircuitStore.getState().selectOnly('node', 'b')
    expect(past()).toHaveLength(0)
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

  it('choosing a connect mode exits placement, so Line immediately draws lines', () => {
    // Regression: place a component (placement is sticky), then pick Line —
    // the next connection must be a line, not the while-placing wire default.
    useCircuitStore.setState({
      nodes: [node('b1', 'busbar'), node('b2', 'busbar')],
      placementType: 'load',
    })
    useCircuitStore.getState().setConnectMode('line')
    expect(useCircuitStore.getState().placementType).toBeNull()
    useCircuitStore.getState().onConnect({
      source: 'b1',
      sourceHandle: 'c0',
      target: 'b2',
      targetHandle: 'b0',
    })
    const edge = useCircuitStore.getState().edges[0]
    expect(edge.type).toBe('line')
    expect(edge.data?.params.r1).toBeDefined()
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

describe('terminal lookup', () => {
  const edges: AppEdge[] = [
    { id: 'e1', source: 'bus', sourceHandle: 'c0', target: 'ld', targetHandle: 't1' },
    { id: 'e2', source: 'bus', sourceHandle: 'c0', target: 'cap', targetHandle: 't1' },
    { id: 'e3', source: 'bus', sourceHandle: 'c1', target: 'xf', targetHandle: 't1' },
    // Older files (and the .dss importer's early output) may omit the handle.
    { id: 'e4', source: 'xf', target: 'gen', targetHandle: 't1' },
  ]

  it('indexes both ends of every edge', () => {
    const map = terminalEdgeMap(edges)
    expect(map.get('bus:c0')).toEqual(['e1', 'e2'])
    expect(map.get('bus:c1')).toEqual(['e3'])
    expect(map.get('ld:t1')).toEqual(['e1'])
  })

  it('defaults a missing handle to t1', () => {
    expect(edgesAtTerminal({ edges }, 'xf', 't1')).toEqual(['e3', 'e4'])
  })

  it('reuses the index while the edge array is unchanged', () => {
    expect(terminalEdgeMap(edges)).toBe(terminalEdgeMap(edges))
    expect(terminalEdgeMap([...edges])).not.toBe(terminalEdgeMap(edges))
  })

  it('reports nothing for a free terminal', () => {
    expect(edgesAtTerminal({ edges }, 'ld', 't2')).toEqual([])
  })
})

describe('reconnectEdgeEnd', () => {
  const setup = (waypoints?: { x: number; y: number }[]) =>
    useCircuitStore.setState({
      nodes: [node('bus', 'busbar'), node('ld1', 'load'), node('ld2', 'load')],
      edges: [
        {
          id: 'e1',
          type: 'line',
          source: 'bus',
          sourceHandle: 'c0',
          target: 'ld1',
          targetHandle: 't1',
          data: { params: { name: 'LN1' }, waypoints },
        },
      ],
    })

  it('moves one end and leaves the other alone', () => {
    setup()
    useCircuitStore.getState().reconnectEdgeEnd('e1', 'target', 'ld2', 't1')
    const e = useCircuitStore.getState().edges[0]
    expect([e.source, e.sourceHandle, e.target, e.targetHandle]).toEqual(['bus', 'c0', 'ld2', 't1'])
    expect(useCircuitStore.getState().dirty).toBe(true)
  })

  it('moves the source end too', () => {
    setup()
    useCircuitStore.getState().reconnectEdgeEnd('e1', 'source', 'bus', 'c3')
    const e = useCircuitStore.getState().edges[0]
    expect([e.source, e.sourceHandle, e.target]).toEqual(['bus', 'c3', 'ld1'])
  })

  it('keeps routing waypoints when the end stays on the same node', () => {
    setup([{ x: 10, y: 20 }])
    useCircuitStore.getState().reconnectEdgeEnd('e1', 'source', 'bus', 'c4')
    expect(useCircuitStore.getState().edges[0].data?.waypoints).toEqual([{ x: 10, y: 20 }])
  })

  it('drops waypoints when the end moves to a different node', () => {
    setup([{ x: 10, y: 20 }])
    useCircuitStore.getState().reconnectEdgeEnd('e1', 'target', 'ld2', 't1')
    expect(useCircuitStore.getState().edges[0].data?.waypoints).toBeUndefined()
  })

  it('is a no-op when the end is dropped where it already was', () => {
    setup()
    useCircuitStore.setState({ dirty: false })
    useCircuitStore.getState().reconnectEdgeEnd('e1', 'target', 'ld1', 't1')
    expect(useCircuitStore.getState().dirty).toBe(false)
  })

  it('ignores an unknown edge', () => {
    setup()
    useCircuitStore.getState().reconnectEdgeEnd('nope', 'target', 'ld2', 't1')
    expect(useCircuitStore.getState().edges[0].target).toBe('ld1')
  })
})

describe('validateConnection with an exempt edge', () => {
  const state = {
    nodes: [node('bus', 'busbar'), node('ld', 'load')],
    edges: [
      { id: 'e1', source: 'bus', sourceHandle: 'c0', target: 'ld', targetHandle: 't1' },
    ] as AppEdge[],
    connectMode: 'wire' as const,
  }
  const conn = { source: 'bus', sourceHandle: 'c0', target: 'ld', targetHandle: 't1' }

  it('still refuses a duplicate of another edge', () => {
    expect(validateConnection(conn, state)).toMatch(/already connected/)
  })

  it('lets the edge being re-routed land back on its own terminals', () => {
    expect(validateConnection(conn, state, 'e1')).toBeNull()
  })

  it('keeps every other rule in force for the exempt edge', () => {
    expect(validateConnection({ source: 'ld', target: 'ld' }, state, 'e1')).toMatch(/itself/)
  })
})
