import { useEffect, useRef, type ReactNode } from 'react'
import { exportSaved, openFromLibrary, openProjectFile, saveAsChosen } from '../lib/fileActions'
import { useInstanceHealth } from '../lib/instance'
import { DOCS_URL, ISSUES_URL } from '../lib/menus'
import { keyLabel, SHORTCUTS } from '../lib/shortcuts'
import { DEFAULT_PHASES, PHASE_KEY_LABELS, PHASE_KEYS, type ThemePref } from '../lib/theme'
import { useCircuitStore } from '../store/circuitStore'
import { useUiStore } from '../store/uiStore'
import { FindDialog } from './FindDialog'
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
    case 'prefs':
      return <PrefsDialog onClose={close} />
    case 'find':
      return <FindDialog onClose={close} />
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
  // Focus once, on opening, so Escape works; not on every re-render.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-box${wide ? ' wide' : ''}`}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        ref={box}
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

function PrefsDialog({ onClose }: { onClose: () => void }) {
  const themePref = useUiStore((s) => s.themePref)
  const theme = useUiStore((s) => s.theme)
  const setThemePref = useUiStore((s) => s.setThemePref)
  const palette = useUiStore((s) => s.phasePalette)
  const setPalette = useUiStore((s) => s.setPhasePalette)
  const choices: [ThemePref, string][] = [
    ['light', 'Light'],
    ['dark', 'Dark'],
    ['system', 'Same as the system'],
  ]
  const custom = PHASE_KEYS.some((k) => palette[k])
  return (
    <Modal label="Preferences" onClose={onClose}>
      <fieldset className="prefs-group">
        <legend>Theme</legend>
        {choices.map(([pref, label]) => (
          <label key={pref} className="prefs-radio">
            <input
              type="radio"
              name="theme"
              checked={themePref === pref}
              onChange={() => setThemePref(pref)}
            />
            {label}
          </label>
        ))}
        <div className="library-note">Image exports always use the light theme.</div>
      </fieldset>
      <fieldset className="prefs-group">
        <legend>Phases overlay colours</legend>
        <div className="prefs-swatches">
          {PHASE_KEYS.map((k) => (
            <label key={k} className="prefs-swatch">
              <input
                type="color"
                aria-label={PHASE_KEY_LABELS[k]}
                value={palette[k] ?? DEFAULT_PHASES[theme][k]}
                onChange={(e) => setPalette({ ...palette, [k]: e.target.value })}
              />
              {PHASE_KEY_LABELS[k]}
            </label>
          ))}
        </div>
        <div className="library-note">
          Three-phase lines keep the ordinary ink; unfed buses stay grey. Your colours apply in both
          themes and in exported images.
        </div>
        <div>
          <button type="button" disabled={!custom} onClick={() => setPalette({})}>
            Use the default colours
          </button>
        </div>
      </fieldset>
    </Modal>
  )
}
