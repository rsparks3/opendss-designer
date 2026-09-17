import { PHASE_LEGEND } from '../lib/phasing'
import { useResultsStore } from '../store/resultsStore'

/** Key for the 'phases' overlay. Lines wear the phases they carry, wires and
 *  busbars the phases that reach them, so one legend serves both. */
export function PhaseLegend() {
  const on = useResultsStore((s) => s.overlay === 'phases')
  if (!on) return null
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
