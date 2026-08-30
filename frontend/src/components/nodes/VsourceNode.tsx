import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AppNode } from '../../store/circuitStore'
import { NodeLabel, useNodeIssueClass, VoltageBadge } from './common'

export function VsourceNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: 48, height: 64 }}>
      <svg width="48" height="64" viewBox="0 0 48 64">
        {/* ground glyph */}
        <line x1="24" y1="2" x2="24" y2="10" className="sym" />
        <line x1="14" y1="10" x2="34" y2="10" className="sym" />
        <line x1="18" y1="14" x2="30" y2="14" className="sym" />
        <line x1="21" y1="18" x2="27" y2="18" className="sym" />
        {/* source circle with sine */}
        <circle cx="24" cy="36" r="14" className="sym" fill="none" />
        <path d="M 16 36 q 4 -8 8 0 q 4 8 8 0" className="sym" fill="none" />
        {/* terminal stub */}
        <line x1="24" y1="50" x2="24" y2="62" className="sym" />
      </svg>
      <Handle id="t1" type="source" position={Position.Bottom} className="term" />
      <NodeLabel>{String(data.params.name ?? '')}</NodeLabel>
      <VoltageBadge nodeId={id} />
    </div>
  )
}
