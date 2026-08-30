import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useCircuitStore, type AppNode } from '../../store/circuitStore'
import {
  ElementBadge,
  NodeLabel,
  rotatedBox,
  rotatePosition,
  SymbolSvg,
  useNodeIssueClass,
  useSymbolRotation,
} from './common'

export function BreakerNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(36, 56, rot)
  const updateNodeParams = useCircuitStore((s) => s.updateNodeParams)
  const closed = data.params.closed !== false
  return (
    <div
      className={`symbol-node${issueClass}`}
      style={{ width: box.w, height: box.h }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        updateNodeParams(id, { closed: !closed })
      }}
      title={`Double-click to ${closed ? 'open' : 'close'}`}
    >
      <SymbolSvg rotation={rot} w={36} h={56}>
        <svg width="36" height="56" viewBox="0 0 36 56">
          <line x1="18" y1="0" x2="18" y2="18" className="sym" />
          <rect x="8" y="18" width="20" height="20" className={closed ? 'sym-fill' : 'sym'} fill={closed ? undefined : 'none'} />
          <line x1="18" y1="38" x2="18" y2="56" className="sym" />
        </svg>
      </SymbolSvg>
      <Handle id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <Handle id="t2" type="source" position={rotatePosition(Position.Bottom, rot)} className="term" />
      <NodeLabel>
        {String(data.params.name ?? '')}
        <div className="sub-label">{closed ? 'closed' : 'OPEN'}</div>
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
