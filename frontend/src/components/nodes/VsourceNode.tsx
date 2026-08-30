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
  const box = rotatedBox(48, 48, rot)
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={48} h={48}>
        <svg width="48" height="48" viewBox="0 0 48 48">
          {/* source circle with sine */}
          <circle cx="24" cy="20" r="14" className="sym" fill="none" />
          <path d="M 16 20 q 4 -8 8 0 q 4 8 8 0" className="sym" fill="none" />
          {/* terminal stub */}
          <line x1="24" y1="34" x2="24" y2="46" className="sym" />
        </svg>
      </SymbolSvg>
      <Handle id="t1" type="source" position={rotatePosition(Position.Bottom, rot)} className="term" />
      <NodeLabel>{String(data.params.name ?? '')}</NodeLabel>
      <VoltageBadge nodeId={id} />
    </div>
  )
}
