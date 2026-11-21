import { chooseOverlay, save } from '../lib/fileActions'
import { OVERLAY_CHOICES, solveNow, toggleAutoSolve } from '../lib/menus'
import { redo, undo, useCircuitStore } from '../store/circuitStore'
import { signalStruggle } from '../store/hintStore'
import { useResultsStore } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import { listed } from '../lib/scenarios'

/**
 * The row under the menu bar: only what gets pressed all day. Everything
 * else, and everything here too, is in the menus.
 */
/** Overlays reached from their own tab and the Analysis menu rather than
 *  the toolbar, which stays one row high. */
// Kept to the Analysis → Overlay menu: the toolbar must stay one row at 1280 px.
const STUDY_OVERLAYS = new Set(['compare', 'hosting', 'islands', 'duty'])

export function Toolbar() {
  const name = useCircuitStore((s) => s.name)
  const setName = useCircuitStore((s) => s.setName)
  const dirty = useCircuitStore((s) => s.dirty)
  const projectId = useCircuitStore((s) => s.projectId)
  const linkedFile = useUiStore((s) => s.fileHandle?.name)
  const levels = useCircuitStore((s) => s.loadLevels)
  const activeLevel = useCircuitStore((s) => s.activeLevel)
  const setActiveLevel = useCircuitStore((s) => s.setActiveLevel)
  const scenarios = listed(useCircuitStore((s) => s.scenarios))
  const activeScenario = useCircuitStore((s) => s.activeScenario)
  const activateScenario = useCircuitStore((s) => s.activateScenario)

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
      {linkedFile && (
        <span className="tb-file" title="Linked file: File → Save to file (Ctrl+Alt+S) writes back over it">
          {linkedFile}
        </span>
      )}
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
        <span className="solve-wrap">
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
          {hasErrors && !tsMode && (
            // A disabled button swallows its clicks; this catches them so a
            // second press can say where the errors are (lib/struggles).
            <span
              className="solve-blocked"
              title="Fix the errors in the problems list first"
              onClick={() => signalStruggle('solve-blocked')}
            />
          )}
        </span>
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
      {(levels?.length || scenarios.length > 0) && (
        <div className="tb-group tb-planning">
          {levels?.length ? (
            <select
              className="tb-level"
              aria-label="Load level"
              title="The load condition the next solve runs at (Project properties → Load levels)"
              value={activeLevel ?? ''}
              onChange={(e) => setActiveLevel(e.target.value || null)}
            >
              <option value="">Rated</option>
              {levels.map((l) => (
                <option key={l.name} value={l.name}>{l.name}</option>
              ))}
            </select>
          ) : null}
          {scenarios.length > 0 && (
            <select
              className={`tb-level${activeScenario ? ' tb-scenario-on' : ''}`}
              aria-label="Scenario"
              title={activeScenario ? 'Edits belong to this scenario until you return to the base case' : 'Open a scenario to edit and solve it'}
              value={activeScenario ?? ''}
              onChange={(e) => activateScenario(e.target.value || null)}
            >
              <option value="">Base case</option>
              {scenarios.map((sc) => (
                <option key={sc.id} value={sc.id}>{sc.name}</option>
              ))}
            </select>
          )}
        </div>
      )}
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
        {OVERLAY_CHOICES.filter((o) => !STUDY_OVERLAYS.has(o.mode)).map((o) => (
          <button
            key={o.mode}
            className={overlay === o.mode ? 'active' : ''}
            onClick={() => {
              const rs = useResultsStore.getState()
              if (rs.result && rs.stale && rs.analysisMode !== 'timeseries') signalStruggle('overlay-stale')
              chooseOverlay(o.mode)
            }}
            title={o.title}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
