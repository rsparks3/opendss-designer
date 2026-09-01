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

export function StorageNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(40, 60, rot)
  const kwhrated = data.params.kwhrated
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={40} h={60}>
        <svg width="40" height="60" viewBox="0 0 40 60">
          {/* battery: alternating long/short plates */}
          <line x1="20" y1="0" x2="20" y2="24" className="sym" />
          <line x1="6" y1="24" x2="34" y2="24" className="sym" />
          <line x1="13" y1="30" x2="27" y2="30" className="sym" />
          <line x1="6" y1="36" x2="34" y2="36" className="sym" />
          <line x1="13" y1="42" x2="27" y2="42" className="sym" />
        </svg>
      </SymbolSvg>
      <Terminal nodeId={id} id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        {kwhrated != null && <div className="sub-label">{Number(kwhrated)} kWh</div>}
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
