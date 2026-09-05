import { useEffect, useState } from 'react'
import {
  deleteProject,
  describeProject,
  listProjects,
  renameProject,
  type ProjectMeta,
} from '../lib/library'

/** First save of a new circuit: ask for a name once. */
export function SaveAsDialog({
  initialName,
  onSave,
  onCancel,
}: {
  initialName: string
  onSave: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initialName)
  const trimmed = name.trim()
  const save = () => trimmed && onSave(trimmed)
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-box"
        role="dialog"
        aria-label="Save circuit"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter') save()
        }}
      >
        <div className="modal-title">Save circuit</div>
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        <div className="library-note">
          Saved in this browser only. Use Export .json to move it to another computer or keep a backup.
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="modal-primary" disabled={!trimmed} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function when(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? `today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

/** The saved-circuits list: open, rename, delete, export. */
export function LibraryDialog({
  currentId,
  onOpen,
  onExport,
  onImportFile,
  onClose,
}: {
  currentId: string | null
  onOpen: (id: string) => void
  onExport: (id: string) => void
  onImportFile: () => void
  onClose: () => void
}) {
  const [items, setItems] = useState<ProjectMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  const refresh = () =>
    listProjects()
      .then(setItems)
      .catch((err) => setError(`Could not read the library: ${err instanceof Error ? err.message : err}`))
  useEffect(() => {
    void refresh()
  }, [])

  const commitRename = async () => {
    if (!renaming) return
    const name = renaming.name.trim()
    if (name) {
      await renameProject(renaming.id, name)
      await refresh()
    }
    setRenaming(null)
  }

  const remove = async (m: ProjectMeta) => {
    if (!window.confirm(`Delete "${m.name}" from this browser? This cannot be undone.`)) return
    await deleteProject(m.id)
    await refresh()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box library"
        role="dialog"
        aria-label="Open circuit"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (renaming ? setRenaming(null) : onClose())
        }}
      >
        <div className="modal-title">Saved circuits</div>
        {error && <div className="modal-error">{error}</div>}
        {items && items.length === 0 && (
          <div className="library-empty">
            Nothing saved yet. Press <kbd>Ctrl</kbd>+<kbd>S</kbd> or the Save button to keep the circuit you are working on.
          </div>
        )}
        {items && items.length > 0 && (
          <table className="library-table">
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className={m.id === currentId ? 'current' : ''}>
                  <td className="library-name">
                    {renaming?.id === m.id ? (
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: m.id, name: e.target.value })}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename()
                          if (e.key === 'Escape') {
                            e.stopPropagation()
                            setRenaming(null)
                          }
                        }}
                      />
                    ) : (
                      <button type="button" className="library-open" onClick={() => onOpen(m.id)} title="Open">
                        {m.name}
                        {m.id === currentId && <span className="library-current"> (open)</span>}
                      </button>
                    )}
                    <div className="library-meta">
                      {describeProject(m)} · saved {when(m.savedAt)}
                    </div>
                  </td>
                  <td className="library-actions">
                    <button type="button" onClick={() => setRenaming({ id: m.id, name: m.name })}>Rename</button>
                    <button type="button" onClick={() => onExport(m.id)} title="Download as a .oneline.json file">
                      Export
                    </button>
                    <button type="button" onClick={() => void remove(m)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="library-note">
          Circuits are saved in this browser on this device. They are not uploaded, and clearing
          site data removes them; Export keeps a copy as a file.
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onImportFile}>Import .json file…</button>
          <span className="tb-spacer" />
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
