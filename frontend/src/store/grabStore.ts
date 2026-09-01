// Grab gesture: drag an existing connection off a terminal and drop it on
// another one.
//
// Pressing a terminal that carries exactly one edge picks that edge up instead
// of starting a second connection (see components/nodes/common.tsx). The edge
// being moved *is* the drag preview — useEdgePath draws its grabbed end at the
// cursor — so there is no separate connection line to keep in sync.
//
// State lives here rather than in circuitStore so that a 60fps drag never
// touches the undo history or re-renders the panels; the circuit is written
// exactly once, on a successful drop. The gesture itself is a plain state
// machine (createGrabSession); beginGrab is only the window-event adapter
// around it.
import { create } from 'zustand'
import { collectHandles, nearestHandle, type HandleCandidate } from '../lib/grabTarget'
import { useCircuitStore, validateConnection, type EdgeEnd, type XY } from './circuitStore'
import { useResultsStore } from './resultsStore'

/** Pointer travel (px) before a press on a terminal becomes a grab: below it
 *  the gesture is still a plain click (select, or finish a click-connection). */
const DRAG_THRESHOLD = 4

/** Drop radius in flow units, matching ReactFlow's connectionRadius. */
const SNAP_RADIUS = 30

const snap = (v: number) => Math.round(v / 10) * 10

export interface GrabState {
  /** Edge being moved, or null when no grab is in progress. */
  edgeId: string | null
  end: EdgeEnd
  /** Where the grabbed end currently sits, in flow coordinates. */
  cursor: XY | null
  /** Terminal under the cursor, if any. */
  target: HandleCandidate | null
  /** Why the hovered terminal is refused, or null when the drop is fine. */
  refusal: string | null
}

const IDLE: GrabState = { edgeId: null, end: 'source', cursor: null, target: null, refusal: null }

export const useGrabStore = create<GrabState>()(() => IDLE)

export interface GrabStart {
  edgeId: string
  end: EdgeEnd
  /** The end that stays put, so the drop can be validated. */
  fixed: { nodeId: string; handleId: string }
  /** Client coordinates where the press landed. */
  startClient: XY
  /** Client -> flow coordinates (ReactFlow's screenToFlowPosition). */
  project: (client: XY) => XY
  getZoom: () => number
  /** Terminals available as drop targets; defaults to reading the DOM. */
  collect?: () => HandleCandidate[]
}

export interface GrabSession {
  /** Pointer moved to these client coordinates. */
  move: (client: XY) => void
  /** Pointer released: commits the move when it is over a valid terminal.
   *  Returns true when the gesture had passed the drag threshold. */
  release: () => boolean
  /** Abandon without touching the circuit. */
  cancel: () => void
  /** Forget the cached terminal positions (they are screen coordinates, so
   *  zooming mid-drag invalidates them). */
  invalidate: () => void
}

/** The connection that dropping on `target` would produce, in the edge's own
 *  source/target orientation. */
export function prospectiveConnection(start: GrabStart, target: HandleCandidate) {
  const moved = { node: target.nodeId, handle: target.handleId }
  const fixed = { node: start.fixed.nodeId, handle: start.fixed.handleId }
  const [src, tgt] = start.end === 'source' ? [moved, fixed] : [fixed, moved]
  return { source: src.node, sourceHandle: src.handle, target: tgt.node, targetHandle: tgt.handle }
}

/** The gesture as a state machine, free of any DOM dependency. */
export function createGrabSession(start: GrabStart): GrabSession {
  const collect = start.collect ?? collectHandles
  let handles: HandleCandidate[] = []
  let moved = false
  let live = true

  const clear = () => {
    live = false
    if (useGrabStore.getState().edgeId !== null) useGrabStore.setState(IDLE)
  }

  return {
    move(client) {
      if (!live) return
      if (!moved) {
        const dx = client.x - start.startClient.x
        const dy = client.y - start.startClient.y
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
        moved = true
      }
      if (!handles.length) handles = collect()

      const hit = nearestHandle(handles, client.x, client.y, SNAP_RADIUS * start.getZoom())
      // The far end of this very edge is not something to snap onto.
      const target =
        hit && hit.nodeId === start.fixed.nodeId && hit.handleId === start.fixed.handleId
          ? null
          : hit
      const refusal = target
        ? validateConnection(prospectiveConnection(start, target), undefined, start.edgeId)
        : null

      // Over a valid terminal the preview snaps onto it, showing exactly where
      // the wire will land; free-floating it tracks the grid like a waypoint.
      const cursor =
        target && !refusal
          ? start.project({ x: target.x, y: target.y })
          : (({ x, y }) => ({ x: snap(x), y: snap(y) }))(start.project(client))

      useGrabStore.setState({ edgeId: start.edgeId, end: start.end, cursor, target, refusal })
    },

    release() {
      if (!live) return false
      const { target, refusal } = useGrabStore.getState()
      const wasDrag = moved
      if (moved) {
        if (target && !refusal) {
          useCircuitStore
            .getState()
            .reconnectEdgeEnd(start.edgeId, start.end, target.nodeId, target.handleId)
        } else if (refusal) {
          useResultsStore.getState().setFlash(refusal)
        }
      }
      clear()
      return wasDrag
    },

    cancel: clear,

    invalidate() {
      handles = []
    },
  }
}

let active: { session: GrabSession; detach: () => void } | null = null

/** Swallow the click that closes a completed drag, so releasing over the pane
 *  does not also place a component or clear the selection. */
function swallowNextClick(): void {
  const onClick = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    window.removeEventListener('click', onClick, true)
  }
  window.addEventListener('click', onClick, true)
  // A drag that ends outside any element may not produce a click at all.
  window.setTimeout(() => window.removeEventListener('click', onClick, true), 0)
}

/** Begin a grab from a terminal's mousedown: wires window events to a session. */
export function beginGrab(event: { clientX: number; clientY: number }, start: Omit<GrabStart, 'startClient'>): void {
  cancelGrab()
  const session = createGrabSession({ ...start, startClient: { x: event.clientX, y: event.clientY } })

  const onMove = (e: MouseEvent) => session.move({ x: e.clientX, y: e.clientY })
  const onUp = () => {
    if (session.release()) swallowNextClick()
    detach()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cancelGrab()
  }
  // Zooming mid-drag moves every handle on screen; drop the cached positions.
  const onWheel = () => session.invalidate()
  const detach = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('wheel', onWheel)
    active = null
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('keydown', onKey)
  window.addEventListener('wheel', onWheel)
  active = { session, detach }
}

/** True while this edge is the one being dragged. */
export function useIsGrabbed(edgeId: string): boolean {
  return useGrabStore((s) => s.edgeId === edgeId && s.cursor !== null)
}

/** Abandon any grab in progress (Escape, or a fresh press elsewhere). */
export function cancelGrab(): void {
  active?.session.cancel()
  active?.detach()
}
