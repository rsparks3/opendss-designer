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

export function StorageNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(44, 56, rot)
  const kwhrated = data.params.kwhrated
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={44} h={56}>
        <svg width="44" height="56" viewBox="0 0 44 56">
          {/* battery: alternating long/short plates */}
          <line x1="22" y1="0" x2="22" y2="22" className="sym" />
          <line x1="8" y1="22" x2="36" y2="22" className="sym" />
          <line x1="15" y1="28" x2="29" y2="28" className="sym" />
          <line x1="8" y1="34" x2="36" y2="34" className="sym" />
          <line x1="15" y1="40" x2="29" y2="40" className="sym" />
        </svg>
      </SymbolSvg>
      <Handle id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        {kwhrated != null && <div className="sub-label">{Number(kwhrated)} kWh</div>}
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
