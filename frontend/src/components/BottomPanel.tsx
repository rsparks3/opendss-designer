import { useRef, useState } from 'react'
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
import { GraphPanel } from './GraphPanel'

type MainTab = 'problems' | 'elements' | 'losses' | 'graph'

const TYPE_TABS: { key: string; label: string }[] = [
  { key: 'vsource', label: 'Sources' },
  { key: 'busbar', label: 'Busbars' },
  { key: 'transformer', label: 'Transformers' },
  { key: 'line', label: 'Lines' },
  { key: 'breaker', label: 'Breakers' },
  { key: 'load', label: 'Loads' },
  { key: 'capacitor', label: 'Capacitors' },
  { key: 'generator', label: 'Generators' },
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

  // Excel-style fill handle: the focused cell shows a corner dot; dragging it
  // over other rows copies the value down (or up) through them.
  const [active, setActive] = useState<{ row: number; key: string } | null>(null)
  const [fillTo, setFillTo] = useState<number | null>(null)
  const fillToRef = useRef<number | null>(null)

  const isEdgeTable = type === 'line'
  const fields: Field[] =
    type === 'transformer'
      ? [...FIELDS.transformer, ...TRANSFORMER_WINDING_FIELDS]
      : FIELDS[type] ?? []

  const rows: { id: string; params: Params }[] = isEdgeTable
    ? edges.filter((e) => e.type === 'line').map((e) => ({ id: e.id, params: e.data?.params ?? {} }))
    : nodes.filter((n) => n.type === type).map((n) => ({ id: n.id, params: n.data.params }))

  if (!rows.length) return <div className="bp-empty">No {type} elements in the circuit yet.</div>

  const cellValue = (row: { params: Params }, key: string) =>
    type === 'transformer' ? windingGet(row.params, key) : row.params[key]

  const commit = (id: string, params: Params, key: string, value: unknown) => {
    const patch = type === 'transformer' ? windingPatch(params, key, value) : { [key]: value }
    if (isEdgeTable) updateEdgeParams(id, patch)
    else updateNodeParams(id, patch)
  }

  const startFill = (e: React.PointerEvent) => {
    if (!active) return
    e.preventDefault()
    e.stopPropagation()
    const { row: startRow, key } = active
    const value = cellValue(rows[startRow], key)
    const move = (ev: PointerEvent) => {
      const hit = document
        .elementsFromPoint(ev.clientX, ev.clientY)
        .find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.rowIdx != null)
      if (hit) {
        const idx = Number(hit.dataset.rowIdx)
        fillToRef.current = idx
        setFillTo(idx)
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const end = fillToRef.current
      if (end != null && end !== startRow) {
        const [lo, hi] = [Math.min(startRow, end), Math.max(startRow, end)]
        for (let i = lo; i <= hi; i++) {
          if (i !== startRow) commit(rows[i].id, rows[i].params, key, value)
        }
      }
      fillToRef.current = null
      setFillTo(null)
    }
    fillToRef.current = startRow
    setFillTo(startRow)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const inFillRange = (idx: number) =>
    active != null &&
    fillTo != null &&
    idx >= Math.min(active.row, fillTo) &&
    idx <= Math.max(active.row, fillTo)

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
        {rows.map((row, rowIdx) => (
          <tr key={row.id} data-row-idx={rowIdx} className={inFillRange(rowIdx) ? 'fill-range' : ''}>
            <td data-row-idx={rowIdx}>
              <button
                className="bp-locate"
                title="Select on diagram"
                onClick={() => selectOnly(isEdgeTable ? 'edge' : 'node', row.id)}
              >
                ⌖
              </button>
            </td>
            {fields.map((f) => (
              <td
                key={f.key}
                data-row-idx={rowIdx}
                className="bp-cell"
                onFocusCapture={() => setActive({ row: rowIdx, key: f.key })}
              >
                <FieldInput
                  field={f}
                  value={cellValue(row, f.key)}
                  onCommit={(v) => commit(row.id, row.params, f.key, v)}
                />
                {active?.row === rowIdx && active.key === f.key && f.key !== 'name' && (
                  <div
                    className="fill-handle"
                    title="Drag to fill this value through other rows"
                    onPointerDown={startFill}
                  />
                )}
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

function LossesTab() {
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  if (!result?.converged)
    return <div className="bp-empty">Solve the circuit to see the losses breakdown.</div>
  const rows = Object.entries(result.elements)
    .filter(([, e]) => e.lossKw != null)
    .sort(([, a], [, b]) => (b.lossKw ?? 0) - (a.lossKw ?? 0))
  const total = result.losses
  if (!rows.length) return <div className="bp-empty">No series elements with losses.</div>
  return (
    <table className="bp-table" style={{ opacity: stale ? 0.5 : 1 }}>
      <thead>
        <tr>
          <th />
          <th>Element</th>
          <th>Loss (kW)</th>
          <th>Loss (kvar)</th>
          <th>% of total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, e]) => (
          <tr key={name}>
            <td>
              <button
                className="bp-locate"
                title="Select on diagram"
                onClick={() => {
                  const isEdge = useCircuitStore.getState().edges.some((ed) => ed.id === e.id)
                  selectOnly(isEdge ? 'edge' : 'node', e.id)
                }}
              >
                ⌖
              </button>
            </td>
            <td className="bp-ro">{name}</td>
            <td className="bp-ro">{e.lossKw!.toFixed(3)}</td>
            <td className="bp-ro">{e.lossKvar!.toFixed(3)}</td>
            <td className="bp-ro">
              {total && total.kw ? `${((e.lossKw! / total.kw) * 100).toFixed(1)}%` : '—'}
            </td>
          </tr>
        ))}
        {total && (
          <tr className="bp-total">
            <td />
            <td className="bp-ro">Total</td>
            <td className="bp-ro">{total.kw.toFixed(3)}</td>
            <td className="bp-ro">{total.kvar.toFixed(3)}</td>
            <td className="bp-ro">100%</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

const HEIGHT_KEY = 'opendss-designer.bpHeight'
const DEFAULT_HEIGHT = 210
const MIN_HEIGHT = 100

function initialHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY))
    if (v >= MIN_HEIGHT && v <= 900) return v
  } catch {
    // storage unavailable
  }
  return DEFAULT_HEIGHT
}

export function BottomPanel() {
  const issues = useResultsStore((s) => s.issues)
  const [tab, setTab] = useState<MainTab>('problems')
  const [typeTab, setTypeTab] = useState('load')
  const [open, setOpen] = useState(true)
  const [height, setHeight] = useState(initialHeight)
  const heightRef = useRef(height)

  // Drag the top edge to resize; height persists across sessions.
  const startResize = (down: React.PointerEvent) => {
    down.preventDefault()
    const startY = down.clientY
    const startH = heightRef.current
    const move = (e: PointerEvent) => {
      const h = Math.min(
        Math.max(startH + (startY - e.clientY), MIN_HEIGHT),
        Math.max(200, window.innerHeight - 260),
      )
      heightRef.current = h
      setHeight(h)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(HEIGHT_KEY, String(heightRef.current))
      } catch {
        // storage unavailable — resize still works for this session
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors

  return (
    <div className="bottom-panel">
      {open && (
        <div className="bp-resizer" onPointerDown={startResize}
             title="Drag to resize the panel" />
      )}
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
        <button
          className={`bp-tab${tab === 'losses' && open ? ' active' : ''}`}
          onClick={() => {
            setTab('losses')
            setOpen(tab !== 'losses' || !open)
          }}
        >
          Losses
        </button>
        <button
          className={`bp-tab${tab === 'graph' && open ? ' active' : ''}`}
          onClick={() => {
            setTab('graph')
            setOpen(tab !== 'graph' || !open)
          }}
        >
          Graph
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
        <div className="bp-content" style={{ height, maxHeight: 'none' }}>
          {tab === 'problems' ? (
            <ProblemsTab />
          ) : tab === 'losses' ? (
            <LossesTab />
          ) : tab === 'graph' ? (
            <GraphPanel />
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
