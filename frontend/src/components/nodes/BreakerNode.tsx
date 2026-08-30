import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AppNode } from '../../store/circuitStore'
import { ElementBadge, NodeLabel, useNodeIssueClass } from './common'

export function BreakerNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const closed = data.params.closed !== false
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: 36, height: 56 }}>
      <svg width="36" height="56" viewBox="0 0 36 56">
        <line x1="18" y1="0" x2="18" y2="18" className="sym" />
        <rect x="8" y="18" width="20" height="20" className={closed ? 'sym-fill' : 'sym'} fill={closed ? undefined : 'none'} />
        <line x1="18" y1="38" x2="18" y2="56" className="sym" />
      </svg>
      <Handle id="t1" type="source" position={Position.Top} className="term" />
      <Handle id="t2" type="source" position={Position.Bottom} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        <div className="sub-label">{closed ? 'closed' : 'OPEN'}</div>
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
