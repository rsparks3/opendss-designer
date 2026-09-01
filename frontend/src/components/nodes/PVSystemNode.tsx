import { Position, type NodeProps } from '@xyflow/react'
import type { AppNode } from '../../store/circuitStore'
import {
  ElementBadge,
  NodeLabel,
  rotatedBox,
  rotatePosition,
  SymbolSvg,
  Terminal,
  useNodeIssueClass,
  useSymbolRotation,
} from './common'

export function PVSystemNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(40, 60, rot)
  const pmpp = data.params.pmpp
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={40} h={60}>
        <svg width="40" height="60" viewBox="0 0 40 60">
          <line x1="20" y1="0" x2="20" y2="20" className="sym" />
          <circle cx="20" cy="36" r="16" className="sym" fill="none" />
          {/* sun rays hitting the array */}
          <line x1="2" y1="12" x2="8" y2="20" className="sym" />
          <line x1="9" y1="8" x2="13" y2="17" className="sym" />
          <text x="20" y="41" textAnchor="middle" className="sym-text">
            PV
          </text>
        </svg>
      </SymbolSvg>
      <Terminal nodeId={id} id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        {pmpp != null && <div className="sub-label">{Number(pmpp)} kW</div>}
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
