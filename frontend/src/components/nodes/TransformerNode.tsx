import { Position, type NodeProps } from '@xyflow/react'
import type { AppNode } from '../../store/circuitStore'
import type { Winding } from '../../types/circuit'
import {
  ElementBadge,
  NodeLabel,
  rotatedBox,
  SymbolSvg,
  Terminal,
  terminalPlacement,
  useNodeIssueClass,
  usePhaseInk,
  useSymbolRotation,
} from './common'

/** Two overlapping circles, primary above secondary, the way a one-line draws
 *  a transformer. A tertiary winding is a third circle overlapping both, with
 *  its terminal leaving to the right, so the symbol widens from 40 to 60 and
 *  the name moves to the left to stay clear of the third wire. The primary
 *  and secondary keep their column at x=20 so a unit that gains or loses a
 *  tertiary does not move the wires already on it. */
export function TransformerNode({ id, data }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const phaseInk = usePhaseInk(data.params)
  const rot = useSymbolRotation(id, data.params)
  const windings = (data.params.windings as Winding[] | undefined) ?? []
  const tertiary = windings.length >= 3
  const w = tertiary ? 60 : 40
  const h = 80
  const box = rotatedBox(w, h, rot)
  const kvText = windings.length >= 2 ? `${windings.map((wd) => wd.kv).join('/')} kV` : ''
  const t1 = terminalPlacement(Position.Top, 20, 0, w, h, rot)
  const t2 = terminalPlacement(Position.Bottom, 20, h, w, h, rot)
  const t3 = terminalPlacement(Position.Right, w, 40, w, h, rot)
  return (
    <div className={`symbol-node${issueClass}`} style={{ width: box.w, height: box.h, ...phaseInk }}>
      <SymbolSvg rotation={rot} w={w} h={h}>
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          <line x1="20" y1="0" x2="20" y2="16" className="sym" />
          <circle cx="20" cy="30" r="14" className="sym" fill="none" />
          <circle cx="20" cy="50" r="14" className="sym" fill="none" />
          <line x1="20" y1="64" x2="20" y2="80" className="sym" />
          {tertiary && (
            <>
              <circle cx="42" cy="40" r="14" className="sym" fill="none" />
              <line x1="56" y1="40" x2="60" y2="40" className="sym" />
            </>
          )}
        </svg>
      </SymbolSvg>
      <Terminal nodeId={id} id="t1" type="source" position={t1.position} style={t1.style} className="term" />
      <Terminal nodeId={id} id="t2" type="source" position={t2.position} style={t2.style} className="term" />
      {tertiary && (
        <Terminal nodeId={id} id="t3" type="source" position={t3.position} style={t3.style} className="term" />
      )}
      <NodeLabel beside={rot % 180 === 0 ? (tertiary ? 'left' : true) : false}>
        {String(data.params.name ?? '')}
        {kvText && <div className="sub-label">{kvText}</div>}
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}
