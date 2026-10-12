import { chooseOverlay, runReliability } from '../lib/fileActions'
import { indicesLine, SECTION_COLORS, UNSECTIONED_COLOR } from '../lib/reliability'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'

/** The Reliability tab: the indices, one row per protection section, and
 *  one per metered zone when there are several. Runs the study on demand;
 *  any circuit edit clears it, as with the fault study. */
export function ReliabilityPanel() {
  const reliability = useResultsStore((s) => s.reliability)
  const overlay = useResultsStore((s) => s.overlay)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  const nameOf = (id: string | null, fallback: string) => {
    const node = id ? nodes.find((n) => n.id === id) : undefined
    const name = node ? node.data.params.name : id ? edges.find((e) => e.id === id)?.data?.params.name : undefined
    return typeof name === 'string' && name ? name : fallback
  }
  const locate = (id: string | null) => {
    if (!id) return
    const isEdge = edges.some((e) => e.id === id)
    selectOnly(isEdge ? 'edge' : 'node', id)
  }

  if (!reliability) {
    return (
      <div className="bp-empty">
        <p>
          SAIFI, SAIDI and CAIDI from the fault rate, permanent-fault share and repair time of every line and
          device, and the customers on every load. Faults in a protection section (a fuse, recloser or relay and
          everything down to the next one) interrupt every customer downstream of the section's head.
        </p>
        <button type="button" onClick={() => void runReliability()}>
          Run the reliability study
        </button>
      </div>
    )
  }
  if (!reliability.converged) {
    return <div className="bp-empty">The reliability study did not run — see the Problems list.</div>
  }
  const r = reliability
  const f = (v: number | null | undefined, d: number) => (v == null ? '—' : v.toFixed(d))
  return (
    <div className="reliability-panel">
      <div className="reliability-indices">
        <span className="reliability-index" title="System average interruption frequency: interruptions per customer per year">
          <b>SAIFI</b> {f(r.saifi, 3)} /yr
        </span>
        <span className="reliability-index" title="System average interruption duration: hours out per customer per year">
          <b>SAIDI</b> {f(r.saidi, 3)} h/yr
        </span>
        <span className="reliability-index" title="Customer average interruption duration: hours per interruption">
          <b>CAIDI</b> {f(r.caidi, 2)} h
        </span>
        <span className="reliability-index">
          <b>{r.totalCustomers}</b> customers · {f(r.custInterrupts, 2)} interruptions and {f(r.custHours, 1)}{' '}
          customer-hours a year
        </span>
        {overlay !== 'reliability' && (
          <button type="button" onClick={() => chooseOverlay('reliability')} title="Colour the drawing by protection section">
            Show on the drawing
          </button>
        )}
      </div>
      {r.unsectioned.count > 0 && (
        <div className="reliability-warning">
          {r.unsectioned.count} element{r.unsectioned.count === 1 ? '' : 's'} between a meter and the first fuse,
          recloser or relay (fault rate {r.unsectioned.lambda.toFixed(3)} /yr in all) belong to no protection
          section, so faults there count for nothing. Put a relay or recloser at the feeder head to count them.
        </div>
      )}
      {r.meters.length > 1 && (
        <table className="bp-table">
          <thead>
            <tr>
              <th />
              <th>Metered at</th>
              <th>Customers</th>
              <th>SAIFI (/yr)</th>
              <th>SAIDI (h/yr)</th>
              <th>CAIDI (h)</th>
            </tr>
          </thead>
          <tbody>
            {r.meters.map((m) => (
              <tr key={m.name}>
                <td>
                  <button className="bp-locate" title="Select on diagram" onClick={() => locate(m.elementId)}>
                    ⌖
                  </button>
                </td>
                <td className="bp-ro">{nameOf(m.elementId, m.element)}</td>
                <td className="bp-ro">{m.customers}</td>
                <td className="bp-ro">{f(m.saifi, 3)}</td>
                <td className="bp-ro">{f(m.saidi, 3)}</td>
                <td className="bp-ro">{f(m.caidi, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="bp-table">
        <thead>
          <tr>
            <th />
            <th>Section head</th>
            <th>Device</th>
            <th>Branches</th>
            <th>Exposed (km)</th>
            <th>Faults (/yr)</th>
            <th>Repair (h)</th>
            <th>Customers downstream</th>
            <th>Cust·interruptions (/yr)</th>
            <th>Cust·hours (/yr)</th>
          </tr>
        </thead>
        <tbody>
          {r.sections.map((s, i) => (
            <tr key={s.id}>
              <td>
                <button className="bp-locate" title="Select on diagram" onClick={() => locate(s.headId)}>
                  ⌖
                </button>
              </td>
              <td className="bp-ro">
                <span className="phase-legend-swatch" style={{ background: SECTION_COLORS[i % SECTION_COLORS.length] }} />{' '}
                {nameOf(s.headId, s.head)}
              </td>
              <td className="bp-ro">{s.device}</td>
              <td className="bp-ro">{s.branches}</td>
              <td className="bp-ro">{s.lengthKm.toFixed(2)}</td>
              <td className="bp-ro">{s.lambda.toFixed(4)}</td>
              <td className="bp-ro">{f(s.avgRepairHrs, 1)}</td>
              <td className="bp-ro">{s.totalCustomers}</td>
              <td className="bp-ro">{s.custInterrupts.toFixed(3)}</td>
              <td className="bp-ro">{s.custHours.toFixed(2)}</td>
            </tr>
          ))}
          {r.unsectioned.count > 0 && (
            <tr>
              <td />
              <td className="bp-ro">
                <span className="phase-legend-swatch" style={{ background: UNSECTIONED_COLOR }} /> no protective device
                upstream
              </td>
              <td className="bp-ro">—</td>
              <td className="bp-ro">{r.unsectioned.count}</td>
              <td className="bp-ro">—</td>
              <td className="bp-ro">{r.unsectioned.lambda.toFixed(4)}</td>
              <td className="bp-ro">—</td>
              <td className="bp-ro">—</td>
              <td className="bp-ro">0</td>
              <td className="bp-ro">0</td>
            </tr>
          )}
          {r.sections.length === 0 && r.unsectioned.count === 0 && (
            <tr>
              <td colSpan={10} className="bp-ro">
                No protection sections: nothing is metered.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="library-note">{indicesLine(r)}. Values are OpenDSS's EnergyMeter reliability calculation.</div>
    </div>
  )
}
