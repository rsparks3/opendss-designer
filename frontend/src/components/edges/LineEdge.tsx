import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'
import { loadingColor, NEUTRAL } from '../../lib/colorScale'
import type { AppEdge } from '../../store/circuitStore'
import { useIsGrabbed } from '../../store/grabStore'
import { activeResult, activeStale, useResultsStore } from '../../store/resultsStore'
import { LoadingPie } from '../LoadingPie'
import { useEdgePath, WaypointDots } from './waypoints'

export function LineEdge(props: EdgeProps<AppEdge>) {
  const [path, labelX, labelY] = useEdgePath(props)
  const grabbed = useIsGrabbed(props.id)
  const overlay = useResultsStore((s) => s.overlay)
  const result = useResultsStore(activeResult)
  const stale = useResultsStore(activeStale)

  const el = result?.converged
    ? Object.values(result.elements).find((e) => e.id === props.id)
    : null

  let stroke = props.selected || grabbed ? '#1976d2' : '#263238'
  let resultText: string | null = null
  let loadingPct: number | null = null
  if (el && !stale) {
    if (overlay === 'loading' && el.loadingPct != null) {
      stroke = loadingColor(el.loadingPct)
      loadingPct = el.loadingPct
      resultText = `${el.loadingPct.toFixed(0)}%`
    } else if (overlay === 'power') {
      stroke = NEUTRAL
      resultText = `${el.kw.toFixed(0)} kW / ${el.kvar.toFixed(0)} kvar`
    }
  }

  const name = String(props.data?.params?.name ?? '')
  // A label centred on the midpoint sits on top of a vertical line. Judge the
  // line's overall direction from its endpoints and put the label beside a
  // mostly-vertical one, above a mostly-horizontal one.
  const vertical =
    Math.abs(props.targetX - props.sourceX) < Math.abs(props.targetY - props.sourceY)
  const labelTransform = vertical
    ? `translate(0, -50%) translate(${labelX + 8}px, ${labelY}px)`
    : `translate(-50%, -50%) translate(${labelX}px, ${labelY - 12}px)`
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          stroke,
          strokeWidth: props.selected ? 3.5 : 2.5,
          strokeDasharray: grabbed ? '6 4' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="edge-label nodrag nopan"
          style={{
            transform: labelTransform,
            opacity: stale ? 0.4 : 1,
          }}
        >
          <span className="edge-name">{name}</span>
          {resultText && (
            <span className="edge-result" style={{ color: stroke }}>
              {loadingPct != null && <LoadingPie pct={loadingPct} size={15} />}
              {resultText}
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
      {props.selected && (
        <WaypointDots edgeId={props.id} waypoints={props.data?.waypoints ?? []} />
      )}
    </>
  )
}
