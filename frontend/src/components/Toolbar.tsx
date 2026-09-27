import { chooseOverlay, save } from '../lib/fileActions'
import { OVERLAY_CHOICES, solveNow, toggleAutoSolve } from '../lib/menus'
import { redo, undo, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'

/**
 * The row under the menu bar: only what gets pressed all day. Everything
 * else, and everything here too, is in the menus.
 */
export function Toolbar() {
  const name = useCircuitStore((s) => s.name)
  const setName = useCircuitStore((s) => s.setName)
  const dirty = useCircuitStore((s) => s.dirty)
  const projectId = useCircuitStore((s) => s.projectId)

  const solving = useResultsStore((s) => s.solving)
  const tsRunning = useResultsStore((s) => s.tsRunning)
  const analysisMode = useResultsStore((s) => s.analysisMode)
  const setAnalysisMode = useResultsStore((s) => s.setAnalysisMode)
  const overlay = useResultsStore((s) => s.overlay)
  const issues = useResultsStore((s) => s.issues)
  const autoSolve = useResultsStore((s) => s.autoSolve)

  const hasErrors = issues.some((i) => i.severity === 'error')
  // Individual snapshot runs are disabled in time-series mode (the transport
  // bar under the toolbar owns solving there).
  const tsMode = analysisMode === 'timeseries'

  return (
    <div className="toolbar">
      <input
        className="circuit-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        title="Circuit name"
      />
      {dirty && (
        <button
          type="button"
          className="tb-dirty"
          onClick={save}
          title={projectId ? 'Save to this browser (Ctrl+S)' : 'Save to this browser under a name (Ctrl+S)'}
        >
          Unsaved changes
        </button>
      )}
      <div className="tb-group">
        <button onClick={() => undo()} title="Undo (Ctrl+Z)">↩ Undo</button>
        <button onClick={() => redo()} title="Redo (Ctrl+Y)">↪ Redo</button>
      </div>
      <div className="tb-group">
        <button
          className="solve-btn"
          onClick={solveNow}
          disabled={solving || hasErrors || tsRunning || tsMode}
          title={
            tsMode
              ? 'Individual runs disabled in time series mode'
              : hasErrors
                ? 'Fix the errors in the problems list first'
                : 'Run a snapshot power flow of the base case (F5): loads at rated kW, ' +
                  'PV at its irradiance parameter, storage idle. Loadshapes only ' +
                  'apply to time-series runs.'
          }
        >
          {solving ? 'Solving…' : '▶ Solve'}
        </button>
        <button
          className={autoSolve && !tsMode ? 'active' : ''}
          disabled={tsMode}
          onClick={toggleAutoSolve}
          title={
            tsMode
              ? 'Individual runs disabled in time series mode'
              : 'Auto-solve: re-run the power flow automatically whenever the circuit changes'
          }
        >
          Auto
        </button>
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
      <div className="tb-group overlay-group">
        <span className="tb-label">Overlay:</span>
        {OVERLAY_CHOICES.map((o) => (
          <button
            key={o.mode}
            className={overlay === o.mode ? 'active' : ''}
            onClick={() => chooseOverlay(o.mode)}
            title={o.title}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
