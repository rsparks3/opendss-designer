import { useReactFlow } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { everything, rankHits, type Hit } from '../lib/find'
import { useCircuitStore } from '../store/circuitStore'
import { typeLabel } from './BulkEditor'

/** Edit → Find: type part of a name, pick it, and the canvas selects it and
 *  zooms to it. Arrow keys move through the matches; Enter picks. */
export function FindDialog({ onClose }: { onClose: () => void }) {
  const { fitView } = useReactFlow()
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const all = useMemo(everything, [])
  const hits = rankHits(all, query)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const go = (h: Hit | undefined) => {
    if (!h) return
    useCircuitStore.getState().selectOnly(h.kind, h.id)
    void fitView({ nodes: h.frame.map((id) => ({ id })), duration: 300, maxZoom: 1.5, padding: 0.6 })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box find-box"
        role="dialog"
        aria-label="Find"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setAt((i) => Math.min(i + 1, hits.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setAt((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter') go(hits[at])
        }}
      >
        <input
          ref={input}
          className="find-input"
          placeholder="Find an element by name"
          aria-label="Element name"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setAt(0)
          }}
        />
        {query.trim() && (
          <ul className="find-list" role="listbox" aria-label="Matches">
            {hits.length === 0 && <li className="find-none">Nothing named like that</li>}
            {hits.map((h, i) => (
              <li
                key={h.kind + h.id}
                role="option"
                aria-selected={i === at}
                className={i === at ? 'active' : ''}
                onMouseEnter={() => setAt(i)}
                onClick={() => go(h)}
              >
                <span className="find-name">{h.name}</span>
                <span className="find-type">{typeLabel(h.type, 1)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
