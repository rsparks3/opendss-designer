import { useState } from 'react'
import {
  FIELDS,
  FieldInput,
  TRANSFORMER_WINDING_FIELDS,
  windingGet,
  windingPatch,
  type Field,
} from '../lib/fields'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { Params } from '../types/circuit'

type MainTab = 'problems' | 'elements'

const TYPE_TABS: { key: string; label: string }[] = [
  { key: 'vsource', label: 'Sources' },
  { key: 'busbar', label: 'Busbars' },
  { key: 'transformer', label: 'Transformers' },
  { key: 'line', label: 'Lines' },
  { key: 'breaker', label: 'Breakers' },
  { key: 'load', label: 'Loads' },
  { key: 'buses', label: 'Buses (results)' },
]

function StatusLine() {
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
  if (!result) return null
  return (
    <span className="status-line" style={{ opacity: stale ? 0.5 : 1 }}>
      {result.converged
        ? `✓ Converged in ${result.iterations} iteration${result.iterations === 1 ? '' : 's'}` +
          (result.losses ? ` — losses ${result.losses.kw.toFixed(1)} kW` : '') +
          (stale ? ' (stale — re-solve)' : '')
        : '✗ Not converged'}
    </span>
  )
}

function ProblemsTab() {
  const issues = useResultsStore((s) => s.issues)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  if (!issues.length) return <div className="bp-empty">No problems — the circuit is ready to solve.</div>
  return (
    <ul className="problems-list">
      {issues.map((i, k) => (
        <li
          key={k}
          className={i.severity}
          onClick={() => {
            if (i.nodeId) selectOnly('node', i.nodeId)
            else if (i.edgeId) selectOnly('edge', i.edgeId)
          }}
          style={{ cursor: i.nodeId || i.edgeId ? 'pointer' : 'default' }}
        >
          {i.message}
        </li>
      ))}
    </ul>
  )
}

function ElementTable({ type }: { type: string }) {
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const updateNodeParams = useCircuitStore((s) => s.updateNodeParams)
  const updateEdgeParams = useCircuitStore((s) => s.updateEdgeParams)
  const selectOnly = useCircuitStore((s) => s.selectOnly)

  const isEdgeTable = type === 'line'
  const fields: Field[] =
    type === 'transformer'
      ? [...FIELDS.transformer, ...TRANSFORMER_WINDING_FIELDS]
      : FIELDS[type] ?? []

  const rows: { id: string; params: Params }[] = isEdgeTable
    ? edges.filter((e) => e.type === 'line').map((e) => ({ id: e.id, params: e.data?.params ?? {} }))
    : nodes.filter((n) => n.type === type).map((n) => ({ id: n.id, params: n.data.params }))

  if (!rows.length) return <div className="bp-empty">No {type} elements in the circuit yet.</div>

  const commit = (id: string, params: Params, key: string, value: unknown) => {
    const patch = type === 'transformer' ? windingPatch(params, key, value) : { [key]: value }
    if (isEdgeTable) updateEdgeParams(id, patch)
    else updateNodeParams(id, patch)
  }

  return (
    <table className="bp-table">
      <thead>
        <tr>
          <th />
          {fields.map((f) => (
            <th key={f.key}>
              {f.label}
              {f.unit ? ` (${f.unit})` : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <button
                className="bp-locate"
                title="Select on diagram"
                onClick={() => selectOnly(isEdgeTable ? 'edge' : 'node', row.id)}
              >
                ⌖
              </button>
            </td>
            {fields.map((f) => (
              <td key={f.key}>
                <FieldInput
                  field={f}
                  value={type === 'transformer' ? windingGet(row.params, f.key) : row.params[f.key]}
                  onCommit={(v) => commit(row.id, row.params, f.key, v)}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function BusesTable() {
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
  if (!result?.converged)
    return <div className="bp-empty">Solve the circuit to see bus results.</div>
  const rows = Object.entries(result.buses)
  return (
    <table className="bp-table" style={{ opacity: stale ? 0.5 : 1 }}>
      <thead>
        <tr>
          <th>Bus</th>
          <th>kV base (LN)</th>
          <th>V min (pu)</th>
          <th>V max (pu)</th>
          <th>Nodes</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, b]) => (
          <tr key={name}>
            <td className="bp-ro">{name}</td>
            <td className="bp-ro">{b.kvBase}</td>
            <td className="bp-ro">{b.vminPu?.toFixed(4) ?? '—'}</td>
            <td className="bp-ro">{b.vmaxPu?.toFixed(4) ?? '—'}</td>
            <td className="bp-ro">{b.nodes.join(', ')}</td>
            <td className={`bp-ro${b.violation ? ' error' : ''}`}>{b.violation ?? 'ok'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function BottomPanel() {
  const issues = useResultsStore((s) => s.issues)
  const [tab, setTab] = useState<MainTab>('problems')
  const [typeTab, setTypeTab] = useState('load')
  const [open, setOpen] = useState(true)

  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors

  return (
    <div className="bottom-panel">
      <div className="bp-header">
        <button
          className={`bp-tab${tab === 'problems' && open ? ' active' : ''}`}
          onClick={() => {
            setTab('problems')
            setOpen(tab !== 'problems' || !open)
          }}
        >
          Problems
          {errors > 0 && <span className="err-count"> {errors}</span>}
          {warnings > 0 && <span className="warn-count"> {warnings}</span>}
        </button>
        <button
          className={`bp-tab${tab === 'elements' && open ? ' active' : ''}`}
          onClick={() => {
            setTab('elements')
            setOpen(tab !== 'elements' || !open)
          }}
        >
          Elements
        </button>
        {tab === 'elements' && open && (
          <span className="bp-subtabs">
            {TYPE_TABS.map((t) => (
              <button
                key={t.key}
                className={`bp-subtab${typeTab === t.key ? ' active' : ''}`}
                onClick={() => setTypeTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </span>
        )}
        <span className="tb-spacer" />
        <StatusLine />
        <button className="bp-collapse" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▴'}
        </button>
      </div>
      {open && (
        <div className="bp-content">
          {tab === 'problems' ? (
            <ProblemsTab />
          ) : typeTab === 'buses' ? (
            <BusesTable />
          ) : (
            <ElementTable type={typeTab} />
          )}
        </div>
      )}
    </div>
  )
}
