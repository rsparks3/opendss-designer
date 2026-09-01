import { Handle, Position, useReactFlow, useUpdateNodeInternals, type HandleProps } from '@xyflow/react'
import { useEffect, type ReactNode } from 'react'
import { useAltHeld } from '../../lib/altKey'
import { loadingColor } from '../../lib/colorScale'
import { edgesAtTerminal, useCircuitStore, type EdgeEnd } from '../../store/circuitStore'
import { beginGrab, useGrabStore } from '../../store/grabStore'
import { activeResult, activeStale, useResultsStore } from '../../store/resultsStore'
import type { Params } from '../../types/circuit'
import { LoadingPie } from '../LoadingPie'

// ---------------------------------------------------------------------------
// Terminals
//
// A connection point on a symbol. Dragging from a terminal that already holds
// exactly one wire moves that wire's end instead of drawing a second one, so
// re-routing a line between components is a single gesture.
//
// ReactFlow's <Handle> spreads its extra props *after* its own onMouseDown, so
// passing one here replaces the start-a-new-connection handler on precisely
// the terminals we want to reinterpret — and nowhere else. isConnectableEnd
// stays on throughout: an occupied terminal is still a valid drop target.

export function Terminal({ nodeId, ...props }: { nodeId: string } & HandleProps) {
  const { screenToFlowPosition, getZoom } = useReactFlow()
  const handleId = props.id ?? 't1'
  // Only an unambiguous terminal is grabbable: with two wires on one dot
  // there is no telling which one the drag meant to pick up.
  const grabEdgeId = useCircuitStore((s) => {
    const ids = edgesAtTerminal(s, nodeId, handleId)
    return ids.length === 1 ? ids[0] : null
  })
  const altHeld = useAltHeld()
  const grabbable = grabEdgeId !== null && !altHeld
  const drop = useGrabStore((s) =>
    s.target?.nodeId === nodeId && s.target.handleId === handleId
      ? s.refusal
        ? ' drop-refused'
        : ' drop-target'
      : '',
  )

  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0 || event.altKey || !grabEdgeId) return
    const edge = useCircuitStore.getState().edges.find((e) => e.id === grabEdgeId)
    if (!edge) return
    const end: EdgeEnd =
      edge.source === nodeId && (edge.sourceHandle ?? 't1') === handleId ? 'source' : 'target'
    const fixed =
      end === 'source'
        ? { nodeId: edge.target, handleId: edge.targetHandle ?? 't1' }
        : { nodeId: edge.source, handleId: edge.sourceHandle ?? 't1' }
    // Keep the press off the node itself; the click that ends the drag is
    // swallowed by the grab store.
    event.stopPropagation()
    beginGrab(event, {
      edgeId: edge.id,
      end,
      fixed,
      project: (p) => screenToFlowPosition(p, { snapToGrid: false }),
      getZoom,
    })
  }

  return (
    <Handle
      {...props}
      {...(grabbable ? { onMouseDown } : {})}
      isConnectableStart={!grabbable}
      className={`${props.className ?? ''}${grabbable ? ' grabbable' : ''}${drop}`}
    />
  )
}

// ---------------------------------------------------------------------------
// Symbol rotation (R key / context menu): params.rotation ∈ {0, 90, 180, 270}.
// The SVG rotates; the container swaps width/height at 90/270 so handles,
// labels and badges stay attached to the right container edges.

const POS_ORDER = [Position.Top, Position.Right, Position.Bottom, Position.Left]

/** Where a handle's base position ends up after rotating clockwise. */
export function rotatePosition(base: Position, rotation: number): Position {
  const steps = ((Math.round(rotation / 90) % 4) + 4) % 4
  return POS_ORDER[(POS_ORDER.indexOf(base) + steps) % 4]
}

/** Current rotation for a node; re-measures handles when it changes. */
export function useSymbolRotation(id: string, params: Params): number {
  const rotation = Number(params.rotation) || 0
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => updateNodeInternals(id), [rotation, id, updateNodeInternals])
  return rotation
}

/** Outer container size for a w×h symbol at the given rotation. */
export function rotatedBox(w: number, h: number, rotation: number): { w: number; h: number } {
  return rotation % 180 ? { w: h, h: w } : { w, h }
}

/** Renders the symbol SVG rotated about the container center. */
export function SymbolSvg({
  rotation,
  w,
  h,
  children,
}: {
  rotation: number
  w: number
  h: number
  children: ReactNode
}) {
  const box = rotatedBox(w, h, rotation)
  return (
    <div
      style={{
        position: 'absolute',
        left: (box.w - w) / 2,
        top: (box.h - h) / 2,
        width: w,
        height: h,
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
      }}
    >
      {children}
    </div>
  )
}

export function useNodeIssueClass(id: string): string {
  const issues = useResultsStore((s) => s.issues)
  const mine = issues.filter((i) => i.nodeId === id)
  if (mine.some((i) => i.severity === 'error')) return ' issue-error'
  if (mine.length) return ' issue-warning'
  return ''
}

export function NodeLabel({ children }: { children: ReactNode }) {
  return <div className="node-label">{children}</div>
}

export function Badge({ color, children }: { color: string; children: ReactNode }) {
  const stale = useResultsStore(activeStale)
  return (
    <div className="result-badge" style={{ background: color, opacity: stale ? 0.35 : 1 }}>
      {children}
    </div>
  )
}

/** Voltage badge for any node sitting on a bus, shown in 'voltage' overlay
 *  mode. In time-series mode it reads the scrubbed step of the recorded run. */
export function VoltageBadge({ nodeId }: { nodeId: string }) {
  const overlay = useResultsStore((s) => s.overlay)
  const result = useResultsStore(activeResult)
  if (overlay !== 'voltage' || !result?.converged) return null
  const bus = result.nodeBuses[nodeId]?.[0]
  const data = bus ? result.buses[bus] : null
  if (!data || data.vminPu == null) return null
  return <VBadgeInner v={data.vminPu} />
}

function VBadgeInner({ v }: { v: number }) {
  // lazy import to avoid circular: color logic inline
  const color = v < 0.5 ? '#546e7a' : v < 0.95 ? '#0277bd' : v > 1.05 ? '#d32f2f' : '#2e7d32'
  return <Badge color={color}>{v.toFixed(3)} pu</Badge>
}

/** 3-phase prospective fault current at the node's bus ('fault' overlay). */
export function FaultBadge({ nodeId }: { nodeId: string }) {
  const overlay = useResultsStore((s) => s.overlay)
  const fault = useResultsStore((s) => s.fault)
  if (overlay !== 'fault' || !fault?.converged) return null
  const bus = fault.nodeBuses[nodeId]?.[0]
  const data = bus ? fault.buses[bus] : null
  if (!data?.if3phA) return null
  return <Badge color="#5e35b1">{(data.if3phA / 1000).toFixed(1)} kA</Badge>
}

/** Loading pie in a light pill, dark text — shared by node badges. */
export function PieBadge({ pct }: { pct: number }) {
  const stale = useResultsStore(activeStale)
  return (
    <div className="result-badge pie-badge" style={{ opacity: stale ? 0.35 : 1 }}>
      <LoadingPie pct={pct} />
      <span style={{ color: loadingColor(pct) }}>{pct.toFixed(0)}%</span>
    </div>
  )
}

/** Loading/power badge for series elements (transformer, breaker). */
export function ElementBadge({ nodeId }: { nodeId: string }) {
  const overlay = useResultsStore((s) => s.overlay)
  const result = useResultsStore(activeResult)
  if ((overlay !== 'loading' && overlay !== 'power') || !result?.converged) return null
  const el = Object.values(result.elements).find((e) => e.id === nodeId)
  if (!el) return null
  if (overlay === 'power') {
    return <Badge color="#455a64">{el.kw.toFixed(0)} kW</Badge>
  }
  if (el.loadingPct == null) return null
  return <PieBadge pct={el.loadingPct} />
}
