import {
  Handle,
  NodeResizer,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react'
import { useEffect } from 'react'
import { busbarHandleCount, useCircuitStore, type AppNode } from '../../store/circuitStore'
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
        onResizeEnd={(_e, p) => setBusbarWidth(id, p.width)}
      />
      <div className="busbar-bar" />
      {Array.from({ length: count }, (_, i) => (
        <Handle
          key={`b${i}`}
          id={`b${i}`}
          type="source"
          position={Position.Top}
          className="term busbar-term"
          style={{ left: `${((i + 0.5) * 100) / count}%`, top: BAR_H / 2 }}
        />
      ))}
      <NodeLabel>{String(data.params.name ?? '')}</NodeLabel>
      <VoltageBadge nodeId={id} />
    </div>
  )
}
