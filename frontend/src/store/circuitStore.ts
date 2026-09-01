import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import { temporal } from 'zundo'
import { create } from 'zustand'
import { defaultLineParams, defaultParams, nextName, NODE_SIZE, SYMBOL_PITCH } from '../lib/defaults'
import { insertPoint, interiorPoints, simplifyCollinear } from '../lib/edgeGeometry'
import type { CircuitJSON, EdgeKind, LoadShapeJSON, NodeType, Params } from '../types/circuit'
import { useResultsStore } from './resultsStore'

export interface XY {
  x: number
  y: number
}

export type AppNode = Node<{ params: Params }>
export type AppEdge = Edge<{ params: Params; waypoints?: XY[] }>

export interface CircuitState {
  name: string
  nodes: AppNode[]
  edges: AppEdge[]
  busNames: Record<string, string>
  /** Circuit-level loadshape library, keyed by shape name. Always replaced
   *  wholesale (never mutated) so undo can compare it by reference. */
  loadShapes: Record<string, LoadShapeJSON>
  placementType: NodeType | null
  connectMode: EdgeKind
  /** True when there are changes not yet saved to a project file. */
  dirty: boolean
  markSaved: () => void

  onNodesChange: (changes: NodeChange<AppNode>[]) => void
  onEdgesChange: (changes: EdgeChange<AppEdge>[]) => void
  onConnect: (conn: Connection) => void
  addNodeAt: (type: NodeType, pos: XY) => void
  addBusbarAt: (pos: XY, width: number) => void
  updateNodeParams: (id: string, patch: Params) => void
  updateEdgeParams: (id: string, patch: Params) => void
  /** Move one end of an existing edge to another terminal (the grab
   *  gesture); the edge keeps its id, kind and parameters. */
  reconnectEdgeEnd: (id: string, end: EdgeEnd, nodeId: string, handleId: string) => void
  setEdgeWaypoints: (id: string, waypoints: XY[]) => void
  /** Add a routing point where the user clicked. `rendered` is the polyline
   *  the edge is currently drawn as (endpoints included), read off the screen
   *  by the caller; passing it keeps the edge's shape exactly as it looks. */
  addEdgeWaypoint: (id: string, pos: XY, rendered?: XY[] | null) => void
  setBusbarWidth: (id: string, width: number) => void
  setName: (name: string) => void
  setPlacement: (t: NodeType | null) => void
  setConnectMode: (m: EdgeKind) => void
  selectOnly: (kind: 'node' | 'edge', id: string) => void
  mergeBusNames: (names: Record<string, string>) => void
  setLoadShape: (name: string, spec: LoadShapeJSON) => void
  /** Delete a shape and clear any element params still referencing it. */
  deleteLoadShape: (name: string) => void
  /** Rename a shape and rewrite element references to it. */
  renameLoadShape: (oldName: string, newName: string) => void
  loadCircuit: (c: CircuitJSON) => void
  clearAll: () => void

  /** Copy the selection to the in-memory clipboard; returns elements copied. */
  copySelection: () => number
  pasteClipboard: () => void
  duplicateSelection: () => void
  /** Rotate the given symbol nodes 90° clockwise (busbars are skipped). */
  rotateNodes: (ids: string[]) => void
  rotateSelection: () => void
}

let idSeq = 0
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${++idSeq}`

function markStale() {
  useResultsStore.getState().markStale()
}

// ---------------------------------------------------------------------------
// Undo gestures: while a continuous gesture (drag, resize) is in progress the
// temporal store records only the first change, so the whole gesture undoes
// as one step. Everything outside a gesture records per action.
let inGesture = false
let gestureRecorded = false
export function beginGesture(): void {
  inGesture = true
  gestureRecorded = false
}
export function endGesture(): void {
  inGesture = false
}

// ---------------------------------------------------------------------------
// Clipboard for copy/paste/duplicate — in-memory, survives circuit switches.
interface Clipboard {
  nodes: AppNode[]
  edges: AppEdge[]
}
let clipboard: Clipboard | null = null
let pasteCount = 0

const NAME_PREFIX: Record<string, string> = {
  vsource: 'SRC',
  busbar: 'BUS',
  transformer: 'T',
  load: 'LOAD',
  breaker: 'BRK',
  capacitor: 'CAP',
  generator: 'GEN',
  pvsystem: 'PV',
  storage: 'BAT',
}

const PASTE_OFFSET = 30

/** Every element name currently in use on the canvas. */
function takenNames(s: Pick<CircuitState, 'nodes' | 'edges'>): Set<string> {
  const names = new Set<string>()
  for (const n of s.nodes) if (typeof n.data.params.name === 'string') names.add(n.data.params.name)
  for (const e of s.edges) {
    const nm = e.data?.params?.name
    if (typeof nm === 'string') names.add(nm)
  }
  return names
}

function uniqueName(prefix: string, taken: Set<string>): string {
  let name = nextName(prefix)
  while (taken.has(name)) name = nextName(prefix)
  taken.add(name)
  return name
}

/** Fresh copies of a node/edge set: new ids, remapped endpoints, regenerated
 *  names (so OpenDSS never sees duplicates), positions shifted by offset. */
function materializeClones(clip: Clipboard, offset: XY, taken: Set<string>): Clipboard {
  const idMap = new Map<string, string>()
  const nodes: AppNode[] = clip.nodes.map((n) => {
    const id = newId('n')
    idMap.set(n.id, id)
    const params: Params = { ...n.data.params }
    if (typeof params.name === 'string') {
      params.name = uniqueName(NAME_PREFIX[n.type as string] ?? 'EL', taken)
    }
    return {
      ...n,
      id,
      selected: true,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      data: { params },
    }
  })
  const edges: AppEdge[] = clip.edges.map((e) => {
    const params: Params = { ...(e.data?.params ?? {}) }
    if (typeof params.name === 'string') params.name = uniqueName('LN', taken)
    return {
      ...e,
      id: newId('e'),
      selected: true,
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
      data: {
        params,
        waypoints: e.data?.waypoints?.map((w) => ({ x: w.x + offset.x, y: w.y + offset.y })),
      },
    }
  })
  return { nodes, edges }
}

/** Selected nodes plus the edges whose BOTH endpoints are selected. */
function selectionClipboard(s: Pick<CircuitState, 'nodes' | 'edges'>): Clipboard | null {
  const ids = new Set(s.nodes.filter((n) => n.selected).map((n) => n.id))
  if (!ids.size) return null
  return structuredClone({
    nodes: s.nodes.filter((n) => ids.has(n.id)),
    edges: s.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  })
}

/** Which end of an edge a gesture is acting on. */
export type EdgeEnd = 'source' | 'target'

export function terminalKey(nodeId: string, handleId: string): string {
  return `${nodeId}:${handleId}`
}

// Terminal -> edge ids, memoized on the edges array identity: every Terminal
// component asks this on every store update, so it must not rescan the edge
// list once per handle.
let termMapCache: { edges: AppEdge[]; map: Map<string, string[]> } | null = null

/** Map of "<nodeId>:<handleId>" to the ids of the edges landing there.
 *  Edges saved without an explicit handle default to t1, matching the
 *  backend's terminal convention. */
export function terminalEdgeMap(edges: AppEdge[]): Map<string, string[]> {
  if (termMapCache?.edges === edges) return termMapCache.map
  const map = new Map<string, string[]>()
  const add = (nodeId: string, handleId: string | null | undefined, id: string) => {
    const key = terminalKey(nodeId, handleId ?? 't1')
    const list = map.get(key)
    if (list) list.push(id)
    else map.set(key, [id])
  }
  for (const e of edges) {
    add(e.source, e.sourceHandle, e.id)
    add(e.target, e.targetHandle, e.id)
  }
  termMapCache = { edges, map }
  return map
}

/** Ids of the edges attached to one terminal. */
export function edgesAtTerminal(
  s: Pick<CircuitState, 'edges'>,
  nodeId: string,
  handleId: string,
): string[] {
  return terminalEdgeMap(s.edges).get(terminalKey(nodeId, handleId)) ?? []
}

/** Number of connection handles per row a busbar of a given width exposes.
 *  Rows: b<i> along the top edge, c<i> along the bottom edge. */
export function busbarHandleCount(width: number): number {
  return Math.max(2, Math.floor(width / SYMBOL_PITCH))
}

const snapGrid = (v: number) => Math.round(v / 10) * 10

const snapPosition = (p: XY): XY => ({ x: snapGrid(p.x), y: snapGrid(p.y) })

/** Busbar widths stay on the symbol pitch so the handles, spaced width/count
 *  apart, land exactly on the grid alongside every symbol terminal. */
export function snapBusbarWidth(width: number): number {
  return Math.max(60, Math.round(width / SYMBOL_PITCH) * SYMBOL_PITCH)
}

/** Why a proposed connection is not allowed, or null if it is fine. */
export function validateConnection(
  conn: { source: string | null; sourceHandle?: string | null; target: string | null; targetHandle?: string | null },
  state?: Pick<CircuitState, 'nodes' | 'edges' | 'connectMode'>,
  /** Edge exempt from the duplicate check — the one being re-routed, which
   *  would otherwise report itself as an existing connection. */
  ignoreEdgeId?: string,
): string | null {
  const s = state ?? useCircuitStore.getState()
  if (!conn.source || !conn.target) return 'Connection is missing an endpoint.'
  if (conn.source === conn.target) return 'An element cannot be connected to itself.'
  const src = s.nodes.find((n) => n.id === conn.source)
  const tgt = s.nodes.find((n) => n.id === conn.target)
  if (!src || !tgt) return 'Connection references a missing element.'
  if (src.type === 'busbar' && tgt.type === 'busbar' && s.connectMode === 'wire') {
    return 'Two busbars cannot be joined by a plain wire — use a Line or a breaker between them.'
  }
  const dup = s.edges.some(
    (e) =>
      e.id !== ignoreEdgeId &&
      ((e.source === conn.source &&
        e.target === conn.target &&
        (e.sourceHandle ?? null) === (conn.sourceHandle ?? null) &&
        (e.targetHandle ?? null) === (conn.targetHandle ?? null)) ||
        (e.source === conn.target &&
          e.target === conn.source &&
          (e.sourceHandle ?? null) === (conn.targetHandle ?? null) &&
          (e.targetHandle ?? null) === (conn.sourceHandle ?? null))),
  )
  if (dup) return 'These terminals are already connected.'
  return null
}

function nodeCenter(n: AppNode): XY {
  const size = NODE_SIZE[(n.type as NodeType) ?? 'load']
  const w = (n.width as number) ?? size.w
  return { x: n.position.x + w / 2, y: n.position.y + size.h / 2 }
}

export function toCircuitJSON(
  s: Pick<CircuitState, 'name' | 'nodes' | 'edges' | 'busNames' | 'loadShapes'>,
): CircuitJSON {
  return {
    version: 1,
    name: s.name,
    nodes: s.nodes.map((n) => ({
      id: n.id,
      type: n.type as NodeType,
      position: n.position,
      width: (n.width ?? (n.style?.width as number)) || null,
      params: n.data.params,
    })),
    edges: s.edges.map((e) => ({
      id: e.id,
      type: (e.type as EdgeKind) ?? 'wire',
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      params: e.data?.params ?? {},
      waypoints: e.data?.waypoints?.length ? e.data.waypoints : null,
    })),
    busNames: s.busNames,
    loadShapes: s.loadShapes,
  }
}

export function fromCircuitJSON(c: CircuitJSON): { nodes: AppNode[]; edges: AppEdge[] } {
  const nodes: AppNode[] = c.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    // Re-snap on load. Positions are top-left corners, and circuits saved
    // before the symbol boxes were put on SYMBOL_PITCH recorded corners that
    // no longer put the terminal on the grid — leaving every busbar wire with
    // a few pixels of bend until the node was dragged once. Snapping here
    // moves a node by at most half a grid step and makes old files open
    // aligned. Busbar widths are re-snapped for the same reason.
    position: snapPosition(n.position ?? { x: 0, y: 0 }),
    data: { params: n.params },
    ...(n.type === 'busbar'
      ? {
          width: snapBusbarWidth(n.width ?? NODE_SIZE.busbar.w),
          height: NODE_SIZE.busbar.h,
        }
      : {}),
  }))
  const edges: AppEdge[] = c.edges.map((e) => ({
    id: e.id,
    type: e.type,
    source: e.source,
    sourceHandle: e.sourceHandle ?? undefined,
    target: e.target,
    targetHandle: e.targetHandle ?? undefined,
    data: { params: e.params ?? {}, waypoints: e.waypoints ?? undefined },
  }))
  return { nodes, edges }
}

export const useCircuitStore = create<CircuitState>()(
  temporal(
    (set, get) => ({
      name: 'my-circuit',
      nodes: [],
      edges: [],
      busNames: {},
      loadShapes: {},
      placementType: null,
      connectMode: 'wire',
      dirty: false,
      markSaved: () => set({ dirty: false }),

      onNodesChange: (changes) => {
        set({ nodes: applyNodeChanges(changes, get().nodes) })
        if (changes.some((ch) => ch.type !== 'select' && ch.type !== 'dimensions')) {
          set({ dirty: true })
          markStale()
        }
      },
      onEdgesChange: (changes) => {
        set({ edges: applyEdgeChanges(changes, get().edges) })
        if (changes.some((ch) => ch.type !== 'select')) {
          set({ dirty: true })
          markStale()
        }
      },
      onConnect: (conn) => {
        const reason = validateConnection(conn, get())
        if (reason) {
          useResultsStore.getState().setFlash(reason)
          return
        }
        // Connections drawn while a placement mode is active default to plain
        // wire — you're dropping components and hooking them up as you go.
        const kind = get().placementType ? 'wire' : get().connectMode
        const edge: AppEdge = {
          id: newId('e'),
          type: kind,
          source: conn.source,
          sourceHandle: conn.sourceHandle ?? undefined,
          target: conn.target,
          targetHandle: conn.targetHandle ?? undefined,
          data: { params: kind === 'line' ? defaultLineParams() : {} },
        }
        set({ edges: [...get().edges, edge], dirty: true })
        markStale()
      },
      // Placement mode is sticky: keep dropping elements until Escape or the
      // palette item is toggled off.
      addNodeAt: (type, pos) => {
        const size = NODE_SIZE[type]
        const node: AppNode = {
          id: newId('n'),
          type,
          // Snap the corner, not the click point: React Flow's snapGrid moves
          // the corner on the first drag, so a node dropped on a half-grid
          // corner would visibly jump and lose terminal alignment.
          position: { x: snapGrid(pos.x - size.w / 2), y: snapGrid(pos.y - size.h / 2) },
          data: { params: defaultParams(type) },
          ...(type === 'busbar' ? { width: size.w, height: size.h } : {}),
        }
        set({ nodes: [...get().nodes, node], dirty: true })
        markStale()
      },
      // Drag-sized busbar: pos is the LEFT edge of the bar (vertically centered).
      addBusbarAt: (pos, width) => {
        const node: AppNode = {
          id: newId('n'),
          type: 'busbar',
          position: { x: snapGrid(pos.x), y: snapGrid(pos.y - NODE_SIZE.busbar.h / 2) },
          width: snapBusbarWidth(width),
          height: NODE_SIZE.busbar.h,
          data: { params: defaultParams('busbar') },
        }
        set({ nodes: [...get().nodes, node], dirty: true })
        markStale()
      },
      updateNodeParams: (id, patch) => {
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { params: { ...n.data.params, ...patch } } } : n,
          ),
          dirty: true,
        })
        markStale()
      },
      updateEdgeParams: (id, patch) => {
        set({
          edges: get().edges.map((e) =>
            e.id === id
              ? { ...e, data: { ...e.data, params: { ...(e.data?.params ?? {}), ...patch } } }
              : e,
          ),
          dirty: true,
        })
        markStale()
      },
      // The grab gesture (drag an existing connection off its terminal onto
      // another one). Routing waypoints survive a move between handles of the
      // same node — where they still describe the same path — but are dropped
      // when the end lands on a different node, where the old polyline would
      // be meaningless.
      reconnectEdgeEnd: (id, end, nodeId, handleId) => {
        const edge = get().edges.find((e) => e.id === id)
        if (!edge) return
        const wasNode = end === 'source' ? edge.source : edge.target
        const wasHandle = (end === 'source' ? edge.sourceHandle : edge.targetHandle) ?? null
        if (wasNode === nodeId && wasHandle === handleId) return // dropped where it started
        const moved: AppEdge = {
          ...edge,
          ...(end === 'source'
            ? { source: nodeId, sourceHandle: handleId }
            : { target: nodeId, targetHandle: handleId }),
          data: {
            params: edge.data?.params ?? {},
            waypoints: wasNode === nodeId ? edge.data?.waypoints : undefined,
          },
        }
        set({ edges: get().edges.map((e) => (e.id === id ? moved : e)), dirty: true })
        markStale()
      },
      // Waypoints are routing cosmetics only — unsaved, but no markStale.
      setEdgeWaypoints: (id, waypoints) => {
        set({
          edges: get().edges.map((e) =>
            e.id === id
              ? { ...e, data: { params: e.data?.params ?? {}, waypoints } }
              : e,
          ),
          dirty: true,
        })
      },
      addEdgeWaypoint: (id, pos, rendered) => {
        const edge = get().edges.find((e) => e.id === id)
        if (!edge) return
        const wps = edge.data?.waypoints ?? []
        // Prefer the polyline actually on screen. Without waypoints that is
        // ReactFlow's smoothstep path, whose corners are adopted as waypoints
        // so the edge keeps the shape it had when it was clicked; with
        // waypoints it is our own polyline, which indexes the click exactly.
        const drawn = rendered && rendered.length >= 2 ? rendered : null
        const usable = drawn && (!wps.length || drawn.length === wps.length + 2)
        const src = get().nodes.find((n) => n.id === edge.source)
        const tgt = get().nodes.find((n) => n.id === edge.target)
        const pts = usable
          ? wps.length
            ? drawn!
            : simplifyCollinear(drawn!)
          : // Fall back to a straight run between the node centers.
            src && tgt
            ? [nodeCenter(src), ...wps, nodeCenter(tgt)]
            : []
        if (pts.length < 2) {
          get().setEdgeWaypoints(id, [...wps, pos])
          return
        }
        const { index, point } = insertPoint(pts, pos)
        const base = wps.length ? [...wps] : interiorPoints(pts)
        base.splice(index, 0, point)
        get().setEdgeWaypoints(id, base)
      },
      setBusbarWidth: (id, rawWidth) => {
        const width = snapBusbarWidth(rawWidth)
        const count = busbarHandleCount(width)
        // Re-home edges whose handle no longer exists after a shrink.
        const rehome = (h: string | undefined | null, nodeId: string) => {
          if (nodeId !== id || !h) return h ?? undefined
          const m = h.match(/^([bc])(\d+)$/)
          if (!m) return h
          return Number(m[2]) >= count ? `${m[1]}${count - 1}` : h
        }
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, width } : n)),
          edges: get().edges.map((e) => ({
            ...e,
            sourceHandle: rehome(e.sourceHandle, e.source),
            targetHandle: rehome(e.targetHandle, e.target),
          })),
          dirty: true,
        })
        markStale()
      },
      setName: (name) => set({ name, dirty: true }),
      setPlacement: (t) => set({ placementType: t }),
      // Choosing a connect mode is an explicit "I'm drawing wires/lines now",
      // so it exits placement mode — otherwise onConnect's while-placing
      // wire default would silently override a freshly picked Line mode.
      setConnectMode: (m) => set({ connectMode: m, placementType: null }),
      selectOnly: (kind, id) => {
        set({
          nodes: get().nodes.map((n) => ({ ...n, selected: kind === 'node' && n.id === id })),
          edges: get().edges.map((e) => ({ ...e, selected: kind === 'edge' && e.id === id })),
        })
      },
      mergeBusNames: (names) => set({ busNames: { ...get().busNames, ...names } }),
      setLoadShape: (name, spec) => {
        set({ loadShapes: { ...get().loadShapes, [name]: spec }, dirty: true })
        markStale()
      },
      deleteLoadShape: (name) => {
        const { [name]: _gone, ...rest } = get().loadShapes
        set({
          loadShapes: rest,
          nodes: get().nodes.map((n) =>
            n.data.params.loadshape === name
              ? { ...n, data: { params: { ...n.data.params, loadshape: '' } } }
              : n,
          ),
          dirty: true,
        })
        markStale()
      },
      renameLoadShape: (oldName, newName) => {
        if (oldName === newName || !newName) return
        const { [oldName]: spec, ...rest } = get().loadShapes
        if (!spec) return
        set({
          loadShapes: { ...rest, [newName]: spec },
          nodes: get().nodes.map((n) =>
            n.data.params.loadshape === oldName
              ? { ...n, data: { params: { ...n.data.params, loadshape: newName } } }
              : n,
          ),
          dirty: true,
        })
        markStale()
      },
      // Opening a project file leaves the store clean; the autosave-restore
      // path in App re-marks dirty afterward since that work isn't in a file.
      loadCircuit: (c) => {
        const { nodes, edges } = fromCircuitJSON(c)
        set({
          name: c.name,
          nodes,
          edges,
          busNames: c.busNames ?? {},
          loadShapes: c.loadShapes ?? {},
          dirty: false,
        })
        markStale()
      },
      clearAll: () => {
        set({ nodes: [], edges: [], busNames: {}, loadShapes: {}, dirty: true })
        markStale()
      },

      copySelection: () => {
        const clip = selectionClipboard(get())
        if (!clip) return 0
        clipboard = clip
        pasteCount = 0
        return clip.nodes.length
      },
      pasteClipboard: () => {
        if (!clipboard) return
        pasteCount += 1
        const off = PASTE_OFFSET * pasteCount
        const { nodes, edges } = materializeClones(clipboard, { x: off, y: off }, takenNames(get()))
        set({
          nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), ...nodes],
          edges: [...get().edges.map((e) => ({ ...e, selected: false })), ...edges],
          dirty: true,
        })
        markStale()
      },
      duplicateSelection: () => {
        const clip = selectionClipboard(get())
        if (!clip) return
        const { nodes, edges } = materializeClones(clip, { x: PASTE_OFFSET, y: PASTE_OFFSET }, takenNames(get()))
        set({
          nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), ...nodes],
          edges: [...get().edges.map((e) => ({ ...e, selected: false })), ...edges],
          dirty: true,
        })
        markStale()
      },
      // Rotation is diagram cosmetics (stored in params, ignored by the
      // compiler) — dirty for saving, but results stay valid.
      rotateNodes: (ids) => {
        const idSet = new Set(ids)
        if (!idSet.size) return
        set({
          nodes: get().nodes.map((n) =>
            idSet.has(n.id) && n.type !== 'busbar'
              ? {
                  ...n,
                  data: {
                    params: {
                      ...n.data.params,
                      rotation: ((Number(n.data.params.rotation) || 0) + 90) % 360,
                    },
                  },
                }
              : n,
          ),
          dirty: true,
        })
      },
      rotateSelection: () => {
        get().rotateNodes(get().nodes.filter((n) => n.selected).map((n) => n.id))
      },
    }),
    {
      // Selection flags are stripped so clicking around never pollutes the
      // undo history (equality below then sees those states as identical).
      partialize: (s) => ({
        name: s.name,
        nodes: s.nodes.map(({ selected: _s, ...n }) => n),
        edges: s.edges.map(({ selected: _s, ...e }) => e),
        busNames: s.busNames,
        loadShapes: s.loadShapes,
      }),
      limit: 100,
      // Structural compare; fine at editor scale (revisit if circuits reach
      // thousands of elements). loadShapes is compared by reference — shape
      // actions always replace the whole object, and stringifying 8760-point
      // arrays on every unrelated set would be wasteful.
      equality: (past, cur) => {
        if (past.loadShapes !== cur.loadShapes) return false
        const { loadShapes: _p, ...pastRest } = past
        const { loadShapes: _c, ...curRest } = cur
        return JSON.stringify(pastRest) === JSON.stringify(curRest)
      },
      // One undo entry per gesture (drag/resize), one per discrete action.
      handleSet: (handleSet) => (state) => {
        if (inGesture) {
          if (gestureRecorded) return
          gestureRecorded = true
        }
        handleSet(state)
      },
    },
  ),
)

export const undo = () => useCircuitStore.temporal.getState().undo()
export const redo = () => useCircuitStore.temporal.getState().redo()
