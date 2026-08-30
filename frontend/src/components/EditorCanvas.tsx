import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  ViewportPortal,
  type FinalConnectionState,
  type IsValidConnection,
} from '@xyflow/react'
import { useCallback, useEffect, useState } from 'react'
import {
  beginGesture,
  endGesture,
  redo,
  undo,
  useCircuitStore,
  validateConnection,
  type AppEdge,
  type AppNode,
} from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { NodeType } from '../types/circuit'
import { ContextMenu, type MenuTarget } from './ContextMenu'
import { ResultTooltip, type HoverTarget } from './ResultTooltip'
import { BreakerNode } from './nodes/BreakerNode'
import { BusbarNode } from './nodes/BusbarNode'
import { CapacitorNode } from './nodes/CapacitorNode'
import { GeneratorNode } from './nodes/GeneratorNode'
import { LoadNode } from './nodes/LoadNode'
import { TransformerNode } from './nodes/TransformerNode'
import { VsourceNode } from './nodes/VsourceNode'
import { LineEdge } from './edges/LineEdge'
import { WireEdge } from './edges/WireEdge'

const nodeTypes = {
  vsource: VsourceNode,
  busbar: BusbarNode,
  transformer: TransformerNode,
  load: LoadNode,
  breaker: BreakerNode,
  capacitor: CapacitorNode,
  generator: GeneratorNode,
}

const edgeTypes = {
  wire: WireEdge,
  line: LineEdge,
}

const isValidConnection: IsValidConnection<AppEdge> = (conn) =>
  validateConnection(conn) === null

export function EditorCanvas() {
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const onNodesChange = useCircuitStore((s) => s.onNodesChange)
  const onEdgesChange = useCircuitStore((s) => s.onEdgesChange)
  const onConnect = useCircuitStore((s) => s.onConnect)
  const placementType = useCircuitStore((s) => s.placementType)
  const addNodeAt = useCircuitStore((s) => s.addNodeAt)
  const addBusbarAt = useCircuitStore((s) => s.addBusbarAt)
  const setPlacement = useCircuitStore((s) => s.setPlacement)
  const addEdgeWaypoint = useCircuitStore((s) => s.addEdgeWaypoint)
  const flash = useResultsStore((s) => s.flash)
  const flashKind = useResultsStore((s) => s.flashKind)
  const { screenToFlowPosition } = useReactFlow()

  // Busbars are placed by click-dragging to the desired width; a transparent
  // overlay captures that gesture. Other components place on pane clicks so
  // handles stay live — you can wire things up without leaving placement mode.
  const [busbarDraft, setBusbarDraft] = useState<{ start: { x: number; y: number }; cur: { x: number; y: number } } | null>(null)
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const [hover, setHover] = useState<HoverTarget | null>(null)

  const flowPos = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      return { x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 }
    },
    [screenToFlowPosition],
  )

  const onOverlayDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (placementType === 'busbar') {
        const p = flowPos(e)
        setBusbarDraft({ start: p, cur: p })
        e.currentTarget.setPointerCapture(e.pointerId)
      }
    },
    [placementType, flowPos],
  )

  const onOverlayMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (busbarDraft) setBusbarDraft({ start: busbarDraft.start, cur: flowPos(e) })
    },
    [busbarDraft, flowPos],
  )

  const onOverlayUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (placementType !== 'busbar') return
      const p = flowPos(e)
      const start = busbarDraft?.start ?? p
      const width = Math.abs(p.x - start.x)
      if (width < 40) {
        // A plain click drops a default-size bar centered on the click.
        addNodeAt('busbar', start)
      } else {
        addBusbarAt({ x: Math.min(start.x, p.x), y: start.y }, width)
      }
      setBusbarDraft(null)
    },
    [placementType, busbarDraft, flowPos, addNodeAt, addBusbarAt],
  )

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (!placementType || placementType === 'busbar') return
      addNodeAt(placementType, flowPos(event))
    },
    [placementType, flowPos, addNodeAt],
  )

  // Surface WHY a dropped connection was refused.
  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid !== false || !state.toHandle || !state.fromNode || !state.toNode) return
      const reason = validateConnection({
        source: state.fromNode.id,
        sourceHandle: state.fromHandle?.id,
        target: state.toNode.id,
        targetHandle: state.toHandle?.id,
      })
      if (reason) useResultsStore.getState().setFlash(reason)
    },
    [],
  )

  const onEdgeDoubleClick = useCallback(
    (event: React.MouseEvent, edge: AppEdge) => {
      event.stopPropagation()
      const p = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      addEdgeWaypoint(edge.id, { x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 })
    },
    [screenToFlowPosition, addEdgeWaypoint],
  )

  useEffect(() => {
    // Palette placement shortcuts (no modifier). Same letters shown in the
    // palette; W/E switch the connect mode, R rotates the selection.
    const PLACE_KEYS: Record<string, NodeType> = {
      s: 'vsource',
      b: 'busbar',
      t: 'transformer',
      k: 'breaker',
      l: 'load',
      c: 'capacitor',
      g: 'generator',
    }
    const onKey = (e: KeyboardEvent) => {
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
        (e.target as HTMLElement)?.tagName,
      )
      if (e.key === 'Escape') {
        setPlacement(null)
        setBusbarDraft(null)
        setMenu(null)
      }
      if (inField) return
      const st = useCircuitStore.getState()
      const key = e.key.toLowerCase()
      if (e.ctrlKey || e.metaKey) {
        if (key === 'z') {
          e.preventDefault()
          if (e.shiftKey) redo()
          else undo()
        } else if (key === 'y') {
          e.preventDefault()
          redo()
        } else if (key === 'c') {
          const n = st.copySelection()
          if (n) useResultsStore.getState().setFlash(`Copied ${n} element${n > 1 ? 's' : ''}`, 'info', 1500)
        } else if (key === 'v') {
          st.pasteClipboard()
        } else if (key === 'd') {
          e.preventDefault()
          st.duplicateSelection()
        }
        return
      }
      if (e.altKey) return
      if (PLACE_KEYS[key]) {
        setPlacement(st.placementType === PLACE_KEYS[key] ? null : PLACE_KEYS[key])
      } else if (key === 'w') {
        st.setConnectMode('wire')
      } else if (key === 'e') {
        st.setConnectMode('line')
      } else if (key === 'r') {
        st.rotateSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPlacement])

  const onNodeContextMenu = useCallback((e: React.MouseEvent, n: AppNode) => {
    e.preventDefault()
    setHover(null)
    setMenu({ kind: 'node', id: n.id, x: e.clientX, y: e.clientY })
  }, [])
  const onEdgeContextMenu = useCallback((e: React.MouseEvent, ed: AppEdge) => {
    e.preventDefault()
    setHover(null)
    setMenu({ kind: 'edge', id: ed.id, x: e.clientX, y: e.clientY })
  }, [])
  const onNodeMouseEnter = useCallback((e: React.MouseEvent, n: AppNode) => {
    setHover({ kind: 'node', id: n.id, x: e.clientX, y: e.clientY })
  }, [])
  const onEdgeMouseEnter = useCallback((e: React.MouseEvent, ed: AppEdge) => {
    setHover({ kind: 'edge', id: ed.id, x: e.clientX, y: e.clientY })
  }, [])
  const clearHover = useCallback(() => setHover(null), [])
  const onDragStart = useCallback(() => {
    setHover(null)
    beginGesture()
  }, [])

  return (
    <div className={`canvas-wrap${placementType ? ' placing' : ''}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onPaneClick={onPaneClick}
        onEdgeDoubleClick={onEdgeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={(e) => e.preventDefault()}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={clearHover}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={clearHover}
        onNodeDragStart={onDragStart}
        onNodeDragStop={endGesture}
        onSelectionDragStart={onDragStart}
        onSelectionDragStop={endGesture}
        isValidConnection={isValidConnection}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={30}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        snapToGrid
        snapGrid={[10, 10]}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
        fitViewOptions={{ maxZoom: 1.5, padding: 0.2 }}
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={4}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
        {busbarDraft && (
          <ViewportPortal>
            <div
              className="busbar-preview"
              style={{
                transform: `translate(${Math.min(busbarDraft.start.x, busbarDraft.cur.x)}px, ${busbarDraft.start.y - 3}px)`,
                width: Math.max(20, Math.abs(busbarDraft.cur.x - busbarDraft.start.x)),
              }}
            />
          </ViewportPortal>
        )}
      </ReactFlow>
      {placementType === 'busbar' && (
        <div
          className="placement-overlay"
          onPointerDown={onOverlayDown}
          onPointerMove={onOverlayMove}
          onPointerUp={onOverlayUp}
        />
      )}
      {placementType && (
        <div className="canvas-hint">
          {placementType === 'busbar'
            ? 'Click and drag to size the busbar (or just click for a default one) — Esc to stop'
            : `Click to place a ${placementType} — drag from a connection dot to wire it up, Esc to stop`}
        </div>
      )}
      {flash && <div className={`flash-toast ${flashKind}`}>{flash}</div>}
      {menu && <ContextMenu target={menu} onClose={() => setMenu(null)} />}
      {hover && !menu && !busbarDraft && <ResultTooltip target={hover} />}
    </div>
  )
}
