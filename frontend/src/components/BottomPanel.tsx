import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  FIELDS,
  FieldInput,
  TRANSFORMER_WINDING_FIELDS,
  windingGet,
  windingPatch,
  type Field,
} from '../lib/fields'
import { crsUnits } from '../lib/gis/build'
import { matchesFilter } from '../lib/selection'
import { useCircuitStore } from '../store/circuitStore'
import { useUiStore } from '../store/uiStore'
import { useResultsStore } from '../store/resultsStore'
import type { GeoPoint, Params } from '../types/circuit'
import { GraphPanel } from './GraphPanel'
import { CurvesPanel } from './CurvesPanel'
import { LineCodesPanel } from './LineCodesPanel'
import { PassthroughPanel } from './PassthroughPanel'
import { ReliabilityPanel } from './ReliabilityPanel'
import { ShapesPanel } from './ShapesPanel'

type MainTab =
  | 'problems'
  | 'elements'
  | 'losses'
  | 'reliability'
  | 'graph'
  | 'shapes'
  | 'curves'
  | 'linecodes'
  | 'passthrough'

const TYPE_TABS: { key: string; label: string }[] = [
  { key: 'vsource', label: 'Sources' },
  { key: 'busbar', label: 'Busbars' },
  { key: 'transformer', label: 'Transformers' },
  { key: 'regulator', label: 'Regulators' },
  { key: 'line', label: 'Lines' },
  { key: 'breaker', label: 'Breakers' },
  { key: 'fuse', label: 'Fuses' },
  { key: 'recloser', label: 'Reclosers' },
  { key: 'relay', label: 'Relays' },
  { key: 'load', label: 'Loads' },
  { key: 'capacitor', label: 'Capacitors' },
  { key: 'generator', label: 'Generators' },
  { key: 'pvsystem', label: 'PV systems' },
  { key: 'storage', label: 'Storage' },
  { key: 'buses', label: 'Buses (results)' },
]

function StatusLine() {
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
  // When shapes are assigned, say what the snapshot actually solved — it is
  // the unscaled base case, not any hour of the time series.
  const hasShapes = useCircuitStore((s) => s.nodes.some((n) => !!n.data.params.loadshape))
  if (!result) return null
  return (
    <span
      className="status-line"
      style={{ opacity: stale ? 0.5 : 1 }}
      title={
        hasShapes
          ? 'Snapshot solves the unscaled base case: loads at rated kW, PV at ' +
            'its irradiance parameter, storage idle. Loadshapes only apply to ' +
            'time-series runs (▶ Run).'
          : undefined
      }
    >
      {result.converged
        ? `✓ Converged in ${result.iterations} iteration${result.iterations === 1 ? '' : 's'}` +
          (result.losses ? ` — losses ${result.losses.kw.toFixed(1)} kW` : '') +
          (hasShapes ? ' · base case (shapes not applied)' : '') +
          (stale ? ' (stale — re-solve)' : '')
        : '✗ Not converged'}
    </span>
  )
}

function ProblemsTab() {
  const issues = [
    ...useResultsStore((s) => s.issues),
    ...useResultsStore((s) => s.protectionIssues),
  ]
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

/** Where an element is on the ground, as two columns at the end of the
 *  table: longitude/latitude when the circuit's system is geographic, X/Y
 *  in its units otherwise (or bare numbers on a plain grid). */
function geoFields(crs: string | null): Field[] {
  if (crs && crsUnits(crs) === 'deg') {
    return [
      { key: 'geo.x', label: 'Longitude', kind: 'text', unit: '°' },
      { key: 'geo.y', label: 'Latitude', kind: 'text', unit: '°' },
    ]
  }
  const unit = crs ? crsUnits(crs) : undefined
  return [
    { key: 'geo.x', label: 'X', kind: 'text', unit },
    { key: 'geo.y', label: 'Y', kind: 'text', unit },
  ]
}

const GEO_TITLE =
  'Coordinates on the ground (BusCoords, or where a GIS layer put it), in the ' +
  "project's coordinate system. Blank: placed on the map from its neighbours. " +
  'Clear either cell to remove the coordinate; filter with x= to find elements without one.'

type Row = { id: string; params: Params; selected: boolean; geo?: GeoPoint }

function ElementTable({ type }: { type: string }) {
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const crs = useCircuitStore((s) => s.crs)
  const updateNodeParams = useCircuitStore((s) => s.updateNodeParams)
  const updateEdgeParams = useCircuitStore((s) => s.updateEdgeParams)
  const setGeo = useCircuitStore((s) => s.setGeo)
  const selectOnly = useCircuitStore((s) => s.selectOnly)
  const selectMany = useCircuitStore((s) => s.selectMany)

  // Excel-style fill handle: the focused cell shows a corner dot; dragging it
  // over other rows copies the value down (or up) through them.
  const [active, setActive] = useState<{ row: number; key: string } | null>(null)
  const [fillTo, setFillTo] = useState<number | null>(null)
  const fillToRef = useRef<number | null>(null)

  // A coordinate typed into an element that has none waits here for the
  // other half; a point needs both.
  const [pendingGeo, setPendingGeo] = useState<Record<string, Partial<GeoPoint>>>({})

  const isEdgeTable = type === 'line'
  // Coordinate columns only once the circuit has a place on the ground, so a
  // hand-drawn one-line is not given two empty columns on every tab. Lines
  // have a route, not a point, and are left out.
  const showGeo = !isEdgeTable && (!!crs || nodes.some((n) => !!n.data.geo))
  const fields: Field[] = [
    ...(type === 'transformer'
      ? [...FIELDS.transformer, ...TRANSFORMER_WINDING_FIELDS]
      : FIELDS[type] ?? []),
    ...(showGeo ? geoFields(crs) : []),
  ]

  // A filter narrows the rows; "Select matching" turns the rows into a
  // canvas selection, which the properties panel then edits in bulk.
  const [filter, setFilter] = useState('')
  const allRows: Row[] = isEdgeTable
    ? edges.filter((e) => e.type === 'line').map((e) => ({ id: e.id, params: e.data?.params ?? {}, selected: !!e.selected }))
    : nodes.filter((n) => n.type === type).map((n) => ({ id: n.id, params: n.data.params, selected: !!n.selected, geo: n.data.geo }))
  // The filter sees the coordinates as x and y alongside the parameters.
  const filterable = (r: Row): Params => (showGeo ? { ...r.params, x: r.geo?.x, y: r.geo?.y } : r.params)
  const rows = filter.trim() ? allRows.filter((r) => matchesFilter(filterable(r), filter)) : allRows

  if (!allRows.length) return <div className="bp-empty">No {type} elements in the circuit yet.</div>

  const cellValue = (row: Row, key: string) => {
    if (key === 'geo.x' || key === 'geo.y') {
      const axis = key === 'geo.x' ? 'x' : 'y'
      return row.geo ? row.geo[axis] : pendingGeo[row.id]?.[axis]
    }
    return type === 'transformer' ? windingGet(row.params, key) : row.params[key]
  }

  const commitGeo = (row: Row, axis: 'x' | 'y', value: unknown) => {
    const text = String(value ?? '').trim()
    if (!text) {
      if (row.geo) setGeo({ [row.id]: null })
      setPendingGeo(({ [row.id]: _gone, ...rest }) => rest)
      return
    }
    const v = Number(text)
    if (!Number.isFinite(v) || row.geo?.[axis] === v) return
    const point = { ...(row.geo ?? pendingGeo[row.id]), [axis]: v }
    if (point.x == null || point.y == null) {
      setPendingGeo((p) => ({ ...p, [row.id]: point }))
      return
    }
    setGeo({ [row.id]: { x: point.x, y: point.y } })
    setPendingGeo(({ [row.id]: _gone, ...rest }) => rest)
  }

  const commit = (row: Row, key: string, value: unknown) => {
    if (key === 'geo.x' || key === 'geo.y') return commitGeo(row, key === 'geo.x' ? 'x' : 'y', value)
    const patch = type === 'transformer' ? windingPatch(row.params, key, value) : { [key]: value }
    if (isEdgeTable) updateEdgeParams(row.id, patch)
    else updateNodeParams(row.id, patch)
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
          if (i !== startRow) commit(rows[i], key, value)
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

  const selectMatching = () =>
    selectMany(isEdgeTable
      ? { nodeIds: [], edgeIds: rows.map((r) => r.id) }
      : { nodeIds: rows.map((r) => r.id), edgeIds: [] })
  const selectedCount = allRows.filter((r) => r.selected).length

  // The handlers above close over this render's state; the rows get stable
  // wrappers so a memoised row only redraws when its own values change.
  const latest = useRef({ cellValue, commit, startFill, setActive })
  latest.current = { cellValue, commit, startFill, setActive }
  const handlers = useMemo<RowHandlers>(
    () => ({
      cellValue: (row, key) => latest.current.cellValue(row, key),
      commit: (row, key, v) => latest.current.commit(row, key, v),
      startFill: (e) => latest.current.startFill(e),
      setActive: (row, key) => latest.current.setActive({ row, key }),
      locate: (row) => selectOnly(isEdgeTable ? 'edge' : 'node', row.id),
    }),
    [selectOnly, isEdgeTable],
  )

  return (
    <div className="bp-elements">
    <div className="bp-filter">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter: name, kw>100, kv=4.16, loadshape:day, phasing=B …"
        title="Space-separated terms, all must hold. A bare word matches the name; key>value, key<value, key=value, key!=value compare a parameter; key:text means contains."
        spellCheck={false}
      />
      <button
        className="bp-select-matching"
        onClick={selectMatching}
        disabled={!rows.length}
        title="Select these elements on the diagram; the properties panel then edits them all at once"
      >
        Select {filter.trim() ? `${rows.length} matching` : 'all'}
      </button>
      <span className="bp-count">
        {filter.trim() ? `${rows.length} of ${allRows.length}` : `${allRows.length}`}
        {selectedCount ? ` · ${selectedCount} selected` : ''}
      </span>
    </div>
    {!rows.length ? (
      <div className="bp-empty">Nothing matches that filter.</div>
    ) : (
      <VirtualTable
        rows={rows}
        fields={fields}
        active={active}
        fillTo={fillTo}
        pendingGeo={pendingGeo}
        handlers={handlers}
      />
    )}
    </div>
  )
}

interface RowHandlers {
  cellValue: (row: Row, key: string) => unknown
  commit: (row: Row, key: string, value: unknown) => void
  startFill: (e: React.PointerEvent) => void
  setActive: (row: number, key: string) => void
  locate: (row: Row) => void
}

/** Every row is this tall, so the table knows where any row is without
 *  drawing it. The inputs are 22px; the rest is padding. */
const ROW_H = 26
/** Rows drawn beyond each edge of the view, so a scroll has something to
 *  show before the next render lands. */
const OVERSCAN = 8

/**
 * The element table, drawing only the rows that are in view. A real feeder
 * has a thousand loads and more, and a table of a thousand rows of live
 * inputs took a second to open and made every drag on the canvas stutter,
 * since the table re-renders on every change to the circuit. Two spacer
 * rows hold the scroll height; the rows between them are the window.
 */
function VirtualTable({
  rows,
  fields,
  active,
  fillTo,
  pendingGeo,
  handlers,
}: {
  rows: Row[]
  fields: Field[]
  active: { row: number; key: string } | null
  fillTo: number | null
  pendingGeo: Record<string, Partial<GeoPoint>>
  handlers: RowHandlers
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(400)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    setViewH(el.clientHeight)
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const lo = active != null && fillTo != null ? Math.min(active.row, fillTo) : -1
  const hi = active != null && fillTo != null ? Math.max(active.row, fillTo) : -1
  const window: React.ReactNode[] = []
  for (let i = start; i < end; i++) {
    const row = rows[i]
    window.push(
      <TableRow
        key={row.id}
        row={row}
        rowIdx={i}
        fields={fields}
        activeKey={active?.row === i ? active.key : null}
        inFill={i >= lo && i <= hi}
        pending={pendingGeo[row.id]}
        handlers={handlers}
      />,
    )
  }
  return (
    <div
      className="bp-table-scroll"
      ref={scroller}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      <table className="bp-table bp-table-virtual">
        <thead>
          <tr>
            <th />
            {fields.map((f) => (
              <th key={f.key} title={f.key.startsWith('geo.') ? GEO_TITLE : undefined}>
                {f.label}
                {f.unit ? ` (${f.unit})` : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr className="bp-spacer" aria-hidden="true">
              <td colSpan={fields.length + 1} style={{ height: start * ROW_H }} />
            </tr>
          )}
          {window}
          {end < rows.length && (
            <tr className="bp-spacer" aria-hidden="true">
              <td colSpan={fields.length + 1} style={{ height: (rows.length - end) * ROW_H }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const TableRow = memo(function TableRow({
  row,
  rowIdx,
  fields,
  activeKey,
  inFill,
  handlers,
}: {
  row: Row
  rowIdx: number
  fields: Field[]
  activeKey: string | null
  inFill: boolean
  /** The half-typed coordinate, so the row redraws when it changes. */
  pending: Partial<GeoPoint> | undefined
  handlers: RowHandlers
}) {
  return (
    <tr
      data-row-idx={rowIdx}
      className={`${inFill ? 'fill-range' : ''}${row.selected ? ' selected' : ''}`}
      style={{ height: ROW_H }}
    >
      <td data-row-idx={rowIdx}>
        <button className="bp-locate" title="Select on diagram" onClick={() => handlers.locate(row)}>
          ⌖
        </button>
      </td>
      {fields.map((f) => (
        <td
          key={f.key}
          data-row-idx={rowIdx}
          className="bp-cell"
          onFocusCapture={() => handlers.setActive(rowIdx, f.key)}
        >
          <FieldInput
            field={f}
            value={handlers.cellValue(row, f.key)}
            onCommit={(v) => handlers.commit(row, f.key, v)}
          />
          {activeKey === f.key && f.key !== 'name' && (
            <div
              className="fill-handle"
              title="Drag to fill this value through other rows"
              onPointerDown={handlers.startFill}
            />
          )}
        </td>
      ))}
    </tr>
  )
})

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
  // Protection findings count towards the tab's badge like anything else.
  const issues = [
    ...useResultsStore((s) => s.issues),
    ...useResultsStore((s) => s.protectionIssues),
  ]
  const graphTabSignal = useResultsStore((s) => s.graphTabSignal)
  const passthroughCount = useCircuitStore((s) => s.passthrough.length)
  const [tab, setTab] = useState<MainTab>('problems')
  const [typeTab, setTypeTab] = useState('load')
  // Open/closed lives in the UI store so View → Bottom panel can drive it.
  const open = useUiStore((st) => st.panelOpen.bottom)
  const setOpen = (v: boolean) => useUiStore.getState().setPanelOpen('bottom', v)
  const [height, setHeight] = useState(initialHeight)
  const heightRef = useRef(height)

  // A completed time-series run asks for the Graph tab.
  useEffect(() => {
    if (graphTabSignal > 0) {
      setTab('graph')
      setOpen(true)
    }
  }, [graphTabSignal])

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
          className={`bp-tab${tab === 'reliability' && open ? ' active' : ''}`}
          title="SAIFI, SAIDI and CAIDI, and the protection sections behind them"
          onClick={() => {
            setTab('reliability')
            setOpen(tab !== 'reliability' || !open)
          }}
        >
          Reliability
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
        <button
          className={`bp-tab${tab === 'shapes' && open ? ' active' : ''}`}
          onClick={() => {
            setTab('shapes')
            setOpen(tab !== 'shapes' || !open)
          }}
        >
          Shapes
        </button>
        <button
          className={`bp-tab${tab === 'curves' && open ? ' active' : ''}`}
          title="Time-current curves this circuit defines, for its protective devices"
          onClick={() => {
            setTab('curves')
            setOpen(tab !== 'curves' || !open)
          }}
        >
          Curves
        </button>
        <button
          className={`bp-tab${tab === 'linecodes' && open ? ' active' : ''}`}
          title="Conductor definitions (line codes) this circuit defines, for its lines"
          onClick={() => {
            setTab('linecodes')
            setOpen(tab !== 'linecodes' || !open)
          }}
        >
          Line codes
        </button>
        {(passthroughCount > 0 || tab === 'passthrough') && (
          <button
            className={`bp-tab${tab === 'passthrough' && open ? ' active' : ''}`}
            title="Elements an imported .dss file defined that the drawing does not show"
            onClick={() => {
              setTab('passthrough')
              setOpen(tab !== 'passthrough' || !open)
            }}
          >
            Passthrough <span className="pt-count">{passthroughCount}</span>
          </button>
        )}
        {tab === 'elements' && open && (
          <select
            className="bp-select"
            aria-label="Element type"
            title="Which element type the table lists"
            value={typeTab}
            onChange={(e) => setTypeTab(e.target.value)}
          >
            {TYPE_TABS.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
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
          ) : tab === 'reliability' ? (
            <ReliabilityPanel />
          ) : tab === 'graph' ? (
            <GraphPanel />
          ) : tab === 'shapes' ? (
            <ShapesPanel />
          ) : tab === 'curves' ? (
            <CurvesPanel />
          ) : tab === 'linecodes' ? (
            <LineCodesPanel />
          ) : tab === 'passthrough' ? (
            <PassthroughPanel />
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
