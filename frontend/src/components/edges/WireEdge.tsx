import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import type { AppEdge } from '../../store/circuitStore'

export function WireEdge(props: EdgeProps<AppEdge>) {
  const [path] = getSmoothStepPath({ ...props, borderRadius: 0 })
  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={{ stroke: props.selected ? '#1976d2' : '#263238', strokeWidth: props.selected ? 2.5 : 1.6 }}
    />
  )
}
