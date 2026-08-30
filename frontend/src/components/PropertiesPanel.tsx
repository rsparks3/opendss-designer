import { useEffect, useState } from 'react'
import { useCircuitStore, type AppEdge, type AppNode } from '../store/circuitStore'
import type { Params, Winding } from '../types/circuit'

interface Field {
  key: string
  label: string
  kind: 'number' | 'text' | 'select' | 'checkbox'
  options?: string[] | number[]
  unit?: string
}

const FIELDS: Record<string, Field[]> = {
  vsource: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'basekv', label: 'Base kV (LL)', kind: 'number', unit: 'kV' },
    { key: 'pu', label: 'Voltage', kind: 'number', unit: 'pu' },
    { key: 'angle', label: 'Angle', kind: 'number', unit: '°' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
    { key: 'mvasc3', label: '3φ short-circuit', kind: 'number', unit: 'MVA' },
    { key: 'mvasc1', label: '1φ short-circuit', kind: 'number', unit: 'MVA' },
  ],
  busbar: [
    { key: 'name', label: 'Bus name', kind: 'text' },
    { key: 'basekv', label: 'Base kV (LL)', kind: 'number', unit: 'kV' },
  ],
  load: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'kv', label: 'Rated kV', kind: 'number', unit: 'kV' },
    { key: 'kw', label: 'Power', kind: 'number', unit: 'kW' },
    { key: 'pf', label: 'Power factor', kind: 'number' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
    { key: 'conn', label: 'Connection', kind: 'select', options: ['wye', 'delta'] },
    { key: 'model', label: 'Load model', kind: 'select', options: [1, 2, 3, 4, 5] },
  ],
  breaker: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'closed', label: 'Closed', kind: 'checkbox' },
    { key: 'normamps', label: 'Rating', kind: 'number', unit: 'A' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
  ],
  line: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'length', label: 'Length', kind: 'number' },
    { key: 'units', label: 'Units', kind: 'select', options: ['km', 'm', 'mi', 'kft', 'ft'] },
    { key: 'r1', label: 'R1', kind: 'number', unit: 'Ω/unit' },
    { key: 'x1', label: 'X1', kind: 'number', unit: 'Ω/unit' },
    { key: 'r0', label: 'R0', kind: 'number', unit: 'Ω/unit' },
    { key: 'x0', label: 'X0', kind: 'number', unit: 'Ω/unit' },
    { key: 'normamps', label: 'Rating', kind: 'number', unit: 'A' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
  ],
  transformer: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 3] },
    { key: 'xhl', label: 'Reactance X(H-L)', kind: 'number', unit: '%' },
    { key: 'pctloadloss', label: 'Load loss', kind: 'number', unit: '%' },
  ],
}

function FieldInput({
  field,
  value,
  onCommit,
}: {
  field: Field
  value: unknown
  onCommit: (v: unknown) => void
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => setDraft(value == null ? '' : String(value)), [value])

  if (field.kind === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={value !== false}
        onChange={(e) => onCommit(e.target.checked)}
      />
    )
  }
  if (field.kind === 'select') {
    return (
      <select
        value={String(value ?? '')}
        onChange={(e) => {
          const opt = field.options?.find((o) => String(o) === e.target.value)
          onCommit(opt ?? e.target.value)
        }}
      >
        {field.options?.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    )
  }
  const commit = () => {
    if (field.kind === 'number') {
      const n = parseFloat(draft)
      onCommit(Number.isFinite(n) ? n : value)
    } else {
      onCommit(draft)
    }
  }
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function WindingEditor({
  windings,
  onChange,
}: {
  windings: Winding[]
  onChange: (w: Winding[]) => void
}) {
  const patch = (i: number, p: Partial<Winding>) =>
    onChange(windings.map((w, j) => (j === i ? { ...w, ...p } : w)))
  return (
    <>
      {windings.map((w, i) => (
        <fieldset key={i} className="winding">
          <legend>{i === 0 ? 'Primary (t1)' : 'Secondary (t2)'}</legend>
          <label>
            kV (LL)
            <FieldInput
              field={{ key: 'kv', label: '', kind: 'number' }}
              value={w.kv}
              onCommit={(v) => patch(i, { kv: v as number })}
            />
          </label>
          <label>
            kVA
            <FieldInput
              field={{ key: 'kva', label: '', kind: 'number' }}
              value={w.kva}
              onCommit={(v) => patch(i, { kva: v as number })}
            />
          </label>
          <label>
            Conn
            <select value={w.conn} onChange={(e) => patch(i, { conn: e.target.value as Winding['conn'] })}>
              <option value="wye">wye</option>
              <option value="delta">delta</option>
            </select>
          </label>
        </fieldset>
      ))}
    </>
  )
}

export function PropertiesPanel() {
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const updateNodeParams = useCircuitStore((s) => s.updateNodeParams)
  const updateEdgeParams = useCircuitStore((s) => s.updateEdgeParams)

  const selNode: AppNode | undefined = nodes.find((n) => n.selected)
  const selEdge: AppEdge | undefined = selNode ? undefined : edges.find((e) => e.selected)

  let kind: string | null = null
  let params: Params | null = null
  let commit: ((patch: Params) => void) | null = null
  if (selNode) {
    kind = selNode.type ?? null
    params = selNode.data.params
    commit = (patch) => updateNodeParams(selNode.id, patch)
  } else if (selEdge && selEdge.type === 'line') {
    kind = 'line'
    params = selEdge.data?.params ?? {}
    commit = (patch) => updateEdgeParams(selEdge.id, patch)
  }

  if (!kind || !params || !commit) {
    return (
      <div className="properties">
        <div className="palette-title">Properties</div>
        <div className="props-empty">
          Select an element to edit its OpenDSS parameters.
          <br />
          <br />
          Plain wires have no parameters — they merge terminals into one bus.
        </div>
      </div>
    )
  }

  const fields = FIELDS[kind] ?? []
  const title = kind === 'line' ? 'Line' : kind.charAt(0).toUpperCase() + kind.slice(1)
  return (
    <div className="properties">
      <div className="palette-title">{title}</div>
      <div className="props-form">
        {fields.map((f) => (
          <label key={f.key} className="prop-row">
            <span>
              {f.label}
              {f.unit ? ` (${f.unit})` : ''}
            </span>
            <FieldInput field={f} value={params![f.key]} onCommit={(v) => commit!({ [f.key]: v })} />
          </label>
        ))}
        {kind === 'transformer' && (
          <WindingEditor
            windings={(params.windings as Winding[]) ?? []}
            onChange={(w) => commit!({ windings: w })}
          />
        )}
      </div>
    </div>
  )
}
