import { useEffect, useState } from 'react'
import { useCircuitStore } from '../store/circuitStore'
import type { Params, Winding } from '../types/circuit'

export interface Field {
  key: string
  label: string
  /** 'loadshape' renders a dropdown of the circuit's loadshape library;
   *  'curve' one of the engine's time-current curves plus the circuit's own. */
  kind: 'number' | 'text' | 'select' | 'checkbox' | 'loadshape' | 'curve'
  /** For kind 'loadshape': which shape category the dropdown offers.
   *  Default 'load'; 'any' lists both (storage dispatch). */
  shapeKind?: 'load' | 'irradiance' | 'any'
  options?: string[] | number[]
  unit?: string
  /** For kind 'curve': which of the engine's curves suit this device, and
   *  whether "none" (no unit at all) is a real answer. */
  curveKind?: 'fuse' | 'recloser' | 'relay'
  allowNone?: boolean
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
    { key: 'interruptingka', label: 'Interrupting rating', kind: 'number', unit: 'kA' },
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
  regulator: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 3] },
    { key: 'kv', label: 'Rated kV', kind: 'number', unit: 'kV' },
    { key: 'kva', label: 'Rating', kind: 'number', unit: 'kVA' },
    { key: 'vreg', label: 'Voltage setpoint', kind: 'number', unit: 'V (120 base)' },
    { key: 'band', label: 'Bandwidth', kind: 'number', unit: 'V' },
    { key: 'ptratio', label: 'PT ratio', kind: 'number' },
    { key: 'ctprim', label: 'CT primary', kind: 'number', unit: 'A' },
    { key: 'r', label: 'Line drop comp R', kind: 'number', unit: 'V' },
    { key: 'x', label: 'Line drop comp X', kind: 'number', unit: 'V' },
    { key: 'maxtapchange', label: 'Max tap change / solution', kind: 'number' },
  ],
  fuse: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'closed', label: 'Intact', kind: 'checkbox' },
    { key: 'ratedcurrent', label: 'Rated current', kind: 'number', unit: 'A' },
    { key: 'fusecurve', label: 'Fuse link', kind: 'curve', curveKind: 'fuse' },
    { key: 'delay', label: 'Added delay', kind: 'number', unit: 's' },
    { key: 'normamps', label: 'Continuous rating', kind: 'number', unit: 'A' },
    { key: 'interruptingka', label: 'Interrupting rating', kind: 'number', unit: 'kA' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
  ],
  recloser: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'closed', label: 'Closed', kind: 'checkbox' },
    { key: 'phasetrip', label: 'Phase pickup', kind: 'number', unit: 'A' },
    { key: 'groundtrip', label: 'Ground pickup', kind: 'number', unit: 'A' },
    { key: 'phasefast', label: 'Fast curve', kind: 'curve', curveKind: 'recloser' },
    { key: 'phasedelayed', label: 'Delayed curve', kind: 'curve', curveKind: 'recloser' },
    { key: 'groundfast', label: 'Ground fast curve', kind: 'curve', curveKind: 'recloser', allowNone: true },
    { key: 'grounddelayed', label: 'Ground delayed curve', kind: 'curve', curveKind: 'recloser', allowNone: true },
    { key: 'numfast', label: 'Fast operations', kind: 'number' },
    { key: 'shots', label: 'Shots to lockout', kind: 'number' },
    { key: 'delay', label: 'Added delay', kind: 'number', unit: 's' },
    { key: 'normamps', label: 'Continuous rating', kind: 'number', unit: 'A' },
    { key: 'interruptingka', label: 'Interrupting rating', kind: 'number', unit: 'kA' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
  ],
  relay: [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'closed', label: 'Closed', kind: 'checkbox' },
    { key: 'phasetrip', label: 'Phase pickup', kind: 'number', unit: 'A' },
    { key: 'phasecurve', label: 'Phase curve', kind: 'curve', curveKind: 'relay' },
    { key: 'groundtrip', label: 'Ground pickup', kind: 'number', unit: 'A' },
    { key: 'groundcurve', label: 'Ground curve', kind: 'curve', curveKind: 'relay', allowNone: true },
    { key: 'delay', label: 'Added delay', kind: 'number', unit: 's' },
    { key: 'normamps', label: 'Continuous rating', kind: 'number', unit: 'A' },
    { key: 'interruptingka', label: 'Interrupting rating', kind: 'number', unit: 'kA' },
    { key: 'phases', label: 'Phases', kind: 'select', options: [1, 2, 3] },
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

/** The engine's own curves, by the device they belong to. The backend keeps
 *  the same lists; these decide what the dropdown offers, and a curve the
 *  circuit defines is offered for any device. */
const BUILTIN_CURVES: Record<string, string[]> = {
  fuse: ['tlink', 'klink'],
  recloser: ['a', 'd', 'tlink', 'klink'],
  relay: ['mod_inv', 'very_inv', 'ext_inv', 'definite'],
}

function CurveSelect({
  value,
  curveKind = 'relay',
  allowNone = false,
  onCommit,
}: {
  value: unknown
  curveKind?: 'fuse' | 'recloser' | 'relay'
  allowNone?: boolean
  onCommit: (v: unknown) => void
}) {
  const mine = Object.keys(useCircuitStore((s) => s.tccCurves))
  const builtin = BUILTIN_CURVES[curveKind] ?? []
  const current = String(value ?? '')
  const known = [...builtin, ...mine]
  return (
    <select value={current} onChange={(e) => onCommit(e.target.value)}>
      {allowNone && <option value="none">none</option>}
      {builtin.map((n) => (
        <option key={n} value={n}>{n}</option>
      ))}
      {mine.map((n) => (
        <option key={n} value={n}>{n} (this circuit)</option>
      ))}
      {current && current !== 'none' && !known.includes(current) && (
        <option value={current}>{current} (missing)</option>
      )}
    </select>
  )
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
  if (field.kind === 'curve') {
    return (
      <CurveSelect value={value} curveKind={field.curveKind}
                   allowNone={field.allowNone} onCommit={onCommit} />
    )
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
