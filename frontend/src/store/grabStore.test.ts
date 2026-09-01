import { beforeEach, describe, expect, it } from 'vitest'
import type { HandleCandidate } from '../lib/grabTarget'
import { endGesture, useCircuitStore, type AppEdge, type AppNode } from './circuitStore'
import {
  createGrabSession,
  prospectiveConnection,
  useGrabStore,
  type GrabStart,
} from './grabStore'
import { useResultsStore } from './resultsStore'

// A busbar feeding one load through a line, plus a spare load to re-route to.
// Terminals sit on a 100px client grid; the flow projection is 1:1 here.
const HANDLES: HandleCandidate[] = [
  { nodeId: 'bus', handleId: 'c0', x: 0, y: 0 },
  { nodeId: 'bus', handleId: 'c1', x: 20, y: 0 },
  { nodeId: 'load1', handleId: 't1', x: 0, y: 100 },
  { nodeId: 'load2', handleId: 't1', x: 200, y: 100 },
]

function node(id: string, type: string): AppNode {
  return { id, type, position: { x: 0, y: 0 }, data: { params: {} } } as AppNode
}

const LINE: AppEdge = {
  id: 'e1',
  type: 'line',
  source: 'bus',
  sourceHandle: 'c0',
  target: 'load1',
  targetHandle: 't1',
  data: { params: { name: 'LN1', length: 2.5 }, waypoints: [{ x: 0, y: 50 }] },
}

function reset() {
  useCircuitStore.setState({
    name: 'test',
    nodes: [node('bus', 'busbar'), node('load1', 'load'), node('load2', 'load')],
    edges: [{ ...LINE, data: { ...LINE.data! } }],
    busNames: {},
    loadShapes: {},
    placementType: null,
    connectMode: 'wire',
    dirty: false,
  })
  useResultsStore.setState({ flash: null, issues: [], result: null })
  useCircuitStore.temporal.getState().clear()
  useGrabStore.setState({ edgeId: null, end: 'source', cursor: null, target: null, refusal: null })
  endGesture()
}

beforeEach(reset)

/** Grab the load1 end of the line (its target end). */
function grabLoadEnd(overrides: Partial<GrabStart> = {}) {
  return createGrabSession({
    edgeId: 'e1',
    end: 'target',
    fixed: { nodeId: 'bus', handleId: 'c0' },
    startClient: { x: 0, y: 100 },
    project: (p) => p,
    getZoom: () => 1,
    collect: () => HANDLES,
    ...overrides,
  })
}

const edge = () => useCircuitStore.getState().edges[0]

describe('prospectiveConnection', () => {
  const start: GrabStart = {
    edgeId: 'e1',
    end: 'target',
    fixed: { nodeId: 'bus', handleId: 'c0' },
    startClient: { x: 0, y: 0 },
    project: (p) => p,
    getZoom: () => 1,
  }

  it('keeps the edge orientation when the target end moves', () => {
    expect(prospectiveConnection(start, HANDLES[3])).toEqual({
      source: 'bus',
      sourceHandle: 'c0',
      target: 'load2',
      targetHandle: 't1',
    })
  })

  it('keeps the edge orientation when the source end moves', () => {
    const fromSource: GrabStart = { ...start, end: 'source', fixed: { nodeId: 'load1', handleId: 't1' } }
    expect(prospectiveConnection(fromSource, HANDLES[1])).toEqual({
      source: 'bus',
      sourceHandle: 'c1',
      target: 'load1',
      targetHandle: 't1',
    })
  })
})

describe('grab gesture', () => {
  it('ignores movement below the drag threshold', () => {
    const s = grabLoadEnd()
    s.move({ x: 2, y: 100 })
    expect(useGrabStore.getState().edgeId).toBeNull()
    expect(s.release()).toBe(false)
    expect(edge().target).toBe('load1')
  })

  it('picks up the edge once the threshold is passed', () => {
    const s = grabLoadEnd()
    s.move({ x: 60, y: 140 })
    const grab = useGrabStore.getState()
    expect(grab.edgeId).toBe('e1')
    expect(grab.end).toBe('target')
    expect(grab.cursor).toEqual({ x: 60, y: 140 })
    expect(grab.target).toBeNull()
    s.cancel()
  })

  it('snaps the preview onto a terminal within the drop radius', () => {
    const s = grabLoadEnd()
    s.move({ x: 190, y: 108 })
    const grab = useGrabStore.getState()
    expect(grab.target).toEqual(HANDLES[3])
    expect(grab.refusal).toBeNull()
    expect(grab.cursor).toEqual({ x: 200, y: 100 })
    s.cancel()
  })

  it('scales the drop radius with the zoom level', () => {
    const zoomedOut = grabLoadEnd({ getZoom: () => 0.5 })
    zoomedOut.move({ x: 175, y: 100 }) // 25px away: inside 30, outside 15
    expect(useGrabStore.getState().target).toBeNull()
    zoomedOut.cancel()
  })

  it('moves the endpoint on a valid drop, keeping the edge id and params', () => {
    const s = grabLoadEnd()
    s.move({ x: 198, y: 100 })
    expect(s.release()).toBe(true)
    const e = edge()
    expect(e.id).toBe('e1')
    expect(e.type).toBe('line')
    expect(e.target).toBe('load2')
    expect(e.targetHandle).toBe('t1')
    expect(e.source).toBe('bus') // the far end stayed put
    expect(e.sourceHandle).toBe('c0')
    expect(e.data?.params).toEqual({ name: 'LN1', length: 2.5 })
    expect(useCircuitStore.getState().edges).toHaveLength(1) // moved, not added
    expect(useGrabStore.getState().edgeId).toBeNull()
  })

  it('records exactly one undo step for the whole drag', () => {
    const s = grabLoadEnd()
    s.move({ x: 60, y: 140 })
    s.move({ x: 120, y: 120 })
    s.move({ x: 198, y: 100 })
    s.release()
    expect(useCircuitStore.temporal.getState().pastStates).toHaveLength(1)
    useCircuitStore.temporal.getState().undo()
    expect(edge().target).toBe('load1')
  })

  it('leaves the circuit untouched when the drag is cancelled', () => {
    const before = JSON.stringify(useCircuitStore.getState().edges)
    const s = grabLoadEnd()
    s.move({ x: 198, y: 100 })
    s.cancel()
    expect(JSON.stringify(useCircuitStore.getState().edges)).toBe(before)
    expect(useCircuitStore.temporal.getState().pastStates).toHaveLength(0)
    expect(useGrabStore.getState().edgeId).toBeNull()
  })

  it('does nothing when released over empty canvas', () => {
    const s = grabLoadEnd()
    s.move({ x: 400, y: 400 })
    expect(s.release()).toBe(true)
    expect(edge().target).toBe('load1')
    expect(useResultsStore.getState().flash).toBeNull()
  })

  it('refuses a drop that would break a connection rule, and says why', () => {
    const s = grabLoadEnd()
    s.move({ x: 20, y: 2 }) // another handle of the busbar this line leaves from
    const grab = useGrabStore.getState()
    expect(grab.target).toEqual(HANDLES[1])
    expect(grab.refusal).toMatch(/cannot be connected to itself/i)
    expect(grab.cursor).toEqual({ x: 20, y: 0 }) // no snap onto a refused terminal
    s.release()
    expect(edge().target).toBe('load1') // unchanged
    expect(useResultsStore.getState().flash).toMatch(/cannot be connected to itself/i)
  })

  it('refuses a terminal the far end is already wired to', () => {
    // A second wire already joins bus:c0 to load2:t1 — exactly the pair that
    // dropping this line's end on load2 would produce.
    useCircuitStore.setState({
      edges: [
        useCircuitStore.getState().edges[0],
        { id: 'e2', type: 'wire', source: 'bus', sourceHandle: 'c0', target: 'load2', targetHandle: 't1' },
      ],
    })
    const s = grabLoadEnd()
    s.move({ x: 198, y: 100 })
    expect(useGrabStore.getState().refusal).toMatch(/already connected/i)
    s.release()
    expect(edge().target).toBe('load1')
  })

  it('allows dropping an end back where it started (a no-op, not a duplicate)', () => {
    const s = grabLoadEnd()
    s.move({ x: 0, y: 100 })
    expect(useGrabStore.getState().refusal).toBeNull()
    s.release()
    expect(edge().target).toBe('load1')
    expect(useCircuitStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('never snaps to the far end of the edge being dragged', () => {
    const s = grabLoadEnd()
    s.move({ x: 0, y: 4 }) // right on bus:c0, this line's own fixed end
    expect(useGrabStore.getState().target).toBeNull()
    s.cancel()
  })
})
