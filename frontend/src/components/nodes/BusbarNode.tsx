import {
  NodeResizer,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  beginGesture,
  busbarHandleCount,
  endGesture,
  handlesInUse,
  LARGE_CIRCUIT,
  useCircuitStore,
  type AppNode,
} from '../../store/circuitStore'
import { useUiStore } from '../../store/uiStore'
import { SYMBOL_PITCH } from '../../lib/defaults'
import { phaseColor } from '../../lib/phasing'
import { useResultsStore } from '../../store/resultsStore'
import { FaultBadge, NodeLabel, PhaseBadge, Terminal, useNodeIssueClass, VoltageBadge } from './common'

const BAR_H = 14

export function BusbarNode({ id, data, width, selected }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const setBusbarWidth = useCircuitStore((s) => s.setBusbarWidth)
  const updateNodeInternals = useUpdateNodeInternals()
  const w = width ?? 240
  const count = busbarHandleCount(w)
  // On a large circuit a bar draws only the terminals that hold a wire,
  // and the whole row while it is hovered, selected or a wire is looking
  // for a home. Every terminal is a handle React Flow and the store watch
  // on every update, and twenty per bus across three thousand buses was
  // most of the cost of drawing a real feeder.
  const large = useCircuitStore((s) => s.nodes.length > LARGE_CIRCUIT)
  const inUse = useCircuitStore((s) => (large ? handlesInUse(s.edges, id) : ''))
  const routing = useUiStore((s) => s.routing)
  const [hovered, setHovered] = useState(false)
  const all = !large || hovered || !!selected || routing
  const shown = useMemo(() => new Set(inUse.split(',')), [inUse])
  const visible = (h: string) => all || shown.has(h)
  // The bar is the bus, so in the 'phases' overlay it wears the phases that
  // reach it. Undefined until validation has answered: plain ink meanwhile.
  const barColor = useResultsStore((s) => {
    if (s.overlay !== 'phases') return undefined
    const letters = s.phases?.nodes[id]?.[0]
    return letters === undefined ? undefined : phaseColor(letters)
  })

  // Re-measure the handles when they change -- but not on mount, which
  // React Flow measures anyway: three thousand bars asking at once is three
  // thousand passes over every node.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) updateNodeInternals(id)
    mounted.current = true
  }, [w, count, id, all, inUse, updateNodeInternals])

  return (
    <div
      className={`symbol-node busbar-node${issueClass}`}
      style={{ width: w, height: BAR_H }}
      onMouseEnter={large ? () => setHovered(true) : undefined}
      onMouseLeave={large ? () => setHovered(false) : undefined}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={60}
        minHeight={BAR_H}
        maxHeight={BAR_H}
        onResizeStart={beginGesture}
        onResizeEnd={(_e, p) => {
          setBusbarWidth(id, p.width)
          endGesture()
        }}
      />
      <div className="busbar-bar" style={barColor ? { background: barColor } : undefined} />
      {/* Two handle rows: b<i> route edges upward, c<i> route them downward,
          so elements below the bar connect from beneath instead of looping
          over the top. Electrically every handle is the same bus.
          Handles are placed in pixels on the symbol pitch — 10, 30, 50, … from
          the bar's grid-snapped left edge — so every one of them lands on the
          snap grid, exactly like a symbol's centered terminal. A percentage
          would only line up when the width divides evenly. */}
      {Array.from({ length: count }, (_, i) => visible(`b${i}`) && (
        <Terminal
          key={`b${i}`}
          nodeId={id}
          id={`b${i}`}
          type="source"
          position={Position.Top}
          className="term busbar-term"
          style={{ left: (i + 0.5) * SYMBOL_PITCH, top: 2 }}
        />
      ))}
      {Array.from({ length: count }, (_, i) => visible(`c${i}`) && (
        <Terminal
          key={`c${i}`}
          nodeId={id}
          id={`c${i}`}
          type="source"
          position={Position.Bottom}
          className="term busbar-term"
          style={{ left: (i + 0.5) * SYMBOL_PITCH, bottom: -2 }}
        />
      ))}
      {data.params.compact !== true && <NodeLabel>{String(data.params.name ?? '')}</NodeLabel>}
      <VoltageBadge nodeId={id} />
      <FaultBadge nodeId={id} />
      <PhaseBadge nodeId={id} />
    </div>
  )
}
