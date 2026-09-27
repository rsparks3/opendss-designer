import { useMemo, useState } from 'react'
import { FieldInput, type Field } from '../lib/fields'
import { applyNumberEdit, commonFields, commonValue, isRelativeEdit } from '../lib/selection'
import { beginGesture, endGesture, useCircuitStore, type AppEdge, type AppNode } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { Params } from '../types/circuit'

const TYPE_LABELS: Record<string, [string, string]> = {
  vsource: ['source', 'sources'],
  busbar: ['busbar', 'busbars'],
  transformer: ['transformer', 'transformers'],
  regulator: ['regulator', 'regulators'],
  breaker: ['breaker', 'breakers'],
  fuse: ['fuse', 'fuses'],
  recloser: ['recloser', 'reclosers'],
  relay: ['relay', 'relays'],
  load: ['load', 'loads'],
  capacitor: ['capacitor', 'capacitors'],
  generator: ['generator', 'generators'],
  pvsystem: ['PV system', 'PV systems'],
  storage: ['storage unit', 'storage units'],
  line: ['line', 'lines'],
}

export const typeLabel = (type: string, n: number) =>
  (TYPE_LABELS[type] ?? [type, type + 's'])[n === 1 ? 0 : 1]

/** A number or text field over many elements: shows the shared value, or
 *  "(mixed)"; a number accepts ×1.1, /2, +5, -5 to change each element's
 *  own value, and a plain number (or =-5) to set them all. */
function BulkTextField({
  field,
  values,
  onCommit,
}: {
  field: Field
  values: unknown[]
  onCommit: (text: string) => void
}) {
  const { value, mixed } = commonValue(values)
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (mixed ? '' : value == null ? '' : String(value))
  const commit = () => {
    const text = (draft ?? '').trim()
    setDraft(null)
    if (text) onCommit(text)
  }
  return (
    <input
      type="text"
      value={shown}
      placeholder={mixed ? '(mixed)' : ''}
      title={field.kind === 'number'
        ? 'A number sets every element. ×1.1 or /2 scales each element’s own value; +5 or -5 shifts it; =-5 sets a negative number.'
        : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

/** A dropdown over many elements: the shared choice, or a "(mixed)" entry
 *  until one is picked for all of them. */
function BulkSelect({ field, values, onCommit }: { field: Field; values: unknown[]; onCommit: (v: unknown) => void }) {
  const { value, mixed } = commonValue(values)
  return (
    <select
      value={mixed ? '__mixed__' : String(value ?? '')}
      onChange={(e) => {
        const opt = field.options?.find((o) => String(o) === e.target.value)
        if (e.target.value !== '__mixed__') onCommit(opt ?? e.target.value)
      }}
    >
      {mixed && <option value="__mixed__">(mixed)</option>}
      {field.options?.map((o) => (
        <option key={String(o)} value={String(o)}>{String(o)}</option>
      ))}
    </select>
  )
}

/** The properties panel for a multi-selection: the fields every selected
 *  type shares, each applied to all of them at once. */
export function BulkEditor({ nodes, edges }: { nodes: AppNode[]; edges: AppEdge[] }) {
  const bulkUpdate = useCircuitStore((s) => s.bulkUpdateParams)
  const selectMany = useCircuitStore((s) => s.selectMany)
  const setFlash = useResultsStore((s) => s.setFlash)

  const elements = useMemo(
    () => [
      ...nodes.map((n) => ({ id: n.id, kind: 'node' as const, type: n.type ?? '', params: n.data.params })),
      ...edges.map((e) => ({ id: e.id, kind: 'edge' as const, type: 'line', params: e.data?.params ?? {} })),
    ],
    [nodes, edges],
  )
  const counts = useMemo(() => {
    const out = new Map<string, number>()
    for (const el of elements) out.set(el.type, (out.get(el.type) ?? 0) + 1)
    return [...out.entries()].sort((a, b) => b[1] - a[1])
  }, [elements])
  const types = counts.map(([t]) => t)
  const fields = commonFields(types).filter(
    (f) => !f.showIf || elements.every((el) => f.showIf!(el.params)),
  )
  const picked = { nodeIds: nodes.map((n) => n.id), edgeIds: edges.map((e) => e.id) }

  const setAll = (key: string, value: unknown) => {
    beginGesture()
    bulkUpdate(picked, () => ({ [key]: value }))
    endGesture()
  }

  const commitText = (f: Field, text: string) => {
    if (f.kind !== 'number') {
      setAll(f.key, text)
      return
    }
    const relative = isRelativeEdit(text)
    let skipped = 0
    beginGesture()
    bulkUpdate(picked, (params: Params) => {
      const next = applyNumberEdit(text, params[f.key])
      if (next == null) {
        skipped += 1
        return null
      }
      return { [f.key]: next }
    })
    endGesture()
    if (skipped === elements.length) {
      setFlash(relative
        ? `${f.label}: nothing to scale — the selected elements have no ${f.label} value yet.`
        : `${f.label}: "${text}" is not a number.`)
    } else if (skipped) {
      setFlash(`${f.label}: ${skipped} element${skipped === 1 ? '' : 's'} had no value to change and were left alone.`, 'info')
    }
  }

  const reduceTo = (type: string) =>
    selectMany({
      nodeIds: nodes.filter((n) => n.type === type).map((n) => n.id),
      edgeIds: type === 'line' ? edges.map((e) => e.id) : [],
    })

  return (
    <div className="properties">
      <div className="palette-title">Edit {elements.length} elements</div>
      <div className="bulk-types">
        {counts.map(([type, n]) => (
          <button
            key={type}
            className="bulk-chip"
            onClick={() => reduceTo(type)}
            disabled={counts.length === 1}
            title={counts.length === 1 ? undefined : `Keep only the ${typeLabel(type, 2)} selected`}
          >
            {n} {typeLabel(type, n)}
          </button>
        ))}
      </div>
      {fields.length === 0 ? (
        <div className="props-empty">
          These elements have no settings in common. Click a type above to narrow
          the selection to it.
        </div>
      ) : (
        <div className="props-form">
          <div className="bulk-hint">
            A value entered here applies to every selected element. Numbers
            also take ×1.1, /2, +5 or -5 to change each one relative to itself.
          </div>
          {fields.map((f) => {
            const values = elements.map((el) => el.params[f.key])
            const { value, mixed } = commonValue(values)
            const plain = f.kind === 'number' || f.kind === 'text'
            return (
              <label key={f.key} className="prop-row">
                <span>
                  {f.label}
                  {f.unit ? ` (${f.unit})` : ''}
                  {mixed && !plain && f.kind !== 'select' && <em className="bulk-mixed"> mixed</em>}
                </span>
                {plain ? (
                  <BulkTextField field={f} values={values} onCommit={(t) => commitText(f, t)} />
                ) : f.kind === 'select' ? (
                  <BulkSelect field={f} values={values} onCommit={(v) => setAll(f.key, v)} />
                ) : (
                  <FieldInput field={f} value={mixed ? undefined : value} onCommit={(v) => setAll(f.key, v)} />
                )}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
