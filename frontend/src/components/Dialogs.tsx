import type { ReactNode } from 'react'
import { exportSaved, openFromLibrary, openProjectFile, saveAsChosen } from '../lib/fileActions'
import { useInstanceHealth } from '../lib/instance'
import { DOCS_URL, ISSUES_URL } from '../lib/menus'
import { keyLabel, SHORTCUTS } from '../lib/shortcuts'
import { useCircuitStore } from '../store/circuitStore'
import { useUiStore } from '../store/uiStore'
import { LibraryDialog, SaveAsDialog } from './ProjectLibrary'

/** Whichever dialog the UI store says is open. */
export function Dialogs() {
  const dialog = useUiStore((s) => s.dialog)
  const close = useUiStore((s) => s.closeDialog)
  const name = useCircuitStore((s) => s.name)
  const projectId = useCircuitStore((s) => s.projectId)

  switch (dialog) {
    case 'saveAs':
      return (
        <SaveAsDialog
          initialName={name.trim() || 'my-circuit'}
          onCancel={close}
          onSave={(chosen) => {
            close()
            saveAsChosen(chosen)
          }}
        />
      )
    case 'library':
      return (
        <LibraryDialog
          currentId={projectId}
          onOpen={(id) => void openFromLibrary(id)}
          onExport={(id) => void exportSaved(id)}
          onImportFile={() => void openProjectFile()}
          onClose={close}
        />
      )
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />
    case 'about':
      return <AboutDialog onClose={close} />
    default:
      return null
  }
}

function Modal({ label, wide, onClose, children }: {
  label: string
  wide?: boolean
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-box${wide ? ' wide' : ''}`}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-title">{label}</div>
        {children}
        <div className="modal-actions">
          <button type="button" className="modal-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="Keyboard shortcuts" wide onClose={onClose}>
      <div className="shortcut-groups">
        {SHORTCUTS.map((g) => (
          <table key={g.title} className="shortcut-table">
            <caption>{g.title}</caption>
            <tbody>
              {g.items.map((s) => (
                <tr key={s.keys + s.action}>
                  <td><kbd>{keyLabel(s.keys)}</kbd></td>
                  <td>{s.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </Modal>
  )
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const health = useInstanceHealth()
  return (
    <Modal label="About OpenDSS Designer" onClose={onClose}>
      <p>
        A one-line diagram editor for OpenDSS distribution models.
        {health?.version && <> Version <strong>{health.version}</strong>.</>}
      </p>
      <p>
        Solved by the EPRI OpenDSS engine through DSS-Extensions (OpenDSSDirect.py).
        Free software under the GNU AGPL v3.
      </p>
      <p>
        <a href={DOCS_URL} target="_blank" rel="noopener">Documentation</a>
        {' · '}
        <a href={ISSUES_URL} target="_blank" rel="noopener">Report an issue</a>
      </p>
    </Modal>
  )
}
