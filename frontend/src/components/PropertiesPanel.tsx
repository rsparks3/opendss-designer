import { FIELDS, FieldInput } from '../lib/fields'
import { detachesPreset, presetPatch, useLineCodeStore } from '../lib/lineCodes'
import { useCircuitStore, type AppEdge, type AppNode } from '../store/circuitStore'
import type { Params, Winding } from '../types/circuit'

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
  const lineCodePresets = useLineCodeStore((s) => s.presets)
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
    commit = (patch) =>
      // Hand-editing an impedance detaches the line from its conductor preset.
      updateEdgeParams(
        selEdge.id,
        detachesPreset(patch) && params?.linecode ? { ...patch, linecode: '' } : patch,
      )
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
          <br />
          <br />
          Tips: drag on empty canvas to box-select several elements and move
          them together (pan with the right or middle mouse button; scroll to
          zoom). Double-click a wire or line to add a routing point;
          double-click a breaker to open/close it.
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
        {kind === 'line' && (
          <label className="prop-row">
            <span>Conductor preset</span>
            <select
              value={String(params.linecode ?? '')}
              onChange={(e) => {
                const patch = presetPatch(e.target.value)
                if (patch) commit!(patch)
                else commit!({ linecode: '' })
              }}
              title="Stamps the preset's impedances into the fields below (editable afterward). Presets come from config/linecodes.csv — edit that file to customize."
            >
              <option value="">— custom R/X —</option>
              {lineCodePresets.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
              {typeof params.linecode === 'string' &&
                params.linecode !== '' &&
                !lineCodePresets.some((p) => p.code === params.linecode) && (
                  <option value={params.linecode}>{params.linecode} (imported)</option>
                )}
            </select>
          </label>
        )}
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
