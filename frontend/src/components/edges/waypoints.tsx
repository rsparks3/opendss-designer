import { EdgeLabelRenderer, getSmoothStepPath, useReactFlow, type EdgeProps } from '@xyflow/react'
import { useCircuitStore, type AppEdge, type XY } from '../../store/circuitStore'

const snap = (v: number) => Math.round(v / 10) * 10

// Vertical center of the bar graphic inside a busbar node (bar spans y 4–10
// of the 14px-tall node — see BusbarNode/index.css).
const BAR_CENTER_Y = 7

/** Path + label anchor for an edge, honoring user waypoints when present.
 *  Without waypoints: React Flow's smoothstep. With waypoints: straight
 *  polyline segments through them (snap them to the grid for orthogonal
 *  routing). Endpoints that land on a busbar handle are pulled onto the
 *  bar's centerline so the wire always visually meets the bar. */
export function useEdgePath(props: EdgeProps<AppEdge>): [string, number, number] {
  const nodes = useCircuitStore((s) => s.nodes)

  const anchorY = (nodeId: string, y: number): number => {
    const n = nodes.find((nd) => nd.id === nodeId)
    return n?.type === 'busbar' ? n.position.y + BAR_CENTER_Y : y
  }
  const sourceY = anchorY(props.source, props.sourceY)
  const targetY = anchorY(props.target, props.targetY)

  const wps = props.data?.waypoints
  if (!wps?.length) {
    const [path, lx, ly] = getSmoothStepPath({ ...props, sourceY, targetY, borderRadius: 0 })
    return [path, lx, ly]
  }
  const pts: XY[] = [{ x: props.sourceX, y: sourceY }, ...wps, { x: props.targetX, y: targetY }]
  const path = `M ${pts[0].x},${pts[0].y} ` + pts.slice(1).map((p) => `L ${p.x},${p.y}`).join(' ')
  const mid = wps[Math.floor((wps.length - 1) / 2)]
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
    const move = (e: PointerEvent) => {
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const next = waypoints.map((w, i) =>
        i === index ? { x: snap(p.x), y: snap(p.y) } : w,
      )
      setEdgeWaypoints(edgeId, next)
    }
    const up = () => {
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
