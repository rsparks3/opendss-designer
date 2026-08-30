import { useEffect, useState } from 'react'
import { useCircuitStore } from '../store/circuitStore'
import type { Params, Winding } from '../types/circuit'

export interface Field {
  key: string
  label: string
  /** 'loadshape' renders a dropdown of the circuit's loadshape library. */
  kind: 'number' | 'text' | 'select' | 'checkbox' | 'loadshape'
  /** For kind 'loadshape': which shape category the dropdown offers.
   *  Default 'load'; 'any' lists both (storage dispatch). */
  shapeKind?: 'load' | 'irradiance' | 'any'
  options?: string[] | number[]
  unit?: string
}

export const FIELDS: Record<string, Field[]> = {
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
    { key: 'loadshape', label: 'Loadshape', kind: 'loadshape' },
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
  capacitor: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'kv', label: 'Rated kV', kind: 'number', unit: 'kV' },
    { key: 'kvar', label: 'Size', kind: 'number', unit: 'kvar' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
    { key: 'conn', label: 'Connection', kind: 'select', options: ['wye', 'delta'] },
    { key: 'numsteps', label: 'Steps', kind: 'number' },
  ],
  generator: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'kv', label: 'Rated kV', kind: 'number', unit: 'kV' },
    { key: 'kw', label: 'Output', kind: 'number', unit: 'kW' },
    { key: 'pf', label: 'Power factor', kind: 'number' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
    { key: 'conn', label: 'Connection', kind: 'select', options: ['wye', 'delta'] },
    { key: 'model', label: 'Mode', kind: 'select', options: [1, 3] }, // 1=const kW/pf, 3=PV (holds vpu)
    { key: 'vpu', label: 'V setpoint (PV mode)', kind: 'number', unit: 'pu' },
  ],
  pvsystem: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'kv', label: 'Rated kV', kind: 'number', unit: 'kV' },
    { key: 'kva', label: 'Inverter rating', kind: 'number', unit: 'kVA' },
    { key: 'pmpp', label: 'Panel Pmpp', kind: 'number', unit: 'kW' },
    { key: 'pf', label: 'Power factor', kind: 'number' },
    { key: 'irradiance', label: 'Irradiance', kind: 'number', unit: 'pu' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
    { key: 'conn', label: 'Connection', kind: 'select', options: ['wye', 'delta'] },
    { key: 'loadshape', label: 'Irradiance shape', kind: 'loadshape', shapeKind: 'irradiance' },
  ],
  storage: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'kv', label: 'Rated kV', kind: 'number', unit: 'kV' },
    { key: 'kwrated', label: 'Power rating', kind: 'number', unit: 'kW' },
    { key: 'kwhrated', label: 'Energy rating', kind: 'number', unit: 'kWh' },
    { key: 'soc', label: 'Initial charge', kind: 'number', unit: '%' },
    { key: 'reserve', label: 'Reserve', kind: 'number', unit: '%' },
    { key: 'effcharge', label: 'Charge eff.', kind: 'number', unit: '%' },
    { key: 'effdischarge', label: 'Discharge eff.', kind: 'number', unit: '%' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
    { key: 'conn', label: 'Connection', kind: 'select', options: ['wye', 'delta'] },
    // 'follow': the shape drives dispatch (+ = discharge, − = charge).
    // 'default': triggers compare against the circuit default loadshape.
    { key: 'dispatch', label: 'Dispatch mode', kind: 'select', options: ['follow', 'default'] },
    { key: 'loadshape', label: 'Dispatch shape', kind: 'loadshape', shapeKind: 'any' },
    { key: 'dischargetrigger', label: 'Discharge trigger', kind: 'number' },
    { key: 'chargetrigger', label: 'Charge trigger', kind: 'number' },
  ],
}

/** Flattened winding columns for the transformer spreadsheet view.
 *  Keys look like "w0.kv" and are resolved by windingGet/windingSet. */
export const TRANSFORMER_WINDING_FIELDS: Field[] = [0, 1].flatMap((i) => [
  { key: `w${i}.kv`, label: `W${i + 1} kV`, kind: 'number' as const },
  { key: `w${i}.kva`, label: `W${i + 1} kVA`, kind: 'number' as const },
  { key: `w${i}.conn`, label: `W${i + 1} conn`, kind: 'select' as const, options: ['wye', 'delta'] },
])

export function windingGet(params: Params, key: string): unknown {
  const m = key.match(/^w(\d+)\.(\w+)$/)
  if (!m) return params[key]
  const windings = (params.windings as Winding[]) ?? []
  return windings[Number(m[1])]?.[m[2] as keyof Winding]
}

export function windingPatch(params: Params, key: string, value: unknown): Params {
  const m = key.match(/^w(\d+)\.(\w+)$/)
  if (!m) return { [key]: value }
  const i = Number(m[1])
  const windings = ((params.windings as Winding[]) ?? []).map((w, j) =>
    j === i ? { ...w, [m[2]]: value } : w,
  )
  return { windings }
}

function LoadShapeSelect({
  value,
  shapeKind = 'load',
  onCommit,
}: {
  value: unknown
  shapeKind?: 'load' | 'irradiance' | 'any'
  onCommit: (v: unknown) => void
}) {
  const shapes = useCircuitStore((s) => s.loadShapes)
  const names = Object.keys(shapes).filter(
    (n) => shapeKind === 'any' || (shapes[n].kind ?? 'load') === shapeKind,
  )
  const current = String(value ?? '')
  return (
    <select value={current} onChange={(e) => onCommit(e.target.value)}>
      <option value="">(none)</option>
      {names.map((n) => (
        <option key={n} value={n}>
          {shapeKind === 'any' && (shapes[n].kind ?? 'load') === 'irradiance' ? `${n} (irr)` : n}
        </option>
      ))}
      {current && !names.includes(current) && (
        <option value={current}>
          {current} {shapes[current] ? `(${shapes[current].kind ?? 'load'} shape)` : '(missing)'}
        </option>
      )}
    </select>
  )
}

export function FieldInput({
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

  if (field.kind === 'loadshape') {
    return <LoadShapeSelect value={value} shapeKind={field.shapeKind} onCommit={onCommit} />
  }
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
