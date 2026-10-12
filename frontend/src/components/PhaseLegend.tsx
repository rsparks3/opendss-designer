import { PHASE_LEGEND } from '../lib/phasing'
import { indicesLine, reliabilityLegend } from '../lib/reliability'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'

/** Key for the 'phases' overlay. Lines wear the phases they carry, wires and
 *  busbars the phases that reach them, so one legend serves both. In the
 *  'reliability' overlay the same corner carries the indices and a row per
 *  protection section, in the section's colour. */
export function PhaseLegend() {
  const overlay = useResultsStore((s) => s.overlay)
  const reliability = useResultsStore((s) => s.reliability)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
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
