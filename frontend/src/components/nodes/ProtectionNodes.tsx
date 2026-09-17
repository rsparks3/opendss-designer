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
  usePhaseInk,
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
  w = 40,
  h = 60,
}: {
  id: string
  data: AppNode['data']
  /** Draws the whole symbol, stubs included, inside a w x h viewBox. */
  symbol: (closed: boolean) => React.ReactNode
  subLabel: string
  openWord: string
  closedWord: string
  w?: number
  h?: number
}) {
  const issueClass = useNodeIssueClass(id)
  const phaseInk = usePhaseInk(data.params)
  const rot = useSymbolRotation(id, data.params)
  const box = rotatedBox(w, h, rot)
  const updateNodeParams = useCircuitStore((s) => s.updateNodeParams)
  const closed = data.params.closed !== false
  return (
    <div
      className={`symbol-node${issueClass}`}
      style={{ width: box.w, height: box.h, ...phaseInk }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        updateNodeParams(id, { closed: !closed })
      }}
      title={`Double-click to ${closed ? openWord : closedWord}`}
    >
      <SymbolSvg rotation={rot} w={w} h={h}>
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          {symbol(closed)}
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
          <line x1="20" y1="0" x2="20" y2="20" className="sym" />
          <line x1="20" y1="40" x2="20" y2="60" className="sym" />
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
          <line x1="20" y1="0" x2="20" y2="19" className="sym" />
          <line x1="20" y1="41" x2="20" y2="60" className="sym" />
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
  // IEEE C37.2 device function numbers: 51 time overcurrent, 51N once a
  // ground unit is set. Drawn the way a one-line does it — the breaker sits in
  // the line, the relay is its own circled device number beside it, and the
  // dashed link is the trip signal between them.
  const device = ground && ground !== 'none' ? '51N' : '51'
  return (
    <ProtectiveDevice
      id={id}
      data={data}
      w={60}
      h={60}
      openWord="open"
      closedWord="close"
      subLabel={trip != null ? `${device} · ${trip} A` : device}
      symbol={(closed) => (
        <>
          <line x1="30" y1="0" x2="30" y2="24" className="sym" />
          <rect
            x="20"
            y="24"
            width="20"
            height="20"
            className={closed ? 'sym-fill' : 'sym'}
            fill={closed ? undefined : 'none'}
          />
          <line x1="30" y1="44" x2="30" y2="60" className="sym" />
          <circle cx="47" cy="12" r="11" className="sym" fill="none" />
          {/* 51N is a character wider than 51, so it steps down a size rather
              than filling the circle to its edge. The size lives in CSS: an
              SVG font-size attribute loses to the class's font shorthand. */}
          <text
            x="47"
            y="15.3"
            textAnchor="middle"
            className={`sym-text device-no${device.length > 2 ? ' wide' : ''}`}
          >
            {device}
          </text>
          {/* The trip signal, routed like a control wire rather than cutting
              the corner, so it reads as a link and not as a stray tick. */}
          <path d="M47 23 V34 H40" className="sym trip-link" fill="none" />
        </>
      )}
    />
  )
}
