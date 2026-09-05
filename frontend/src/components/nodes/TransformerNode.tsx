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

export function TransformerNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(40, 80, rot)
  const windings = (data.params.windings as { kv: number }[] | undefined) ?? []
  const kvText = windings.length >= 2 ? `${windings[0].kv}/${windings[1].kv} kV` : ''
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={40} h={80}>
        <svg width="40" height="80" viewBox="0 0 40 80">
          <line x1="20" y1="0" x2="20" y2="16" className="sym" />
          <circle cx="20" cy="30" r="14" className="sym" fill="none" />
          <circle cx="20" cy="50" r="14" className="sym" fill="none" />
          <line x1="20" y1="64" x2="20" y2="80" className="sym" />
        </svg>
      </SymbolSvg>
      <Terminal nodeId={id} id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <Terminal nodeId={id} id="t2" type="source" position={rotatePosition(Position.Bottom, rot)} className="term" />
      <NodeLabel beside={rot % 180 === 0}>
        {String(data.params.name ?? '')}
        {kvText && <div className="sub-label">{kvText}</div>}
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
