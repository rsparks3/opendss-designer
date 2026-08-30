import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AppNode } from '../../store/circuitStore'
import { ElementBadge, NodeLabel, useNodeIssueClass } from './common'

export function TransformerNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const windings = (data.params.windings as { kv: number }[] | undefined) ?? []
  const kvText = windings.length >= 2 ? `${windings[0].kv}/${windings[1].kv} kV` : ''
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: 48, height: 72 }}>
      <svg width="48" height="72" viewBox="0 0 48 72">
        <line x1="24" y1="0" x2="24" y2="12" className="sym" />
        <circle cx="24" cy="26" r="14" className="sym" fill="none" />
        <circle cx="24" cy="46" r="14" className="sym" fill="none" />
        <line x1="24" y1="60" x2="24" y2="72" className="sym" />
      </svg>
      <Handle id="t1" type="source" position={Position.Top} className="term" />
      <Handle id="t2" type="source" position={Position.Bottom} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        {kvText && <div className="sub-label">{kvText}</div>}
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
