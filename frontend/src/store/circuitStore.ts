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

export type AppNode = Node<{ params: Params }>
export type AppEdge = Edge<{ params: Params }>

export interface CircuitState {
  name: string
  nodes: AppNode[]
  edges: AppEdge[]
  busNames: Record<string, string>
  placementType: NodeType | null
  connectMode: EdgeKind

  onNodesChange: (changes: NodeChange<AppNode>[]) => void
  onEdgesChange: (changes: EdgeChange<AppEdge>[]) => void
  onConnect: (conn: Connection) => void
  addNodeAt: (type: NodeType, pos: { x: number; y: number }) => void
  updateNodeParams: (id: string, patch: Params) => void
  updateEdgeParams: (id: string, patch: Params) => void
  setBusbarWidth: (id: string, width: number) => void
  setName: (name: string) => void
  setPlacement: (t: NodeType | null) => void
  setConnectMode: (m: EdgeKind) => void
  mergeBusNames: (names: Record<string, string>) => void
  loadCircuit: (c: CircuitJSON) => void
  clearAll: () => void
}

let idSeq = 0
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${++idSeq}`

function markStale() {
  useResultsStore.getState().markStale()
}

/** Number of connection handles a busbar of a given width exposes. */
export function busbarHandleCount(width: number): number {
  return Math.max(2, Math.floor(width / 20))
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
    data: { params: e.params ?? {} },
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

      onNodesChange: (changes) => {
        set({ nodes: applyNodeChanges(changes, get().nodes) })
        if (changes.some((ch) => ch.type !== 'select' && ch.type !== 'dimensions')) markStale()
      },
      onEdgesChange: (changes) => {
        set({ edges: applyEdgeChanges(changes, get().edges) })
        if (changes.some((ch) => ch.type !== 'select')) markStale()
      },
      onConnect: (conn) => {
        if (conn.source === conn.target && conn.sourceHandle === conn.targetHandle) return
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
        set({ edges: [...get().edges, edge] })
        markStale()
      },
      addNodeAt: (type, pos) => {
        const size = NODE_SIZE[type]
        const node: AppNode = {
          id: newId('n'),
          type,
          position: { x: pos.x - size.w / 2, y: pos.y - size.h / 2 },
          data: { params: defaultParams(type) },
          ...(type === 'busbar' ? { width: size.w, height: size.h } : {}),
        }
        set({ nodes: [...get().nodes, node], placementType: null })
        markStale()
      },
      updateNodeParams: (id, patch) => {
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { params: { ...n.data.params, ...patch } } } : n,
          ),
        })
        markStale()
      },
      updateEdgeParams: (id, patch) => {
        set({
          edges: get().edges.map((e) =>
            e.id === id ? { ...e, data: { params: { ...(e.data?.params ?? {}), ...patch } } } : e,
          ),
        })
        markStale()
      },
      setBusbarWidth: (id, width) => {
        const count = busbarHandleCount(width)
        // Re-home edges whose handle no longer exists after a shrink.
        const rehome = (h: string | undefined | null, nodeId: string) => {
          if (nodeId !== id || !h || !h.startsWith('b')) return h ?? undefined
          const i = parseInt(h.slice(1), 10)
          return Number.isFinite(i) && i >= count ? `b${count - 1}` : h
        }
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, width } : n)),
          edges: get().edges.map((e) => ({
            ...e,
            sourceHandle: rehome(e.sourceHandle, e.source),
            targetHandle: rehome(e.targetHandle, e.target),
          })),
        })
        markStale()
      },
      setName: (name) => set({ name }),
      setPlacement: (t) => set({ placementType: t }),
      setConnectMode: (m) => set({ connectMode: m }),
      mergeBusNames: (names) => set({ busNames: { ...get().busNames, ...names } }),
      loadCircuit: (c) => {
        const { nodes, edges } = fromCircuitJSON(c)
        set({ name: c.name, nodes, edges, busNames: c.busNames ?? {} })
        markStale()
      },
      clearAll: () => {
        set({ nodes: [], edges: [], busNames: {} })
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
