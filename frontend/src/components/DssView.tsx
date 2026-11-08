import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { hasElements } from '../lib/defaults'
import { exportDss } from '../lib/fileActions'
import { toCircuitJSON, useCircuitStore, type CircuitState } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { ViewToggle } from './ViewToggle'

/** Every part of the document the script is compiled from. Positions are in
 *  `nodes` too, but nothing on this view can move one. */
const SLICES = [
  'name', 'nodes', 'edges', 'busNames', 'loadShapes', 'tccCurves', 'lineCodes',
  'passthrough', 'comments', 'limits', 'study', 'voltageBases', 'crs',
] as const satisfies readonly (keyof CircuitState)[]

/** Fixed, so a line's position is its index times this: the find box scrolls
 *  to a match and marks it without measuring anything. Matches the CSS. */
const LINE_PX = 18
const PAD_PX = 8

/**
 * The DSS view: the OpenDSS script the drawing compiles to -- the text
 * Export .dss writes, and what every solve runs less its solve directives.
 * Read-only. It is compiled on the server, so it follows edits made in the
 * properties panel or the Elements tab after a short pause.
 */
export function DssView() {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [empty, setEmpty] = useState(() => !hasElements(useCircuitStore.getState().nodes))
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let seq = 0
    let timer: number | undefined
    let last: unknown[] = []
    const refresh = async () => {
      const s = useCircuitStore.getState()
      last = SLICES.map((k) => s[k])
      const mine = ++seq
      if (!hasElements(s.nodes)) {
        setEmpty(true)
        setText(null)
        setError(null)
        return
      }
      setEmpty(false)
      setBusy(true)
      try {
        const script = await api.exportDss(toCircuitJSON(s))
        if (mine !== seq) return
        setText(script)
        setError(null)
      } catch (err) {
        if (mine !== seq) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (mine === seq) setBusy(false)
      }
    }
    void refresh()
    const unsub = useCircuitStore.subscribe((s) => {
      if (SLICES.every((k, i) => s[k] === last[i])) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(), 400)
    })
    return () => {
      window.clearTimeout(timer)
      unsub()
    }
  }, [])

  const lines = useMemo(() => (text == null ? [] : text.replace(/\n$/, '').split('\n')), [text])
  const numbers = useMemo(() => lines.map((_, i) => i + 1).join('\n'), [lines])
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const out: number[] = []
    lines.forEach((l, i) => l.toLowerCase().includes(q) && out.push(i))
    return out
  }, [lines, query])
  const current = matches.length ? matches[Math.min(hit, matches.length - 1)] : null

  useEffect(() => {
    const el = scroller.current
    if (current == null || !el) return
    const top = PAD_PX + current * LINE_PX
    if (top < el.scrollTop || top + LINE_PX > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3)
    }
  }, [current])

  const step = (by: number) => {
    if (!matches.length) return
    setHit((h) => (Math.min(h, matches.length - 1) + by + matches.length) % matches.length)
  }

  const copy = async () => {
    if (text == null) return
    const flash = useResultsStore.getState().setFlash
    try {
      await navigator.clipboard.writeText(text)
      flash(`Copied ${lines.length} lines of OpenDSS script`, 'info')
    } catch {
      flash('The browser would not allow copying; select the text and copy it instead')
    }
  }

  return (
    <div className="dss-view">
      <div className="dss-toolbar">
        <input
          className="dss-find"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHit(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              step(e.shiftKey ? -1 : 1)
            }
          }}
          placeholder="Find in script"
          title="Enter for the next match, Shift+Enter for the previous one"
          spellCheck={false}
          aria-label="Find in script"
        />
        {query.trim() && (
          <span className="dss-count">
            {matches.length ? `${Math.min(hit, matches.length - 1) + 1} of ${matches.length}` : 'no match'}
          </span>
        )}
        <button type="button" onClick={() => void copy()} disabled={text == null}
                title="Copy the whole script to the clipboard">
          Copy
        </button>
        <button type="button" onClick={() => void exportDss()} disabled={text == null}
                title="Save the script as a .dss file (File ▸ Export .dss)">
          Save .dss
        </button>
        <span className="dss-status">
          {busy ? 'Updating…' : text != null ? `${lines.length} lines · read-only` : ''}
        </span>
      </div>
      {error && <div className="dss-error">Could not compile the script: {error}</div>}
      {empty ? (
        <div className="dss-empty">Nothing to compile yet: add a source and some elements to the one-line.</div>
      ) : (
        <div className="dss-scroll" ref={scroller} style={{ opacity: busy || error ? 0.6 : 1 }}>
          <div className="dss-body">
            {current != null && <div className="dss-hit" style={{ top: PAD_PX + current * LINE_PX }} />}
            <pre className="dss-gutter" aria-hidden="true">{numbers}</pre>
            <pre className="dss-code" data-testid="dss-code">{text ?? ''}</pre>
          </div>
        </div>
      )}
      <ViewToggle />
    </div>
  )
}
