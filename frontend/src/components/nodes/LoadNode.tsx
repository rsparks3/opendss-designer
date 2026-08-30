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

export function LoadNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(40, 52, rot)
  const kw = data.params.kw
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={40} h={52}>
        <svg width="40" height="52" viewBox="0 0 40 52">
          <line x1="20" y1="0" x2="20" y2="26" className="sym" />
          {/* load arrow */}
          <polygon points="12,26 28,26 20,48" className="sym-fill" />
        </svg>
      </SymbolSvg>
      <Handle id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        {kw != null && <div className="sub-label">{Number(kw)} kW</div>}
      </NodeLabel>
      <VoltageBadge nodeId={id} />
    </div>
  )
}
