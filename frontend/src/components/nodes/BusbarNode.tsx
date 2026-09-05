import {
  NodeResizer,
  Position,
  useConnection,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react'
import { useEffect } from 'react'
import { beginGesture, busbarHandleCount, endGesture, useCircuitStore, type AppNode } from '../../store/circuitStore'
import { useGrabStore } from '../../store/grabStore'
import { SYMBOL_PITCH } from '../../lib/defaults'
import { FaultBadge, NodeLabel, Terminal, useNodeIssueClass, VoltageBadge } from './common'

const BAR_H = 14

export function BusbarNode({ id, data, width, selected }: NodeProps<AppNode>) {
  const issueClass = useNodeIssueClass(id)
  const setBusbarWidth = useCircuitStore((s) => s.setBusbarWidth)
  const updateNodeInternals = useUpdateNodeInternals()
  const w = width ?? 240
  const count = busbarHandleCount(w)
  // The attach points are only useful while a wire is looking for a home:
  // a new connection being dragged, or an existing end being moved. The rest
  // of the time they are clutter, so they fade in on hover and while routing.
  const connecting = useConnection((c) => c.inProgress)
  const grabbing = useGrabStore((s) => s.edgeId !== null)
  const routing = connecting || grabbing

  useEffect(() => {
    updateNodeInternals(id)
  }, [w, count, id, updateNodeInternals])

  return (
    <div
      className={`symbol-node busbar-node${issueClass}${routing ? ' routing' : ''}`}
      style={{ width: w, height: BAR_H }}
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
      <div className="busbar-bar" />
      {/* Two handle rows: b<i> route edges upward, c<i> route them downward,
          so elements below the bar connect from beneath instead of looping
          over the top. Electrically every handle is the same bus.
          Handles are placed in pixels on the symbol pitch — 10, 30, 50, … from
          the bar's grid-snapped left edge — so every one of them lands on the
          snap grid, exactly like a symbol's centered terminal. A percentage
          would only line up when the width divides evenly. */}
      {Array.from({ length: count }, (_, i) => (
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
      {Array.from({ length: count }, (_, i) => (
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
      <NodeLabel>{String(data.params.name ?? '')}</NodeLabel>
      <VoltageBadge nodeId={id} />
      <FaultBadge nodeId={id} />
    </div>
  )
}
