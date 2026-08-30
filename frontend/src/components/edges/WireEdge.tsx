import { BaseEdge, type EdgeProps } from '@xyflow/react'
import type { AppEdge } from '../../store/circuitStore'
import { useEdgePath, WaypointDots } from './waypoints'

export function WireEdge(props: EdgeProps<AppEdge>) {
  const [path] = useEdgePath(props)
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{ stroke: props.selected ? '#1976d2' : '#263238', strokeWidth: props.selected ? 2.5 : 1.6 }}
      />
      {props.selected && (
        <WaypointDots edgeId={props.id} waypoints={props.data?.waypoints ?? []} />
      )}
    </>
  )
}
