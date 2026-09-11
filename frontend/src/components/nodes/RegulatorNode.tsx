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

/** Step-voltage regulator: the two-winding transformer symbol with the
 *  tap-changer arrow struck through it. */
export function RegulatorNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(40, 80, rot)
  const vreg = data.params.vreg
  const band = data.params.band
  const setpoint = vreg != null ? `${vreg}${band != null ? ` ±${Number(band) / 2}` : ''} V` : ''
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h }}>
      <SymbolSvg rotation={rot} w={40} h={80}>
        <svg width="40" height="80" viewBox="0 0 40 80">
          <line x1="20" y1="0" x2="20" y2="16" className="sym" />
          <circle cx="20" cy="30" r="14" className="sym" fill="none" />
          <circle cx="20" cy="50" r="14" className="sym" fill="none" />
          <line x1="20" y1="64" x2="20" y2="80" className="sym" />
          <line x1="4" y1="60" x2="36" y2="20" className="sym" />
          <path d="M36 20 L28 21 L33 26 Z" className="sym" fill="currentColor" />
        </svg>
      </SymbolSvg>
      <Terminal nodeId={id} id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <Terminal nodeId={id} id="t2" type="source" position={rotatePosition(Position.Bottom, rot)} className="term" />
      <NodeLabel beside={rot % 180 === 0}>
        {String(data.params.name ?? '')}
        {setpoint && <div className="sub-label">{setpoint}</div>}
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
