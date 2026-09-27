import { useEffect, useState } from 'react'
import { passthroughName } from '../lib/passthroughRefs'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'

/**
 * The Passthrough tab: what an imported .dss file defined that the editor
 * does not draw -- monitors, meters, controls, curves -- kept as the file
 * wrote it. Each entry can be read, edited or removed; it goes back out on
 * export and into solves when the backend judges it safe (see
 * core/passthrough.py), and the Problems list says when it is left out.
 */
export function PassthroughPanel() {
  const entries = useCircuitStore((s) => s.passthrough)
  const comments = useCircuitStore((s) => s.comments)
  const setPassthrough = useCircuitStore((s) => s.setPassthrough)
  const issues = useResultsStore((s) => s.issues)
  const [active, setActive] = useState(0)
  const entry = entries[active]
  const [draft, setDraft] = useState(entry?.text ?? '')
  useEffect(() => setDraft(entry?.text ?? ''), [entry?.text, active])

  const noteFor = (name: string) =>
    issues.find((i) => i.code === 'passthrough' && i.message.toLowerCase().startsWith(`${name.toLowerCase()}:`))
  const commentCount = Object.keys(comments).length

  const commit = () => {
    if (!entry || draft === entry.text) return
    const name = passthroughName(draft) ?? entry.name
    setPassthrough(entries.map((e, i) => (i === active ? { name, text: draft } : e)))
  }

  const add = () => {
    const taken = new Set(entries.map((e) => e.name.toLowerCase()))
    let n = 1
    while (taken.has(`monitor.m${n}`)) n++
    const text = `new monitor.m${n} element= terminal=1`
    setPassthrough([...entries, { name: `monitor.m${n}`, text }])
    setActive(entries.length)
  }

  return (
    <div className="curves-panel">
      <div className="curves-list">
        <button type="button" className="curves-add" onClick={add} title="Type in an OpenDSS element of your own">
          + New element
        </button>
        {entries.map((e, i) => {
          const note = noteFor(e.name)
          return (
            <button
              type="button"
              key={`${e.name}-${i}`}
              className={`curves-item${i === active ? ' active' : ''}`}
              onClick={() => {
                commit()
                setActive(i)
              }}
              title={note?.message}
            >
              <span>{e.name}</span>
              <span className={note ? 'pt-state off' : 'pt-state'}>{note ? 'export only' : 'in solve'}</span>
            </button>
          )
        })}
        {commentCount > 0 && (
          <div className="curves-used">
            {commentCount} comment{commentCount === 1 ? '' : 's'} from the imported file, written back
            above {commentCount === 1 ? 'its element' : 'their elements'} on export.
          </div>
        )}
      </div>
      {entry ? (
        <div className="curves-editor">
          <div className="curves-head">
            <strong>{entry.name}</strong>
            <button
              type="button"
              className="curves-delete"
              onClick={() => {
                setPassthrough(entries.filter((_, i) => i !== active))
                setActive(Math.max(0, active - 1))
              }}
            >
              Delete
            </button>
          </div>
          <textarea
            className="pt-text"
            aria-label="OpenDSS text"
            spellCheck={false}
            value={draft}
            rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
          <div className="curves-used">
            {noteFor(entry.name)?.message ??
              'Runs in every solve, after the elements on the drawing, and is written back on export.'}
          </div>
        </div>
      ) : (
        <div className="bp-empty">
          Nothing here. Importing a .dss file keeps the elements the editor does not draw — monitors,
          energy meters, capacitor and inverter controls, curves, reactors — so they are exported again
          and, when safe, solved.
        </div>
      )}
    </div>
  )
}
