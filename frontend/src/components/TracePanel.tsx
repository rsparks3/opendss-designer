import { useCircuitStore } from '../store/circuitStore'
import { useUiStore } from '../store/uiStore'
import { PRIORITIES, PRIORITY_COLORS, PRIORITY_LABELS, type TraceView } from '../lib/trace'

const fmtKw = (kw: number) => (kw >= 1000 ? `${(kw / 1000).toFixed(2)} MW` : `${kw.toFixed(0)} kW`)

/** The answer to a trace beside the lit drawing: the path to each source,
 *  or what the element would drop, grouped by priority with kW and
 *  customers. A load in the list selects it on the drawing. */
export function TracePanel({ view }: { view: TraceView }) {
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  const close = () => useUiStore.getState().setTrace(null)
  const nameOf = (id: string | null) => {
    if (!id) return '—'
    const n = nodes.find((x) => x.id === id)
    const p = n ? n.data.params : edges.find((e) => e.id === id)?.data?.params
    return String(p?.name || id)
  }
  const title = nameOf(view.elementId)

  if (view.kind === 'upstream') {
    return (
      <div className="trace-panel" role="dialog" aria-label="Trace to source">
        <h4>
          Trace to source · {title}
          <span className="spacer" />
          <button className="trace-close" title="Close (Esc)" onClick={close}>×</button>
        </h4>
        {view.paths.length === 0 && <div className="muted">No source reaches this element: it is de-energised as drawn.</div>}
        {view.paths.map((p) => (
          <div key={p.sourceId}>
            <div className="trace-group">From {nameOf(p.sourceId)} · {p.elements.length} in series</div>
            <ol>
              {p.elements.map((id) => <li key={id}>{nameOf(id)}</li>)}
              <li><strong>{title}</strong></li>
            </ol>
          </div>
        ))}
        {view.paths.length > 1 && <div className="muted">Fed from {view.paths.length} sources: the shortest way to each is shown.</div>}
        {view.firstProtective && (
          <div>First protective device upstream: <strong>{nameOf(view.firstProtective)}</strong></div>
        )}
      </div>
    )
  }

  const d = view.downstream!
  const { rows, byPriority, totalKw } = d.loads
  return (
    <div className="trace-panel" role="dialog" aria-label="Downstream">
      <h4>
        Downstream of {title}
        <span className="spacer" />
        <button className="trace-close" title="Close (Esc)" onClick={close}>×</button>
      </h4>
      {rows.length === 0 ? (
        <div className="muted">
          Opening this drops no load{d.buses.size ? '' : ': everything it feeds has another way to a source, or it is already open'}.
        </div>
      ) : (
        <>
          <table>
            <thead>
              <tr><th>Priority</th><th className="num">Loads</th><th className="num">kW</th><th className="num">Customers</th></tr>
            </thead>
            <tbody>
              {PRIORITIES.filter((p) => byPriority[p].count).map((p) => (
                <tr key={p}>
                  <td><span className="prio-dot" style={{ background: PRIORITY_COLORS[p] }} />{PRIORITY_LABELS[p]}</td>
                  <td className="num">{byPriority[p].count}</td>
                  <td className="num">{fmtKw(byPriority[p].kw)}</td>
                  <td className="num">{byPriority[p].numcust}</td>
                </tr>
              ))}
              <tr><td><strong>Total</strong></td><td className="num">{rows.length}</td><td className="num"><strong>{fmtKw(totalKw)}</strong></td><td className="num">{rows.reduce((s, r) => s + r.numcust, 0)}</td></tr>
            </tbody>
          </table>
          {PRIORITIES.filter((p) => byPriority[p].count).map((p) => (
            <div key={p}>
              <div className="trace-group"><span className="prio-dot" style={{ background: PRIORITY_COLORS[p] }} />{PRIORITY_LABELS[p]}</div>
              <table>
                <tbody>
                  {rows.filter((r) => r.priority === p).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button className="trace-load" onClick={() => selectOnly('node', r.id)} title="Select on the drawing">
                          {r.name}
                        </button>
                        {r.building && <span className="muted"> · {r.building}</span>}
                        {!r.inService && <span className="muted"> (out of service)</span>}
                      </td>
                      <td className="num">{fmtKw(r.kw)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
