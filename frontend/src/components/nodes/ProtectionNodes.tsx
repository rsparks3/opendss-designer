import { Position, type NodeProps } from '@xyflow/react'
import { useCircuitStore, type AppNode } from '../../store/circuitStore'
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

/** Fuse, recloser and relay: each is a switch the diagram wires into, plus a
 *  control that watches it. They share the switch behaviour — double-click
 *  opens and closes — and differ only in their symbol and sub-label. */
function ProtectiveDevice({
  id,
  data,
  symbol,
  subLabel,
  openWord,
  closedWord,
}: {
  id: string
  data: AppNode['data']
  symbol: (closed: boolean) => React.ReactNode
  subLabel: string
  openWord: string
  closedWord: string
}) {
  const issueClass = useNodeIssueClass(id)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(40, 60, rot)
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
      title={`Double-click to ${closed ? openWord : closedWord}`}
    >
      <SymbolSvg rotation={rot} w={40} h={60}>
        <svg width="40" height="60" viewBox="0 0 40 60">
          <line x1="20" y1="0" x2="20" y2="20" className="sym" />
          {symbol(closed)}
          <line x1="20" y1="40" x2="20" y2="60" className="sym" />
        </svg>
      </SymbolSvg>
      <Terminal nodeId={id} id="t1" type="source" position={rotatePosition(Position.Top, rot)} className="term" />
      <Terminal nodeId={id} id="t2" type="source" position={rotatePosition(Position.Bottom, rot)} className="term" />
      <NodeLabel beside={rot % 180 === 0}>
        {String(data.params.name ?? '')}
        <div className="sub-label">{closed ? subLabel : openWord.toUpperCase()}</div>
      </NodeLabel>
      <ElementBadge nodeId={id} />
    </div>
  )
}

export function FuseNode({ id, data }: NodeProps<AppNode>) {
  const rated = data.params.ratedcurrent
  return (
    <ProtectiveDevice
      id={id}
      data={data}
      openWord="blown"
      closedWord="replace"
      subLabel={rated != null ? `${rated} A` : 'fuse'}
      symbol={(closed) => (
        <>
          <rect x="13" y="20" width="14" height="20" className="sym" fill="none" />
          {closed ? (
            <line x1="20" y1="20" x2="20" y2="40" className="sym" />
          ) : (
            <>
              <line x1="20" y1="20" x2="20" y2="27" className="sym" />
              <line x1="20" y1="33" x2="20" y2="40" className="sym" />
            </>
          )}
        </>
      )}
    />
  )
}

export function RecloserNode({ id, data }: NodeProps<AppNode>) {
  const trip = data.params.phasetrip
  return (
    <ProtectiveDevice
      id={id}
      data={data}
      openWord="open"
      closedWord="close"
      subLabel={trip != null ? `${trip} A` : 'recloser'}
      symbol={(closed) => (
        <>
          <circle cx="20" cy="30" r="11" className="sym" fill="none" />
          {closed ? (
            <line x1="20" y1="19" x2="20" y2="41" className="sym" />
          ) : (
            <line x1="13" y1="38" x2="27" y2="23" className="sym" />
          )}
        </>
      )}
    />
  )
}

export function RelayNode({ id, data }: NodeProps<AppNode>) {
  const trip = data.params.phasetrip
  const ground = data.params.groundcurve
  // ANSI device numbers: 51 time overcurrent, 51N with a ground unit.
  const device = ground && ground !== 'none' ? '51N' : '51'
  return (
    <ProtectiveDevice
      id={id}
      data={data}
      openWord="open"
      closedWord="close"
      subLabel={trip != null ? `${device} · ${trip} A` : device}
      symbol={(closed) => (
        <>
          <rect
            x="10"
            y="20"
            width="20"
            height="20"
            className={closed ? 'sym-fill' : 'sym'}
            fill={closed ? undefined : 'none'}
          />
          {/* Kept inside the 40-wide box and clear of both the stub and the
              square, so the device number never collides with the symbol. */}
          <circle cx="31" cy="12" r="8" className="sym" fill="none" />
          <text x="31" y="15.5" textAnchor="middle" className="sym-text" fontSize="9">
            {device}
          </text>
        </>
      )}
    />
  )
}
