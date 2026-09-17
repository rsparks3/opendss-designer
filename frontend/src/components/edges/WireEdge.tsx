import { BaseEdge, type EdgeProps } from '@xyflow/react'
import { phaseColor } from '../../lib/phasing'
import type { AppEdge } from '../../store/circuitStore'
import { useIsGrabbed } from '../../store/grabStore'
import { useResultsStore } from '../../store/resultsStore'
import { useEdgePath, WaypointDots } from './waypoints'

export function WireEdge(props: EdgeProps<AppEdge>) {
  const [path] = useEdgePath(props)
  const grabbed = useIsGrabbed(props.id)
  // In the 'phases' overlay a wire takes the colour of its bus: what the
  // validation walk says arrives there, not what any one element asks for.
  const busPhases = useResultsStore((s) =>
    s.overlay === 'phases' ? (s.phases?.wires[props.id] ?? null) : undefined,
  )
  const stroke =
    props.selected || grabbed
      ? '#1976d2'
      : busPhases === undefined
        ? '#263238'
        : phaseColor(busPhases)
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          stroke,
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
