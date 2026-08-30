import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { AppNode } from '../../store/circuitStore'
import {
  ElementBadge,
  NodeLabel,
  rotatedBox,
  rotatePosition,
  SymbolSvg,
  useNodeIssueClass,
  useSymbolRotation,
} from './common'

export function GeneratorNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(44, 56, rot)
  const kw = data.params.kw
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={44} h={56}>
        <svg width="44" height="56" viewBox="0 0 44 56">
          <line x1="22" y1="0" x2="22" y2="12" className="sym" />
          <circle cx="22" cy="33" r="16" className="sym" fill="none" />
          <text x="22" y="39" textAnchor="middle" className="sym-text">
            G
          </text>
        </svg>
      </SymbolSvg>
      <Handle id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        {kw != null && <div className="sub-label">{Number(kw)} kW</div>}
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
