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

export function CapacitorNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(40, 56, rot)
  const kvar = data.params.kvar
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={40} h={56}>
        <svg width="40" height="56" viewBox="0 0 40 56">
          <line x1="20" y1="0" x2="20" y2="22" className="sym" />
          {/* capacitor plates */}
          <line x1="8" y1="22" x2="32" y2="22" className="sym" />
          <line x1="8" y1="30" x2="32" y2="30" className="sym" />
          <line x1="20" y1="30" x2="20" y2="44" className="sym" />
          {/* ground */}
          <line x1="11" y1="44" x2="29" y2="44" className="sym" />
          <line x1="14" y1="49" x2="26" y2="49" className="sym" />
          <line x1="17" y1="54" x2="23" y2="54" className="sym" />
        </svg>
      </SymbolSvg>
      <Handle id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        {kvar != null && <div className="sub-label">{Number(kvar)} kvar</div>}
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
