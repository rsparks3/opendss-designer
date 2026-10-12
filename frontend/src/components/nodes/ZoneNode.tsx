import { NodeResizer, type NodeProps } from '@xyflow/react'
import { beginGesture, endGesture, useCircuitStore, type AppNode } from '../../store/circuitStore'

export const ZONE_COLORS = ['grey', 'blue', 'green', 'amber', 'red', 'purple'] as const
export type ZoneColor = (typeof ZONE_COLORS)[number]

export function zoneColor(v: unknown): ZoneColor {
  return (ZONE_COLORS as readonly string[]).includes(String(v)) ? (v as ZoneColor) : 'grey'
}

/** A labelled rectangle behind a group of elements: a substation, a
 *  feeder, a service area. Drawing only, like a note.
 *
 *  Its inside lets the pointer through, so clicking or box-selecting over
 *  a zone works on what is in it, not on the zone; the zone itself is
 *  taken by its border strip or its label, and sized by the handles. It
 *  sits under everything (index.css), so it never covers a symbol. */
export function ZoneNode({ id, data, selected }: NodeProps<AppNode>) {
  const params = data.params
  const label = typeof params.label === 'string' ? params.label : ''
  const color = zoneColor(params.color)
  const setZoneSize = useCircuitStore((s) => s.setZoneSize)
  return (
    <div className={`zone-node zone-${color}${selected ? ' selected' : ''}`}>
      {selected && (
        <NodeResizer
          minWidth={60}
          minHeight={40}
          lineClassName="zone-resize-line"
          handleClassName="zone-resize-handle"
          onResizeStart={beginGesture}
          onResizeEnd={(_e, p) => {
            setZoneSize(id, p.width, p.height)
            endGesture()
          }}
        />
      )}
      <div className="zone-edge top" />
      <div className="zone-edge bottom" />
      <div className="zone-edge left" />
      <div className="zone-edge right" />
      <div className={`zone-label${label.trim() ? '' : ' zone-placeholder'}`}>{label.trim() ? label : 'Zone'}</div>
    </div>
  )
}
