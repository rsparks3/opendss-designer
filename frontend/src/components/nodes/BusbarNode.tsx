import {
  Handle,
  NodeResizer,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react'
import { useEffect } from 'react'
import { beginGesture, busbarHandleCount, endGesture, useCircuitStore, type AppNode } from '../../store/circuitStore'
import { NodeLabel, useNodeIssueClass, VoltageBadge } from './common'

const BAR_H = 14

export function BusbarNode({ id, data, width, selected }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const setBusbarWidth = useCircuitStore((s) => s.setBusbarWidth)
  const updateNodeInternals = useUpdateNodeInternals()
  const w = width ?? 240
  const count = busbarHandleCount(w)

  useEffect(() => {
    updateNodeInternals(id)
  }, [w, count, id, updateNodeInternals])

  return (
    <div className={`symbol-node busbar-node${issueClass}`} style={{ width: w, height: BAR_H }}>
      <NodeResizer
        isVisible={!!selected}
        minWidth={60}
        minHeight={BAR_H}
        maxHeight={BAR_H}
        onResizeStart={beginGesture}
        onResizeEnd={(_e, p) => {
          setBusbarWidth(id, p.width)
          endGesture()
        }}
      />
      <div className="busbar-bar" />
      {/* Two handle rows: b<i> route edges upward, c<i> route them downward,
          so elements below the bar connect from beneath instead of looping
          over the top. Electrically every handle is the same bus. */}
      {Array.from({ length: count }, (_, i) => (
        <Handle
          key={`b${i}`}
          id={`b${i}`}
          type="source"
          position={Position.Top}
          className="term busbar-term"
          style={{ left: `${((i + 0.5) * 100) / count}%`, top: 2 }}
        />
      ))}
      {Array.from({ length: count }, (_, i) => (
        <Handle
          key={`c${i}`}
          id={`c${i}`}
          type="source"
          position={Position.Bottom}
          className="term busbar-term"
          style={{ left: `${((i + 0.5) * 100) / count}%`, bottom: -2 }}
        />
      ))}
      <NodeLabel>{String(data.params.name ?? '')}</NodeLabel>
      <VoltageBadge nodeId={id} />
    </div>
  )
}
