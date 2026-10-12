import { EdgeLabelRenderer, getSmoothStepPath, useReactFlow, type EdgeProps } from '@xyflow/react'
import { byId } from '../../lib/indexes'
import { beginGesture, endGesture, useCircuitStore, type AppEdge, type AppNode, type XY } from '../../store/circuitStore'
import { useGrabStore } from '../../store/grabStore'

const snap = (v: number) => Math.round(v / 10) * 10

/** Where a wire meets a busbar: the bar's centreline; null for any other node. */
function barCentreY(n: AppNode | undefined): number | null {
  return n?.type === 'busbar' ? n.position.y + BAR_CENTER_Y : null
}

// Vertical center of the bar graphic inside a busbar node (bar spans y 4–10
// of the 14px-tall node — see BusbarNode/index.css).
const BAR_CENTER_Y = 7

/** Path + label anchor for an edge, honoring user waypoints when present.
 *  Without waypoints: React Flow's smoothstep. With waypoints: straight
 *  polyline segments through them (snap them to the grid for orthogonal
 *  routing). Endpoints that land on a busbar handle are pulled onto the
 *  bar's centerline so the wire always visually meets the bar.
 *
 *  While this edge is being grabbed (see store/grabStore.ts) the moving end
 *  is drawn at the cursor instead of at its terminal: the edge itself is the
 *  drag preview, so there is no second line to keep in step. */
export function useEdgePath(props: EdgeProps<AppEdge>): [string, number, number] {
  // Each end subscribes to one number -- its busbar's centreline, or null --
  // so moving some other node re-renders no edge but the ones on it.
  const sourceBar = useCircuitStore((s) => barCentreY(byId(s.nodes).get(props.source)))
  const targetBar = useCircuitStore((s) => barCentreY(byId(s.nodes).get(props.target)))
  const grab = useGrabStore((s) => (s.edgeId === props.id ? s : null))

  const held = grab?.cursor ?? null
  const source =
    held && grab?.end === 'source'
      ? held
      : { x: props.sourceX, y: sourceBar ?? props.sourceY }
  const target =
    held && grab?.end === 'target'
      ? held
      : { x: props.targetX, y: targetBar ?? props.targetY }

  const wps = props.data?.waypoints
  if (!wps?.length && !held) {
    const [path, lx, ly] = getSmoothStepPath({
      ...props,
      sourceY: source.y,
      targetY: target.y,
      borderRadius: 0,
    })
    return [path, lx, ly]
  }
  // A grabbed end rubber-bands straight to the cursor; smoothstep's elbows
  // are computed from the terminal's facing, which no longer applies.
  const pts: XY[] = [source, ...(wps ?? []), target]
  const path = `M ${pts[0].x},${pts[0].y} ` + pts.slice(1).map((p) => `L ${p.x},${p.y}`).join(' ')
  const mid = wps?.length
    ? wps[Math.floor((wps.length - 1) / 2)]
    : { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 }
  return [path, mid.x, mid.y]
}

/** Draggable routing dots, shown while the edge is selected.
 *  Drag to move a waypoint (grid-snapped); double-click a dot to remove it;
 *  double-click the edge itself (handled in EditorCanvas) to add one. */
export function WaypointDots({ edgeId, waypoints }: { edgeId: string; waypoints: XY[] }) {
  const { screenToFlowPosition } = useReactFlow()
  const setEdgeWaypoints = useCircuitStore((s) => s.setEdgeWaypoints)

  const startDrag = (index: number, down: React.PointerEvent) => {
    down.stopPropagation()
    down.preventDefault()
    beginGesture() // one undo step for the whole waypoint drag
    const move = (e: PointerEvent) => {
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const next = waypoints.map((w, i) =>
        i === index ? { x: snap(p.x), y: snap(p.y) } : w,
      )
      setEdgeWaypoints(edgeId, next)
    }
    const up = () => {
      endGesture()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <EdgeLabelRenderer>
      {waypoints.map((w, i) => (
        <div
          key={i}
          className="waypoint-dot nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${w.x}px, ${w.y}px)` }}
          onPointerDown={(e) => startDrag(i, e)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setEdgeWaypoints(edgeId, waypoints.filter((_, j) => j !== i))
          }}
          title="Drag to route · double-click to remove"
        />
      ))}
    </EdgeLabelRenderer>
  )
}
