import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  useStore,
  ViewportPortal,
  type FinalConnectionState,
  type IsValidConnection,
  useConnection,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { renderedEdgePoints } from '../lib/edgeGeometry'
import {
  beginGesture,
  endGesture,
  LARGE_CIRCUIT,
  redo,
  undo,
  useCircuitStore,
  validateConnection,
  type AppEdge,
  type AppNode,
} from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import type { NodeType } from '../types/circuit'
import { ContextMenu, type MenuTarget } from './ContextMenu'
import { OVERVIEW_ZOOM, OverviewLayer } from './OverviewLayer'
import { NODE_SIZE } from '../lib/defaults'
import { PhaseLegend } from './PhaseLegend'
import { ResultTooltip, type HoverTarget } from './ResultTooltip'
import { BreakerNode } from './nodes/BreakerNode'
import { BusbarNode } from './nodes/BusbarNode'
import { CapacitorNode } from './nodes/CapacitorNode'
import { GeneratorNode } from './nodes/GeneratorNode'
import { LoadNode } from './nodes/LoadNode'
import { FuseNode, RecloserNode, RelayNode } from './nodes/ProtectionNodes'
import { RegulatorNode } from './nodes/RegulatorNode'
import { PVSystemNode } from './nodes/PVSystemNode'
import { StorageNode } from './nodes/StorageNode'
import { TransformerNode } from './nodes/TransformerNode'
import { VsourceNode } from './nodes/VsourceNode'
import { NoteNode } from './nodes/NoteNode'
import { ZoneNode } from './nodes/ZoneNode'
import { LineEdge } from './edges/LineEdge'
import { WireEdge } from './edges/WireEdge'
import { useGrabStore } from '../store/grabStore'

const nodeTypes = {
  vsource: VsourceNode,
  busbar: BusbarNode,
  transformer: TransformerNode,
  regulator: RegulatorNode,
  fuse: FuseNode,
  recloser: RecloserNode,
  relay: RelayNode,
  load: LoadNode,
  breaker: BreakerNode,
  capacitor: CapacitorNode,
  generator: GeneratorNode,
  pvsystem: PVSystemNode,
  storage: StorageNode,
  note: NoteNode,
  zone: ZoneNode,
}

const edgeTypes = {
  wire: WireEdge,
  line: LineEdge,
}

const isValidConnection: IsValidConnection<AppEdge> = (conn) =>
  validateConnection(conn) === null

/** Out-of-service elements wear a class (dashed and faded in index.css);
 *  only those few nodes are copied, the rest pass through untouched. */
function markOutOfService(nodes: AppNode[]): AppNode[] {
  let changed = false
  const out = nodes.map((n) => {
    if (n.data.params.enabled !== false) return n
    changed = true
    return { ...n, className: `${n.className ?? ''} out-of-service` }
  })
  return changed ? out : nodes
}

/** The whole drawing's bounds from the store: positions and the symbols'
 *  known sizes. A large circuit's view cannot be fitted by React Flow,
 *  which only counts nodes it has drawn and measured. */
function storeBounds(nodes: AppNode[]) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const n of nodes) {
    const size = NODE_SIZE[n.type as NodeType] ?? NODE_SIZE.load
    const w = n.width ?? n.measured?.width ?? size.w
    const h = n.height ?? n.measured?.height ?? size.h
    x0 = Math.min(x0, n.position.x)
    y0 = Math.min(y0, n.position.y)
    x1 = Math.max(x1, n.position.x + w)
    y1 = Math.max(y1, n.position.y + h)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

const NO_NODES: AppNode[] = []
const NO_EDGES: AppEdge[] = []

export function EditorCanvas() {
  const storeNodes = useCircuitStore((s) => s.nodes)
  const storeEdges = useCircuitStore((s) => s.edges)
  const large = storeNodes.length > LARGE_CIRCUIT
  // A large circuit seen from far away is an overview on a canvas, and
  // React Flow is given nothing to draw; zoomed in, it draws what is in view.
  const overview = useStore((s) => large && s.transform[2] < OVERVIEW_ZOOM)
  const marked = useMemo(() => markOutOfService(storeNodes), [storeNodes])
  const nodes = overview ? NO_NODES : marked
  const edges = overview ? NO_EDGES : storeEdges
  const onNodesChange = useCircuitStore((s) => s.onNodesChange)
  const onEdgesChange = useCircuitStore((s) => s.onEdgesChange)
  const onConnect = useCircuitStore((s) => s.onConnect)
  const placementType = useCircuitStore((s) => s.placementType)
  const addNodeAt = useCircuitStore((s) => s.addNodeAt)
  const addBusbarAt = useCircuitStore((s) => s.addBusbarAt)
  const addZoneAt = useCircuitStore((s) => s.addZoneAt)
  const setPlacement = useCircuitStore((s) => s.setPlacement)
  const addEdgeWaypoint = useCircuitStore((s) => s.addEdgeWaypoint)
  const flash = useResultsStore((s) => s.flash)
  const flashKind = useResultsStore((s) => s.flashKind)
  const flow = useReactFlow<AppNode, AppEdge>()
  const { screenToFlowPosition, fitView, fitBounds, getNodes } = flow
  useEffect(() => {
    window.opendssDesigner.flow = flow
  }, [flow])
  const showGrid = useUiStore((s) => s.showGrid)
  const snap = useUiStore((s) => s.snapToGrid)
  const theme = useUiStore((s) => s.theme)

  // Clean up and sample loads redraw the whole circuit; show all of it. The
  // event is dispatched after the store update, but React Flow only counts
  // nodes it has measured, and a freshly loaded circuit takes a few frames
  // to get there -- fitting on the first frame framed whatever happened to
  // be measured, often nothing. So wait (up to half a second) for every
  // node to have a size, then fit.
  useEffect(() => {
    let frame = 0
    const onFit = () => {
      const all = useCircuitStore.getState().nodes
      if (all.length > LARGE_CIRCUIT) {
        void fitBounds(storeBounds(all), { padding: 0.05 })
        return
      }
      let tries = 0
      const attempt = () => {
        const ns = getNodes()
        // A large circuit draws only what is in view, so most nodes are
        // never measured; their initial sizes stand in (fromCircuitJSON).
        const ready =
          ns.length > LARGE_CIRCUIT || (ns.length > 0 && ns.every((n) => n.measured?.width && n.measured?.height))
        if (ready || ++tries > 30) {
          void fitView({ maxZoom: 1.5, padding: 0.1 })
          // Once more after the re-measure a re-layout sets off (bars change
          // width): nodes already measured say "ready" before it lands.
          window.setTimeout(() => void fitView({ maxZoom: 1.5, padding: 0.1 }), 200)
        } else frame = requestAnimationFrame(attempt)
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(attempt)
    }
    window.addEventListener('opendss:fit-view', onFit)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('opendss:fit-view', onFit)
    }
  }, [fitView, fitBounds, getNodes])

  // Busbars are placed by click-dragging to the desired width; a transparent
  // overlay captures that gesture. Other components place on pane clicks so
  // handles stay live — you can wire things up without leaving placement mode.
  const [busbarDraft, setBusbarDraft] = useState<{ start: { x: number; y: number }; cur: { x: number; y: number } } | null>(null)
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const [hover, setHover] = useState<HoverTarget | null>(null)

  const flowPos = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (!snap) return p
      return { x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 }
    },
    [screenToFlowPosition, snap],
  )

  const dragPlaced = placementType === 'busbar' || placementType === 'zone'
  const onOverlayDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragPlaced) {
        const p = flowPos(e)
        setBusbarDraft({ start: p, cur: p })
        e.currentTarget.setPointerCapture(e.pointerId)
      }
    },
    [dragPlaced, flowPos],
  )

  const onOverlayMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (busbarDraft) setBusbarDraft({ start: busbarDraft.start, cur: flowPos(e) })
    },
    [busbarDraft, flowPos],
  )

  const onOverlayUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragPlaced) return
      const p = flowPos(e)
      const start = busbarDraft?.start ?? p
      const width = Math.abs(p.x - start.x)
      const height = Math.abs(p.y - start.y)
      if (placementType === 'zone') {
        // A plain click drops a default-size zone centred on the click;
        // a drag draws the rectangle.
        if (width < 40 || height < 30) addNodeAt('zone', start)
        else addZoneAt({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: width, h: height })
      } else if (width < 40) {
        // A plain click drops a default-size bar centered on the click.
        addNodeAt('busbar', start)
      } else {
        addBusbarAt({ x: Math.min(start.x, p.x), y: start.y }, width)
      }
      setBusbarDraft(null)
    },
    [dragPlaced, placementType, busbarDraft, flowPos, addNodeAt, addBusbarAt, addZoneAt],
  )

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (!placementType || placementType === 'busbar') return
      const id = addNodeAt(placementType, flowPos(event))
      // A note is placed to be written in.
      if (placementType === 'note') useUiStore.getState().setEditingNote(id)
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

  // The click position stays unsnapped here: the store puts the new point on
  // the edge's current path (read off the screen) and snaps it along that
  // path, so adding a routing point never changes the shape.
  const onEdgeDoubleClick = useCallback(
    (event: React.MouseEvent, edge: AppEdge) => {
      event.stopPropagation()
      const p = screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false })
      addEdgeWaypoint(edge.id, p, renderedEdgePoints(edge.id))
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
      v: 'regulator',
      k: 'breaker',
      f: 'fuse',
      o: 'recloser',
      y: 'relay',
      l: 'load',
      c: 'capacitor',
      g: 'generator',
      p: 'pvsystem',
      a: 'storage',
      n: 'note',
      z: 'zone',
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
      // Keys typed into an open menu or dialog are theirs, not the drawing's.
      if (useUiStore.getState().dialog || (e.target as HTMLElement)?.closest?.('.menubar')) return
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
      if (e.shiftKey && (key === 'h' || key === 'v')) {
        const ids = st.nodes.filter((n) => n.selected).map((n) => n.id)
        st.flipNodes(ids, key === 'h' ? 'horizontal' : 'vertical')
        return
      }
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

  // Every symbol's attach points are hidden until a wire is looking for a
  // home: a new connection being dragged, or an existing end being moved.
  // One class on the wrapper lets plain CSS reveal them all at once.
  const connecting = useConnection((c) => c.inProgress)
  const grabbing = useGrabStore((s) => s.edgeId !== null)
  const routing = connecting || grabbing
  useEffect(() => useUiStore.getState().setRouting(routing), [routing])

  return (
    <div className={`canvas-wrap${placementType ? ' placing' : ''}${routing ? ' routing' : ''}`}>
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
        onPaneContextMenu={(e) => {
          e.preventDefault()
          setHover(null)
          setMenu({ kind: 'pane', id: '', x: e.clientX, y: e.clientY })
        }}
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
        snapToGrid={snap}
        colorMode={theme}
        snapGrid={[10, 10]}
        deleteKeyCode={['Delete', 'Backspace']}
        // A large circuit is fitted by the app (opendss:fit-view): React Flow
        // would refit every time zooming in hands it the symbols again.
        fitView={!large}
        fitViewOptions={{ maxZoom: 1.5, padding: 0.2 }}
        onlyRenderVisibleElements={large}
        zoomOnDoubleClick={false}
        minZoom={large ? 0.002 : 0.05}
        maxZoom={4}
        proOptions={{ hideAttribution: false }}
      >
        {showGrid && <Background variant={BackgroundVariant.Dots} gap={20} size={1} />}
        <Controls showFitView={!large}>
          {large && (
            <ControlButton
              className="react-flow__controls-fitview"
              title="Fit view"
              aria-label="fit view"
              onClick={() => window.dispatchEvent(new CustomEvent('opendss:fit-view'))}
            >
              <svg viewBox="0 0 32 30" width="12" height="12" aria-hidden="true">
                <path d="M3.7 11.5v-6.9h6.9V1.2H.3v10.3h3.4zm22.3-6.9v6.9h3.4V1.2H19.1v3.4H26zM10.7 25.4H3.7v-6.9H.3v10.3h10.3l.1-3.4zm15.3 0h-6.9v3.4h10.3V18.5H26v6.9z" fill="currentColor" />
              </svg>
            </ControlButton>
          )}
        </Controls>
        {large && overview && <div className="canvas-hint overview-hint">Overview — zoom in to see and edit elements</div>}
        {!large && <MiniMap pannable zoomable />}
        {busbarDraft && placementType === 'busbar' && (
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
        {busbarDraft && placementType === 'zone' && (
          <ViewportPortal>
            <div
              className="zone-preview"
              style={{
                transform: `translate(${Math.min(busbarDraft.start.x, busbarDraft.cur.x)}px, ${Math.min(busbarDraft.start.y, busbarDraft.cur.y)}px)`,
                width: Math.max(10, Math.abs(busbarDraft.cur.x - busbarDraft.start.x)),
                height: Math.max(10, Math.abs(busbarDraft.cur.y - busbarDraft.start.y)),
              }}
            />
          </ViewportPortal>
        )}
      </ReactFlow>
      {dragPlaced && (
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
            : placementType === 'note'
              ? 'Click where the note goes, then type — Esc to stop'
              : placementType === 'zone'
                ? 'Drag out the zone\'s rectangle (or just click for a default one) — Esc to stop'
                : `Click to place a ${placementType} — drag from a connection dot to wire it up, Esc to stop`}
        </div>
      )}
      {overview && <OverviewLayer />}
      <PhaseLegend />
      {flash && <div className={`flash-toast ${flashKind}`}>{flash}</div>}
      {menu && <ContextMenu target={menu} onClose={() => setMenu(null)} />}
      {hover && !menu && !busbarDraft && <ResultTooltip target={hover} />}
    </div>
  )
}
