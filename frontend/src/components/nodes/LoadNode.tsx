import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AppNode } from '../../store/circuitStore'
import { NodeLabel, useNodeIssueClass, VoltageBadge } from './common'

export function LoadNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const kw = data.params.kw
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: 40, height: 52 }}>
      <svg width="40" height="52" viewBox="0 0 40 52">
        <line x1="20" y1="0" x2="20" y2="26" className="sym" />
        {/* load arrow */}
        <polygon points="12,26 28,26 20,48" className="sym-fill" />
      </svg>
      <Handle id="t1" type="source" position={Position.Top} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        {kw != null && <div className="sub-label">{Number(kw)} kW</div>}
      </NodeLabel>
      <VoltageBadge nodeId={id} />
    </div>
  )
}
