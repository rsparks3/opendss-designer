import { EdgeLabelRenderer, getSmoothStepPath, useReactFlow, type EdgeProps } from '@xyflow/react'
import { useCircuitStore, type AppEdge, type XY } from '../../store/circuitStore'

const snap = (v: number) => Math.round(v / 10) * 10

/** Path + label anchor for an edge, honoring user waypoints when present.
 *  Without waypoints: React Flow's smoothstep. With waypoints: straight
 *  polyline segments through them (snap them to the grid for orthogonal
 *  routing). */
export function edgePath(props: EdgeProps<AppEdge>): [string, number, number] {
  const wps = props.data?.waypoints
  if (!wps?.length) {
    const [path, lx, ly] = getSmoothStepPath({ ...props, borderRadius: 0 })
    return [path, lx, ly]
  }
  const pts: XY[] = [{ x: props.sourceX, y: props.sourceY }, ...wps, { x: props.targetX, y: props.targetY }]
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
