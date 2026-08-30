import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type FinalConnectionState,
  type IsValidConnection,
} from '@xyflow/react'
import { useCallback, useEffect } from 'react'
import {
  redo,
  undo,
  useCircuitStore,
  validateConnection,
  type AppEdge,
} from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { BreakerNode } from './nodes/BreakerNode'
import { BusbarNode } from './nodes/BusbarNode'
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
  const setPlacement = useCircuitStore((s) => s.setPlacement)
  const addEdgeWaypoint = useCircuitStore((s) => s.addEdgeWaypoint)
  const flash = useResultsStore((s) => s.flash)
  const { screenToFlowPosition } = useReactFlow()

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (!placementType) return
      const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      addNodeAt(placementType, {
        x: Math.round(pos.x / 10) * 10,
        y: Math.round(pos.y / 10) * 10,
      })
    },
    [placementType, screenToFlowPosition, addNodeAt],
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
    const onKey = (e: KeyboardEvent) => {
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
        (e.target as HTMLElement)?.tagName,
      )
      if (e.key === 'Escape') setPlacement(null)
      if (inField) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPlacement])

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
        isValidConnection={isValidConnection}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={30}
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
      </ReactFlow>
      {placementType && (
        <div className="canvas-hint">
          Click to place a {placementType} — keep clicking to add more, Esc to stop
        </div>
      )}
      {flash && <div className="flash-toast">{flash}</div>}
    </div>
  )
}
