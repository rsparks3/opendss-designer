import { useCircuitStore } from '../store/circuitStore'
import { activeResult, activeStale, useResultsStore } from '../store/resultsStore'
import { DARK_ISLAND, islandColorOfSource, PRIORITIES, PRIORITY_COLORS, PRIORITY_LABELS } from '../lib/trace'

const kw = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} MW` : `${v.toFixed(0)} kW`)

/** In the 'islands' overlay, after a solve: a card per island -- what
 *  carries it, the load it serves, the source's loading against its rating,
 *  the voltage range -- and one for what is dark. Red when a source is past
 *  its rating or critical load is unserved. */
export function IslandCards() {
  const overlay = useResultsStore((s) => s.overlay)
  const result = useResultsStore(activeResult)
  const stale = useResultsStore(activeStale)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  if (overlay !== 'islands') return null
  const summary = result?.converged ? result.islands : null
  if (!summary || stale) {
    return (
      <div className="island-cards">
        <div className="island-card muted">Islands coloured from the drawing. Solve for what each one carries.</div>
      </div>
    )
  }
  const live = summary.islands.filter((i) => i.energized)
  const darkKw = PRIORITIES.reduce((s, p) => s + summary.unservedKw[p], 0)
  return (
    <div className="island-cards" role="list" aria-label="Islands">
      {live.map((isl) => {
        const color = isl.sources[0] ? islandColorOfSource(nodes, edges, isl.sources[0].id) : DARK_ISLAND
        return (
          <div key={isl.index} role="listitem" className={`island-card${isl.alarm ? ' alarm' : ' ok'}`} style={{ borderLeftColor: color }}>
            <div className="island-title">
              {isl.sources.map((s) => s.name).join(' + ')}
              {isl.multipleSources && <span className="muted"> (shared: indicative)</span>}
            </div>
            <div>Serves {kw(isl.servedKw)} · {isl.loadCount} load{isl.loadCount === 1 ? '' : 's'}</div>
            {isl.sources.filter((s) => s.loadingPct != null).map((s) => (
              <div key={s.id} className={(s.loadingPct ?? 0) > 100 ? 'bad' : ''}>
                {s.name}: {s.loadingPct!.toFixed(0)} % of {s.ratingKva!.toFixed(0)} kVA
                {s.fuelHours ? <span className="muted"> · {s.fuelHours} h fuel</span> : null}
              </div>
            ))}
            {isl.vminPu != null && <div>Voltage {isl.vminPu.toFixed(3)}–{isl.vmaxPu!.toFixed(3)} pu</div>}
          </div>
        )
      })}
      {darkKw > 0 && (
        <div role="listitem" className={`island-card${summary.unservedKw.critical > 0 ? ' alarm' : ''}`} style={{ borderLeftColor: DARK_ISLAND }}>
          <div className="island-title">De-energised · {kw(darkKw)}</div>
          {PRIORITIES.filter((p) => summary.unservedKw[p] > 0).map((p) => (
            <div key={p} className={p === 'critical' ? 'bad' : ''}>
              <span className="prio-dot" style={{ background: PRIORITY_COLORS[p] }} />
              {PRIORITY_LABELS[p]}: {kw(summary.unservedKw[p])}
            </div>
          ))}
        </div>
      )}
      <div className="island-card note">Isochronous generators are modelled as voltage sources: screening grade.</div>
    </div>
  )
}
