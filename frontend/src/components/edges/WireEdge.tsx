import { BaseEdge, type EdgeProps } from '@xyflow/react'
import type { AppEdge } from '../../store/circuitStore'
import { useIsGrabbed } from '../../store/grabStore'
import { useEdgePath, WaypointDots } from './waypoints'

export function WireEdge(props: EdgeProps<AppEdge>) {
  const [path] = useEdgePath(props)
  const grabbed = useIsGrabbed(props.id)
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          stroke: props.selected || grabbed ? '#1976d2' : '#263238',
          strokeWidth: props.selected ? 2.5 : 1.6,
          strokeDasharray: grabbed ? '6 4' : undefined,
        }}
      />
      {props.selected && (
        <WaypointDots edgeId={props.id} waypoints={props.data?.waypoints ?? []} />
      )}
    </>
  )
}
