import { useRef } from 'react'
import { api } from '../lib/api'
import { autoLayout } from '../lib/layout'
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
  const setSolving = useResultsStore((s) => s.setSolving)
  const setResult = useResultsStore((s) => s.setResult)
  const setIssues = useResultsStore((s) => s.setIssues)

  const projectInput = useRef<HTMLInputElement>(null)
  const dssInput = useRef<HTMLInputElement>(null)

  const hasErrors = issues.some((i) => i.severity === 'error')
  const circuit = () => toCircuitJSON(useCircuitStore.getState())

  const onSolve = async () => {
    setSolving(true)
    try {
      const result = await api.solve(circuit())
      setResult(result)
      if (result.busNames) mergeBusNames(result.busNames)
      const solveIssues = result.issues.filter((i) => i.code !== 'default-rating')
      if (solveIssues.length) setIssues([...issues.filter((i) => i.code === 'client'), ...solveIssues])
    } catch (err) {
      alert(`Solve request failed: ${err}`)
    } finally {
      setSolving(false)
    }
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

  const onImportDss = async (file: File) => {
    try {
      const { circuit: imported, unsupported } = await api.importDss(await file.text())
      autoLayout(imported)
      loadCircuit(imported)
      if (unsupported.length) {
        alert(`Imported with ${unsupported.length} unsupported element(s) skipped:\n` +
          unsupported.join('\n'))
      }
    } catch (err) {
      alert(`Import failed: ${err}`)
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
        <button
          onClick={onSaveProject}
          title={dirty ? 'You have unsaved changes — save project as JSON' : 'Save project as JSON'}
        >
          Save{dirty ? ' •' : ''}
        </button>
        <button onClick={() => projectInput.current?.click()}>Open</button>
        <button onClick={onExportDss} title="Export as a runnable OpenDSS .dss file">Export .dss</button>
        <button onClick={() => dssInput.current?.click()} title="Import an OpenDSS .dss file">Import .dss</button>
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
        accept=".dss,.txt"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onImportDss(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}
