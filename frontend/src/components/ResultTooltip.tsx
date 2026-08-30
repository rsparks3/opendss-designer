import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
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
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
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

  if (!buses.length && !element) return null

  return (
    <div className="result-tooltip" style={{ left: target.x + 14, top: target.y + 14 }}>
      <div className="rt-title">{String(params?.name ?? target.id)}</div>
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
            </tbody>
          </table>
        </div>
      ))}
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
