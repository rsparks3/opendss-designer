import { PRIORITIES, PRIORITY_COLORS, PRIORITY_LABELS } from '../lib/trace'
import { PHASE_LEGEND } from '../lib/phasing'
import { indicesLine, reliabilityLegend } from '../lib/reliability'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { formatKw, HC_LABELS, hostingColor } from '../lib/hostingCapacity'

/** Key for the 'phases' overlay. Lines wear the phases they carry, wires and
 *  busbars the phases that reach them, so one legend serves both. In the
 *  'reliability' overlay the same corner carries the indices and a row per
 *  protection section, in the section's colour. */
export function PhaseLegend() {
  const overlay = useResultsStore((s) => s.overlay)
  const reliability = useResultsStore((s) => s.reliability)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const hosting = useResultsStore((s) => s.hosting)
  if (overlay === 'priority') {
    return (
      <div className="phase-legend" role="list" aria-label="Load priority">
        {PRIORITIES.map((p) => (
          <span key={p} role="listitem" className="phase-legend-item">
            <span className="phase-legend-swatch" style={{ background: PRIORITY_COLORS[p] }} />
            {PRIORITY_LABELS[p]}
          </span>
        ))}
        <span role="listitem" className="phase-legend-item">buses: highest they would drop</span>
      </div>
    )
  }
  if (overlay === 'hosting') {
    if (!hosting?.converged) return null
    const max = hosting.summary.maxKw ?? 0
    const steps = [0, 0.25, 0.5, 0.75, 1]
    return (
      <div className="phase-legend reliability-legend" role="list" aria-label="Hosting capacity">
        <span role="listitem" className="phase-legend-item legend-indices">
          {hosting.kind === 'der' ? 'DER' : 'Load'} hosting capacity · {hosting.loadLevel.name} · {hosting.summary.evaluated} buses
        </span>
        {steps.map((t) => (
          <span key={t} role="listitem" className="phase-legend-item">
            <span className="phase-legend-swatch" style={{ background: hostingColor(t * max, max) }} />
            {t === 0 ? 'none' : formatKw(t * max)}
          </span>
        ))}
        <span role="listitem" className="phase-legend-item">
          binds on{' '}
          {Object.entries(hosting.summary.bindingCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, n]) => `${HC_LABELS[k] ?? k} ×${n}`)
            .join(', ')}
        </span>
      </div>
    )
  }
  if (overlay === 'reliability') {
    if (!reliability?.converged) return null
    const nameOf = (id: string | null, fallback: string) => {
      const node = id ? nodes.find((n) => n.id === id) : undefined
      const name = node ? node.data.params.name : id ? edges.find((e) => e.id === id)?.data?.params.name : undefined
      return typeof name === 'string' && name ? name : fallback
    }
    const rows = reliabilityLegend(reliability, nameOf)
    return (
      <div className="phase-legend reliability-legend" role="list" aria-label="Reliability">
        <span role="listitem" className="phase-legend-item legend-indices">
          {indicesLine(reliability)} · {reliability.totalCustomers} customers
        </span>
        {rows.map((e) => (
          <span key={e.label} role="listitem" className="phase-legend-item">
            <span className="phase-legend-swatch" style={{ background: e.color }} />
            {e.label}
          </span>
        ))}
      </div>
    )
  }
  if (overlay !== 'phases') return null
  return (
    <div className="phase-legend" role="list" aria-label="Phase colours">
      {PHASE_LEGEND.map((e) => (
        <span key={e.label} role="listitem" className="phase-legend-item">
          <span className="phase-legend-swatch" style={{ background: e.color }} />
          {e.label}
        </span>
      ))}
    </div>
  )
}
