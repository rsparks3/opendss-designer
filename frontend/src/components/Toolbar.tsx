import { useEffect, useRef, useState } from 'react'
import { api, type SampleMeta } from '../lib/api'
import { autoLayout } from '../lib/layout'
import { loadProject, newProjectId, saveProject } from '../lib/library'
import { migrateCircuit } from '../lib/schema'
import { runSolve } from '../lib/solve'
import {
  redo,
  toCircuitJSON,
  undo,
  useCircuitStore,
} from '../store/circuitStore'
import { useResultsStore, type OverlayMode } from '../store/resultsStore'
import { PlanCorner } from './PlanCorner'
import { LibraryDialog, SaveAsDialog } from './ProjectLibrary'

// A browser tab dies on JSON.parse of a few hundred MB long before the server
// ever sees the request, so the first size check has to happen here.
const MAX_PROJECT_BYTES = 32 * 1024 * 1024
const MAX_DSS_BYTES = 32 * 1024 * 1024

function tooBig(files: File[], limit: number): string | null {
  const total = files.reduce((n, f) => n + f.size, 0)
  if (total <= limit) return null
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `That is ${mb(total)}; the editor handles up to ${mb(limit)}.`
}

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
  const projectId = useCircuitStore((s) => s.projectId)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)

  const [samples, setSamples] = useState<SampleMeta[]>([])
  useEffect(() => {
    // Best effort: a missing sample list just hides the picker.
    api.samples().then((r) => setSamples(r.samples)).catch(() => {})
  }, [])

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

  const onExportJson = () => {
    download(`${name || 'circuit'}.oneline.json`, JSON.stringify(circuit(), null, 2))
    markSaved()
  }

  // --- the browser-local project library ---------------------------------

  const writeProject = async (id: string, chosenName: string) => {
    try {
      const st = useCircuitStore.getState()
      await saveProject(id, chosenName, toCircuitJSON(st))
      useCircuitStore.setState({ projectId: id, name: chosenName, dirty: false })
      flash(`Saved "${chosenName}"`, 'info', 2500)
    } catch (err) {
      flash(
        `Could not save in this browser (${err instanceof Error ? err.message : err}). ` +
          'Use Export .json to keep a copy as a file.',
        'error', 8000)
    }
  }

  // Save: silent once the circuit has a home; the first time, ask for a name.
  const onSave = () => {
    if (projectId) void writeProject(projectId, name.trim() || 'circuit')
    else setSaveAsOpen(true)
  }
  const onSaveAs = () => setSaveAsOpen(true)

  const onOpenFromLibrary = async (id: string) => {
    const st = useCircuitStore.getState()
    if (
      st.nodes.length > 0 &&
      st.dirty &&
      !window.confirm('Discard unsaved changes and open the saved circuit?')
    ) {
      return
    }
    try {
      const found = await loadProject(id)
      if (!found) {
        flash('That circuit is no longer in the library.')
        return
      }
      const { circuit: c, warning } = migrateCircuit(found.circuit)
      loadCircuit(c)
      useCircuitStore.setState({ projectId: id, dirty: false })
      useResultsStore.setState({ result: null, stale: false, issues: [] })
      setLibraryOpen(false)
      if (warning) flash(warning, 'info', 12000)
    } catch (err) {
      flash(`Could not open: ${err instanceof Error ? err.message : err}`)
    }
  }

  const onExportSaved = async (id: string) => {
    const found = await loadProject(id)
    if (found) download(`${found.meta.name}.oneline.json`, JSON.stringify(found.circuit, null, 2))
  }

  // Ctrl/Cmd+S saves, Shift adds "as", Ctrl/Cmd+O opens the library.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 's') {
        e.preventDefault()
        if (e.shiftKey) setSaveAsOpen(true)
        else onSave()
      } else if (k === 'o') {
        e.preventDefault()
        setLibraryOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // onSave reads the store directly; projectId/name are the only closed-over values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, name])

  const onOpenProject = async (file: File) => {
    const oversize = tooBig([file], MAX_PROJECT_BYTES)
    if (oversize) {
      flash(`Could not open project: ${oversize}`)
      return
    }
    try {
      const { circuit, warning } = migrateCircuit(JSON.parse(await file.text()))
      loadCircuit(circuit)
      // A file from disk is not a library entry until it is saved.
      useCircuitStore.setState({ projectId: null })
      setLibraryOpen(false)
      if (warning) flash(warning, 'info', 12000)
    } catch (err) {
      flash(`Could not open project: ${err instanceof Error ? err.message : err}`)
    }
  }

  const onOpenSample = async (id: string) => {
    const st = useCircuitStore.getState()
    if (
      st.nodes.length > 0 &&
      st.dirty &&
      !window.confirm('Discard unsaved changes and open the sample?')
    ) {
      return
    }
    try {
      const circuit = await api.sample(id)
      loadCircuit(circuit)
      useCircuitStore.setState({ dirty: false, projectId: null })
      useCircuitStore.temporal.getState().clear()
      useResultsStore.setState({ result: null, stale: false, issues: [] })
    } catch (err) {
      flash(`Could not open sample: ${err instanceof Error ? err.message : err}`)
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
    const oversize = tooBig(fileList, MAX_DSS_BYTES)
    if (oversize) {
      flash(`Could not import: ${oversize}`)
      return
    }
    try {
      const files = await Promise.all(
        fileList.map(async (f) => ({ name: f.name, text: await f.text() })),
      )
      const { circuit: imported, unsupported, warnings } = await api.importDss(files)
      autoLayout(imported)
      loadCircuit(imported)
      useCircuitStore.setState({ projectId: null })
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
          onClick={onSave}
          title={
            (dirty ? 'You have unsaved changes. ' : '') +
            (projectId
              ? 'Save to this browser (Ctrl+S)'
              : 'Save to this browser under a name (Ctrl+S)')
          }
        >
          Save{dirty ? ' •' : ''}
        </button>
        <button onClick={onSaveAs} title="Save a copy under a new name (Ctrl+Shift+S)">Save as…</button>
        <button onClick={() => setLibraryOpen(true)} title="Open a circuit saved in this browser (Ctrl+O)">
          Open…
        </button>
        {samples.length > 0 && (
          <select
            value=""
            title="Open a ready-made example circuit"
            onChange={(e) => {
              if (e.target.value) onOpenSample(e.target.value)
              e.target.value = ''
            }}
          >
            <option value="">Samples…</option>
            {samples.map((s) => (
              <option key={s.id} value={s.id} title={s.description}>
                {s.name} ({s.nodes} elements)
              </option>
            ))}
          </select>
        )}
        <button onClick={onExportJson} title="Download the project as a .oneline.json file (to move it or back it up)">
          Export .json
        </button>
        <button onClick={onExportDss} title="Export as a runnable OpenDSS .dss file">Export .dss</button>
        <button
          onClick={() => dssInput.current?.click()}
          title="Import OpenDSS .dss file(s) — select the main file plus anything it references (line codes, BusCoords csv)"
        >
          Import .dss
        </button>
      </div>
      <span className="tb-spacer" />
      <PlanCorner />
      {saveAsOpen && (
        <SaveAsDialog
          initialName={name.trim() || 'my-circuit'}
          onCancel={() => setSaveAsOpen(false)}
          onSave={(chosen) => {
            setSaveAsOpen(false)
            void writeProject(projectId && chosen === name ? projectId : newProjectId(), chosen)
          }}
        />
      )}
      {libraryOpen && (
        <LibraryDialog
          currentId={projectId}
          onOpen={(id) => void onOpenFromLibrary(id)}
          onExport={(id) => void onExportSaved(id)}
          onImportFile={() => projectInput.current?.click()}
          onClose={() => setLibraryOpen(false)}
        />
      )}
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
