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
  useStoreApi,
  ViewportPortal,
  type FinalConnectionState,
  type IsValidConnection,
  useConnection,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { OverviewLayer } from './OverviewLayer'
import { LargeMiniMap } from './LargeMiniMap'
import { decideOverview, nodeBounds, nodesInView } from '../lib/viewBudget'
import { PhaseLegend } from './PhaseLegend'
import { TracePanel } from './TracePanel'
import { traceView } from '../lib/trace'
import { scenarioMarks } from '../lib/scenarios'
import { ScenarioBanner } from './ScenarioBanner'
import { ViewToggle } from './ViewToggle'
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
import { circuitCounts, signalStruggle } from '../store/hintStore'
import { HintCard } from './HintCard'

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

/** In a trace, what is lit wears `trace-hit`; the canvas wrapper's
 *  `tracing` class dims everything else (index.css). */
function markTrace<T extends AppNode | AppEdge>(items: T[], hit: Set<string> | undefined): T[] {
  if (!hit) return items
  return items.map((it) => (hit.has(it.id) ? { ...it, className: `${it.className ?? ''} trace-hit` } : it))
}

function markScenario<T extends AppNode | AppEdge>(items: T[], marks: { changed: Set<string>; added: Set<string> } | null): T[] {
  if (!marks || (!marks.changed.size && !marks.added.size)) return items
  return items.map((it) =>
    marks.changed.has(it.id) ? { ...it, className: `${it.className ?? ''} scenario-changed` }
      : marks.added.has(it.id) ? { ...it, className: `${it.className ?? ''} scenario-added` } : it)
}

const NO_NODES: AppNode[] = []
const NO_EDGES: AppEdge[] = []

export function EditorCanvas() {
  const storeNodes = useCircuitStore((s) => s.nodes)
  const storeEdges = useCircuitStore((s) => s.edges)
  const large = storeNodes.length > LARGE_CIRCUIT
  // A large circuit with too many symbols in view is an overview on a
  // canvas, and React Flow is given nothing to draw; with few enough in
  // view it draws them. "Too many" is counted against the budget on every
  // viewport change (lib/viewBudget), with hysteresis so the edge does not
  // flicker; the count reads the store directly, since a selector here
  // runs on React Flow's changes, not the circuit's.
  const wasOverview = useRef(false)
  const overview = useStore((s) => {
    if (!large) return false
    const inView = nodesInView(useCircuitStore.getState().nodes, s.transform, s.width, s.height)
    const next = decideOverview(wasOverview.current, inView, s.transform[2])
    wasOverview.current = next
    return next
  })
  const traceReq = useUiStore((s) => s.trace)
  const trace = useMemo(
    () => (traceReq ? traceView(storeNodes, storeEdges, traceReq.kind, traceReq.elementId) : null),
    [traceReq, storeNodes, storeEdges],
  )
  // While a scenario is open, what it changes wears a dashed halo.
  const scenarioBase = useCircuitStore((s) => s.scenarioBase)
  const marks = useMemo(
    () => (scenarioBase ? scenarioMarks(scenarioBase, { nodes: storeNodes, edges: storeEdges }) : null),
    [scenarioBase, storeNodes, storeEdges],
  )
  const marked = useMemo(
    () => markTrace(markScenario(markOutOfService(storeNodes), marks), trace?.nodeIds),
    [storeNodes, trace, marks],
  )
  const markedEdges = useMemo(() => markTrace(markScenario(storeEdges, marks), trace?.edgeIds), [storeEdges, trace, marks])
  const nodes = overview ? NO_NODES : marked
  const edges = overview ? NO_EDGES : markedEdges
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
        // The event arrives in the same tick as the load, before this
        // component has re-rendered with the large circuit's lower minZoom;
        // fitting at once was clamped at the small circuit's 0.05 and
        // showed a third of a real feeder. Two frames on, the limit is in.
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => void fitBounds(nodeBounds(all), { padding: 0.05 }))
        })
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
      // Dragged a good way and let go over nothing: a wire with no home.
      if (!state.toHandle && state.from && state.to) {
        const dx = state.to.x - state.from.x
        const dy = state.to.y - state.from.y
        if (dx * dx + dy * dy > 20 * 20) signalStruggle('drop-missed')
        return
      }
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
        if (useCircuitStore.getState().placementType) signalStruggle('placement-escaped')
        setPlacement(null)
        setBusbarDraft(null)
        setMenu(null)
        useUiStore.getState().setTrace(null)
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
  const onNodeDragStop = useCallback(() => {
    endGesture()
    signalStruggle('node-drag', circuitCounts())
  }, [])
  const onNodeDoubleClick = useCallback(() => {
    if (!useUiStore.getState().panelOpen.properties) signalStruggle('props-closed-dblclick')
  }, [])

  // Struggle signals the view gives off (lib/struggles): a selection box
  // drawn on the pane, a pan by any means other than left-drag, and where
  // the viewport comes to rest -- on the circuit, or on nothing.
  const onSelectionEnd = useCallback(() => signalStruggle('marquee'), [])
  const onMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    const type = event?.type ?? ''
    if (/^(mouse|pointer|touch)/.test(type)) signalStruggle('pan')
  }, [])
  const storeApi = useStoreApi()
  const onMoveEnd = useCallback(() => {
    const all = useCircuitStore.getState().nodes
    if (!all.length) return
    const { transform, width, height } = storeApi.getState()
    signalStruggle(nodesInView(all, transform, width, height, 1) > 0 ? 'view-ok' : 'empty-view')
  }, [storeApi])
  const propertiesOpen = useUiStore((s) => s.panelOpen.properties)
  useEffect(() => {
    if (propertiesOpen) signalStruggle('props-opened')
  }, [propertiesOpen])

  // Every symbol's attach points are hidden until a wire is looking for a
  // home: a new connection being dragged, or an existing end being moved.
  // One class on the wrapper lets plain CSS reveal them all at once.
  const connecting = useConnection((c) => c.inProgress)
  const grabbing = useGrabStore((s) => s.edgeId !== null)
  const routing = connecting || grabbing
  useEffect(() => useUiStore.getState().setRouting(routing), [routing])

  return (
    <div className={`canvas-wrap${placementType ? ' placing' : ''}${routing ? ' routing' : ''}${trace ? ' tracing' : ''}`}>
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
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={onNodeDoubleClick}
        onSelectionDragStart={onDragStart}
        onSelectionDragStop={onNodeDragStop}
        onSelectionEnd={onSelectionEnd}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
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
        {large && <LargeMiniMap />}
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
      {trace && <TracePanel view={trace} />}
      <ScenarioBanner />
      <ViewToggle />
      {flash && <div className={`flash-toast ${flashKind}`}>{flash}</div>}
      <HintCard />
      {menu && <ContextMenu target={menu} onClose={() => setMenu(null)} />}
      {hover && !menu && !busbarDraft && <ResultTooltip target={hover} />}
    </div>
  )
}
