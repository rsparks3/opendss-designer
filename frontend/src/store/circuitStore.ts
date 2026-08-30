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
import { defaultLineParams, defaultParams, NODE_SIZE } from '../lib/defaults'
import type { CircuitJSON, EdgeKind, NodeType, Params } from '../types/circuit'
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
  setEdgeWaypoints: (id: string, waypoints: XY[]) => void
  addEdgeWaypoint: (id: string, pos: XY) => void
  setBusbarWidth: (id: string, width: number) => void
  setName: (name: string) => void
  setPlacement: (t: NodeType | null) => void
  setConnectMode: (m: EdgeKind) => void
  selectOnly: (kind: 'node' | 'edge', id: string) => void
  mergeBusNames: (names: Record<string, string>) => void
  loadCircuit: (c: CircuitJSON) => void
  clearAll: () => void
}

let idSeq = 0
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${++idSeq}`

function markStale() {
  useResultsStore.getState().markStale()
}

/** Number of connection handles per row a busbar of a given width exposes.
 *  Rows: b<i> along the top edge, c<i> along the bottom edge. */
export function busbarHandleCount(width: number): number {
  return Math.max(2, Math.floor(width / 20))
}

/** Why a proposed connection is not allowed, or null if it is fine. */
export function validateConnection(
  conn: { source: string | null; sourceHandle?: string | null; target: string | null; targetHandle?: string | null },
  state?: Pick<CircuitState, 'nodes' | 'edges' | 'connectMode'>,
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
      (e.source === conn.source &&
        e.target === conn.target &&
        (e.sourceHandle ?? null) === (conn.sourceHandle ?? null) &&
        (e.targetHandle ?? null) === (conn.targetHandle ?? null)) ||
      (e.source === conn.target &&
        e.target === conn.source &&
        (e.sourceHandle ?? null) === (conn.targetHandle ?? null) &&
        (e.targetHandle ?? null) === (conn.sourceHandle ?? null)),
  )
  if (dup) return 'These terminals are already connected.'
  return null
}

function nodeCenter(n: AppNode): XY {
  const size = NODE_SIZE[(n.type as NodeType) ?? 'load']
  const w = (n.width as number) ?? size.w
  return { x: n.position.x + w / 2, y: n.position.y + size.h / 2 }
}

export function toCircuitJSON(s: Pick<CircuitState, 'name' | 'nodes' | 'edges' | 'busNames'>): CircuitJSON {
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
  }
}

export function fromCircuitJSON(c: CircuitJSON): { nodes: AppNode[]; edges: AppEdge[] } {
  const nodes: AppNode[] = c.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position ?? { x: 0, y: 0 },
    data: { params: n.params },
    ...(n.type === 'busbar'
      ? { width: n.width ?? NODE_SIZE.busbar.w, height: NODE_SIZE.busbar.h }
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
        const kind = get().connectMode
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
          position: { x: pos.x - size.w / 2, y: pos.y - size.h / 2 },
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
          position: { x: pos.x, y: pos.y - NODE_SIZE.busbar.h / 2 },
          width: Math.max(60, Math.round(width / 20) * 20),
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
      addEdgeWaypoint: (id, pos) => {
        const edge = get().edges.find((e) => e.id === id)
        if (!edge) return
        const wps = [...(edge.data?.waypoints ?? [])]
        // Insert at the segment of the polyline (endpoint-approximated by node
        // centers) closest to the click.
        const src = get().nodes.find((n) => n.id === edge.source)
        const tgt = get().nodes.find((n) => n.id === edge.target)
        const pts = [
          ...(src ? [nodeCenter(src)] : []),
          ...wps,
          ...(tgt ? [nodeCenter(tgt)] : []),
        ]
        let best = wps.length
        if (pts.length >= 2) {
          let bestD = Infinity
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1]
            const t = Math.max(0, Math.min(1,
              ((pos.x - a.x) * (b.x - a.x) + (pos.y - a.y) * (b.y - a.y)) /
              (((b.x - a.x) ** 2 + (b.y - a.y) ** 2) || 1)))
            const dx = pos.x - (a.x + t * (b.x - a.x))
            const dy = pos.y - (a.y + t * (b.y - a.y))
            const d = dx * dx + dy * dy
            if (d < bestD) {
              bestD = d
              best = src ? i : i + 1 // segment i starts before waypoint i
            }
          }
        }
        wps.splice(best, 0, pos)
        get().setEdgeWaypoints(id, wps)
      },
      setBusbarWidth: (id, width) => {
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
      setConnectMode: (m) => set({ connectMode: m }),
      selectOnly: (kind, id) => {
        set({
          nodes: get().nodes.map((n) => ({ ...n, selected: kind === 'node' && n.id === id })),
          edges: get().edges.map((e) => ({ ...e, selected: kind === 'edge' && e.id === id })),
        })
      },
      mergeBusNames: (names) => set({ busNames: { ...get().busNames, ...names } }),
      // Opening a project file leaves the store clean; the autosave-restore
      // path in App re-marks dirty afterward since that work isn't in a file.
      loadCircuit: (c) => {
        const { nodes, edges } = fromCircuitJSON(c)
        set({ name: c.name, nodes, edges, busNames: c.busNames ?? {}, dirty: false })
        markStale()
      },
      clearAll: () => {
        set({ nodes: [], edges: [], busNames: {}, dirty: true })
        markStale()
      },
    }),
    {
      partialize: (s) => ({ name: s.name, nodes: s.nodes, edges: s.edges, busNames: s.busNames }),
      limit: 100,
      // Group rapid-fire changes (drags) into one undo step.
      handleSet: (handleSet) => {
        let last = 0
        return (state) => {
          const now = Date.now()
          if (now - last > 300) {
            last = now
            handleSet(state)
          }
        }
      },
    },
  ),
)

export const undo = () => useCircuitStore.temporal.getState().undo()
export const redo = () => useCircuitStore.temporal.getState().redo()
