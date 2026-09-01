import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AppNode } from '../../store/circuitStore'
import {
  NodeLabel,
  rotatedBox,
  rotatePosition,
  SymbolSvg,
  useNodeIssueClass,
  useSymbolRotation,
  VoltageBadge,
} from './common'

export function VsourceNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(40, 60, rot)
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={40} h={60}>
        <svg width="40" height="60" viewBox="0 0 40 60">
          {/* source circle with sine */}
          <circle cx="20" cy="24" r="14" className="sym" fill="none" />
          <path d="M 12 24 q 4 -8 8 0 q 4 8 8 0" className="sym" fill="none" />
          {/* terminal stub */}
          <line x1="20" y1="38" x2="20" y2="60" className="sym" />
        </svg>
      </SymbolSvg>
      <Handle id="t1" type="source" position={rotatePosition(Position.Bottom, rot)} className="term" />
      <NodeLabel>{String(data.params.name ?? '')}</NodeLabel>
      <VoltageBadge nodeId={id} />
    </div>
  )
}
