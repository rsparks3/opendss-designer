import { fmtSimHour } from '../lib/axis'
import { useCircuitStore } from '../store/circuitStore'
import { activeResult, activeStale, useResultsStore } from '../store/resultsStore'
import type { BusResult, ElementResult } from '../types/circuit'

export interface HoverTarget {
  kind: 'node' | 'edge'
  id: string
  x: number
  y: number
}

/** Full-detail readout on hover: per-phase voltage magnitude/angle for every
 *  bus the element touches, plus currents/power/loading for series elements.
 *  Only shown when fresh results exist. */
export function ResultTooltip({ target }: { target: HoverTarget }) {
  const result = useResultsStore(activeResult)
  const fault = useResultsStore((s) => s.fault)
  const overlay = useResultsStore((s) => s.overlay)
  const stale = useResultsStore(activeStale)
  // In time-series mode the tooltip reads the scrubbed step; note its hour.
  // (Primitive selectors so re-renders only happen when the values change.)
  const scrubHour = useResultsStore((s) =>
    s.analysisMode === 'timeseries' && s.timeseries && s.tsIndex != null
      ? s.timeseries.time[s.tsIndex]
      : null,
  )
  const scrubMode = useResultsStore((s) => s.timeseries?.mode ?? 'daily')
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  if (!result?.converged || stale) return null

  const params =
    target.kind === 'node'
      ? nodes.find((n) => n.id === target.id)?.data.params
      : edges.find((e) => e.id === target.id)?.data?.params
  const busIds =
    (target.kind === 'node' ? result.nodeBuses[target.id] : result.lineBuses[target.id]) ?? []
  // Dedupe (a breaker between the same synthesized bus lists it twice).
  const buses = [...new Set(busIds)]
    .map((b) => [b, result.buses[b]] as [string, BusResult | undefined])
    .filter(([, d]) => d)
  const element = Object.entries(result.elements).find(([, el]) => el.id === target.id) as
    | [string, ElementResult]
    | undefined
  // Fault section only in fault-overlay mode, for the element's first bus.
  const faultData =
    overlay === 'fault' && fault?.converged && target.kind === 'node'
      ? fault.buses[fault.nodeBuses[target.id]?.[0] ?? '']
      : undefined

  if (!buses.length && !element) return null

  return (
    <div className="result-tooltip" style={{ left: target.x + 14, top: target.y + 14 }}>
      <div className="rt-title">
        {String(params?.name ?? target.id)}
        {scrubHour != null && (
          <span className="rt-hour"> @ {fmtSimHour(scrubHour, scrubMode)}</span>
        )}
      </div>
      {buses.map(([busName, data]) => (
        <div key={busName} className="rt-section">
          <div className="rt-heading">
            bus {busName} · {(data!.kvBase * Math.sqrt(3)).toFixed(2)} kV
          </div>
          <table>
            <tbody>
              {data!.vmagPu.map((v, i) => (
                <tr key={i}>
                  <td>ph {data!.nodes[i] ?? i + 1}</td>
                  <td>{v.toFixed(4)} pu</td>
                  <td>{(v * data!.kvBase).toFixed(3)} kV</td>
                  <td>{data!.vangDeg?.[i] != null ? `${data!.vangDeg[i].toFixed(1)}°` : ''}</td>
                </tr>
              ))}
              {/* Time-series steps record only the per-bus voltage envelope. */}
              {data!.vmagPu.length === 0 && data!.vminPu != null && (
                <>
                  <tr>
                    <td>V min</td>
                    <td>{data!.vminPu.toFixed(4)} pu</td>
                    <td>{(data!.vminPu * data!.kvBase).toFixed(3)} kV</td>
                    <td />
                  </tr>
                  <tr>
                    <td>V max</td>
                    <td>{data!.vmaxPu?.toFixed(4)} pu</td>
                    <td>{((data!.vmaxPu ?? 0) * data!.kvBase).toFixed(3)} kV</td>
                    <td />
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      ))}
      {faultData && (
        <div className="rt-section">
          <div className="rt-heading">short circuit</div>
          <table>
            <tbody>
              <tr>
                <td>3φ fault</td>
                <td colSpan={3}>
                  {faultData.if3phA != null ? `${(faultData.if3phA / 1000).toFixed(2)} kA` : '—'}
                  {faultData.scMva3 != null ? ` · ${faultData.scMva3.toFixed(0)} MVA` : ''}
                </td>
              </tr>
              <tr>
                <td>1φ fault</td>
                <td colSpan={3}>
                  {faultData.if1phA != null ? `${(faultData.if1phA / 1000).toFixed(2)} kA` : '—'}
                </td>
              </tr>
              <tr>
                <td>Z1</td>
                <td colSpan={3}>
                  {faultData.zsc1.r.toFixed(3)} + j{faultData.zsc1.x.toFixed(3)} Ω
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {element && (
        <div className="rt-section">
          <div className="rt-heading">{element[0]}</div>
          <table>
            <tbody>
              {element[1].currents.map((a, i) => (
                <tr key={i}>
                  <td>I ph {i + 1}</td>
                  <td colSpan={3}>{a.toFixed(1)} A</td>
                </tr>
              ))}
              <tr>
                <td>power</td>
                <td colSpan={3}>
                  {element[1].kw.toFixed(1)} kW / {element[1].kvar.toFixed(1)} kvar
                </td>
              </tr>
              {element[1].loadingPct != null && (
                <tr>
                  <td>loading</td>
                  <td colSpan={3}>
                    {element[1].loadingPct.toFixed(0)}%
                    {element[1].normAmps ? ` of ${element[1].normAmps} A` : ''}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
