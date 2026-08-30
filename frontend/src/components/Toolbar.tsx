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
  { mode: 'fault', label: 'Fault' },
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
  const tsRunning = useResultsStore((s) => s.tsRunning)
  const analysisMode = useResultsStore((s) => s.analysisMode)
  const setAnalysisMode = useResultsStore((s) => s.setAnalysisMode)
  const overlay = useResultsStore((s) => s.overlay)
  const setOverlay = useResultsStore((s) => s.setOverlay)
  const issues = useResultsStore((s) => s.issues)
  const autoSolve = useResultsStore((s) => s.autoSolve)
  const setAutoSolve = useResultsStore((s) => s.setAutoSolve)

  const projectInput = useRef<HTMLInputElement>(null)
  const dssInput = useRef<HTMLInputElement>(null)

  const hasErrors = issues.some((i) => i.severity === 'error')
  const circuit = () => toCircuitJSON(useCircuitStore.getState())
  const flash = (msg: string, kind?: 'error' | 'info', durationMs?: number) =>
    useResultsStore.getState().setFlash(msg, kind, durationMs)

  // runSolve surfaces its own failures via the flash toast. Individual
  // snapshot runs are disabled in time-series mode (the transport bar under
  // the toolbar owns solving there).
  const tsMode = analysisMode === 'timeseries'
  const onSolve = () => void runSolve()

  // The fault study runs lazily when its overlay is first selected (results
  // are cleared on any circuit change, so re-selecting re-runs it).
  const onOverlay = (mode: OverlayMode) => {
    setOverlay(mode)
    if (mode === 'fault' && !useResultsStore.getState().fault) {
      void (async () => {
        try {
          const f = await api.faultStudy(circuit())
          useResultsStore.getState().setFault(f)
          if (!f.converged) {
            flash('Fault study failed — check the problems list')
          }
        } catch (err) {
          flash(`Fault study failed: ${err instanceof Error ? err.message : err}`)
        }
      })()
    }
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
      flash(`Could not open project: ${err instanceof Error ? err.message : err}`)
    }
  }

  const onExportDss = async () => {
    try {
      download(`${name || 'circuit'}.dss`, await api.exportDss(circuit()), 'text/plain')
    } catch (err) {
      flash(`Export failed: ${err instanceof Error ? err.message : err}`)
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
        const shown = unsupported.slice(0, 5)
        const more = unsupported.length - shown.length
        notes.push(`${unsupported.length} unsupported element(s) skipped: ` +
          shown.join(', ') + (more > 0 ? ` … and ${more} more` : ''))
      }
      if (notes.length) flash(notes.join('\n'), 'info', 8000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      let tip = ''
      if (/references other files|not found/i.test(msg)) {
        tip = '\nTip: in the file dialog, Ctrl+click to select the main .dss file ' +
          'together with every file it references (line codes, bus coordinates, redirects).'
      }
      flash(`Import failed: ${msg}${tip}`, 'error', 8000)
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
          className={analysisMode === 'snapshot' ? 'active' : ''}
          onClick={() => setAnalysisMode('snapshot')}
          title="Snapshot analysis: solve the base case on demand (or automatically)"
        >
          Snapshot
        </button>
        <button
          className={analysisMode === 'timeseries' ? 'active' : ''}
          onClick={() => setAnalysisMode('timeseries')}
          title="Time-series analysis: run daily/yearly simulations and scrub through the results"
        >
          Time series
        </button>
      </div>
      <div className="tb-group">
        <button
          className="solve-btn"
          onClick={onSolve}
          disabled={solving || hasErrors || tsRunning || tsMode}
          title={
            tsMode
              ? 'Individual runs disabled in time series mode'
              : hasErrors
                ? 'Fix the errors in the problems list first'
                : 'Run a snapshot power flow of the base case: loads at rated kW, ' +
                  'PV at its irradiance parameter, storage idle. Loadshapes only ' +
                  'apply to time-series runs.'
          }
        >
          {solving ? 'Solving…' : '▶ Solve'}
        </button>
        <button
          className={autoSolve && !tsMode ? 'active' : ''}
          disabled={tsMode}
          onClick={() => {
            setAutoSolve(!autoSolve)
            if (!autoSolve && !hasErrors) void runSolve()
          }}
          title={
            tsMode
              ? 'Individual runs disabled in time series mode'
              : 'Auto-solve: re-run the power flow automatically whenever the circuit changes'
          }
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
            onClick={() => onOverlay(o.mode)}
            title={o.mode === 'fault' ? 'Short-circuit study: prospective fault current at each bus' : undefined}
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
