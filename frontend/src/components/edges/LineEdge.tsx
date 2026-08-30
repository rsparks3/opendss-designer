import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'
import { loadingColor, NEUTRAL } from '../../lib/colorScale'
import type { AppEdge } from '../../store/circuitStore'
import { activeResult, activeStale, useResultsStore } from '../../store/resultsStore'
import { LoadingPie } from '../LoadingPie'
import { useEdgePath, WaypointDots } from './waypoints'

export function LineEdge(props: EdgeProps<AppEdge>) {
  const [path, labelX, labelY] = useEdgePath(props)
  const overlay = useResultsStore((s) => s.overlay)
  const result = useResultsStore(activeResult)
  const stale = useResultsStore(activeStale)

  const el = result?.converged
    ? Object.values(result.elements).find((e) => e.id === props.id)
    : null

  let stroke = props.selected ? '#1976d2' : '#263238'
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
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{ stroke, strokeWidth: props.selected ? 3.5 : 2.5 }}
      />
      <EdgeLabelRenderer>
        <div
          className="edge-label nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 12}px)`,
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
