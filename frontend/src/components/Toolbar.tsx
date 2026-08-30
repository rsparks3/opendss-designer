import { useRef } from 'react'
import { api } from '../lib/api'
import { autoLayout } from '../lib/layout'
import { runSolve } from '../lib/solve'
import {
  redo,
  toCircuitJSON,
  undo,
  useCircuitStore,
} from '../store/circuitStore'
import { useResultsStore, type OverlayMode } from '../store/resultsStore'

function download(filename: string, text: string, type = 'application/json') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

const OVERLAYS: { mode: OverlayMode; label: string }[] = [
  { mode: 'voltage', label: 'Voltages' },
  { mode: 'loading', label: 'Loading' },
  { mode: 'power', label: 'Power' },
  { mode: 'off', label: 'Off' },
]

export function Toolbar() {
  const name = useCircuitStore((s) => s.name)
  const setName = useCircuitStore((s) => s.setName)
  const mergeBusNames = useCircuitStore((s) => s.mergeBusNames)
  const loadCircuit = useCircuitStore((s) => s.loadCircuit)
  const dirty = useCircuitStore((s) => s.dirty)
  const markSaved = useCircuitStore((s) => s.markSaved)

  const solving = useResultsStore((s) => s.solving)
  const overlay = useResultsStore((s) => s.overlay)
  const setOverlay = useResultsStore((s) => s.setOverlay)
  const issues = useResultsStore((s) => s.issues)
  const autoSolve = useResultsStore((s) => s.autoSolve)
  const setAutoSolve = useResultsStore((s) => s.setAutoSolve)

  const projectInput = useRef<HTMLInputElement>(null)
  const dssInput = useRef<HTMLInputElement>(null)

  const hasErrors = issues.some((i) => i.severity === 'error')
  const circuit = () => toCircuitJSON(useCircuitStore.getState())

  const onSolve = async () => {
    const ok = await runSolve()
    if (!ok) alert('Solve request failed — is the backend still running?')
  }

  const onNew = () => {
    const st = useCircuitStore.getState()
    if (
      st.nodes.length > 0 &&
      st.dirty &&
      !window.confirm('Discard unsaved changes and start a new circuit?')
    ) {
      return
    }
    st.clearAll()
    st.setName('my-circuit')
    useCircuitStore.setState({ dirty: false })
    useCircuitStore.temporal.getState().clear()
    useResultsStore.setState({ result: null, stale: false, issues: [] })
  }

  const onSaveProject = () => {
    download(`${name || 'circuit'}.oneline.json`, JSON.stringify(circuit(), null, 2))
    markSaved()
  }

  const onOpenProject = async (file: File) => {
    try {
      loadCircuit(JSON.parse(await file.text()))
    } catch (err) {
      alert(`Could not open project: ${err}`)
    }
  }

  const onExportDss = async () => {
    try {
      download(`${name || 'circuit'}.dss`, await api.exportDss(circuit()), 'text/plain')
    } catch (err) {
      alert(`Export failed: ${err}`)
    }
  }

  const onImportDss = async (fileList: File[]) => {
    try {
      const files = await Promise.all(
        fileList.map(async (f) => ({ name: f.name, text: await f.text() })),
      )
      const { circuit: imported, unsupported, warnings } = await api.importDss(files)
      autoLayout(imported)
      loadCircuit(imported)
      const notes = [...(warnings ?? [])]
      if (unsupported.length) {
        notes.push(`${unsupported.length} unsupported element(s) skipped:\n` +
          unsupported.join('\n'))
      }
      if (notes.length) alert(notes.join('\n\n'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      let tip = ''
      if (/references other files|not found/i.test(msg)) {
        tip = '\n\nTip: in the file dialog, Ctrl+click to select the main .dss file ' +
          'together with every file it references (line codes, bus coordinates, redirects).'
      }
      alert(`Import failed: ${msg}${tip}`)
    }
  }

  return (
    <div className="toolbar">
      <span className="app-title">OpenDSS Designer</span>
      <input
        className="circuit-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        title="Circuit name"
      />
      <div className="tb-group">
        <button onClick={() => undo()} title="Undo (Ctrl+Z)">↩ Undo</button>
        <button onClick={() => redo()} title="Redo (Ctrl+Y)">↪ Redo</button>
      </div>
      <div className="tb-group">
        <button
          className="solve-btn"
          onClick={onSolve}
          disabled={solving || hasErrors}
          title={hasErrors ? 'Fix the errors in the problems list first' : 'Run snapshot power flow'}
        >
          {solving ? 'Solving…' : '▶ Solve'}
        </button>
        <button
          className={autoSolve ? 'active' : ''}
          onClick={() => {
            setAutoSolve(!autoSolve)
            if (!autoSolve && !hasErrors) void runSolve()
          }}
          title="Auto-solve: re-run the power flow automatically whenever the circuit changes"
        >
          Auto
        </button>
      </div>
      <div className="tb-group overlay-group">
        <span className="tb-label">Overlay:</span>
        {OVERLAYS.map((o) => (
          <button
            key={o.mode}
            className={overlay === o.mode ? 'active' : ''}
            onClick={() => setOverlay(o.mode)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="tb-spacer" />
      <div className="tb-group">
        <button onClick={onNew} title="Start a new empty circuit">New</button>
        <button
          onClick={onSaveProject}
          title={dirty ? 'You have unsaved changes — save project as JSON' : 'Save project as JSON'}
        >
          Save{dirty ? ' •' : ''}
        </button>
        <button onClick={() => projectInput.current?.click()}>Open</button>
        <button onClick={onExportDss} title="Export as a runnable OpenDSS .dss file">Export .dss</button>
        <button
          onClick={() => dssInput.current?.click()}
          title="Import OpenDSS .dss file(s) — select the main file plus anything it references (line codes, BusCoords csv)"
        >
          Import .dss
        </button>
      </div>
      <input
        ref={projectInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onOpenProject(f)
          e.target.value = ''
        }}
      />
      <input
        ref={dssInput}
        type="file"
        accept=".dss,.txt,.csv"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) onImportDss(files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
