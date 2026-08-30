import { useState } from 'react'
import { useResultsStore } from '../store/resultsStore'

export function ProblemsPanel() {
  const issues = useResultsStore((s) => s.issues)
  const result = useResultsStore((s) => s.result)
  const stale = useResultsStore((s) => s.stale)
  const [open, setOpen] = useState(true)

  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors

  return (
    <div className="problems-panel">
      {result && (
        <div className="status-line" style={{ opacity: stale ? 0.5 : 1 }}>
          {result.converged
            ? `✓ Converged in ${result.iterations} iteration${result.iterations === 1 ? '' : 's'}` +
              (result.losses ? ` — losses ${result.losses.kw.toFixed(1)} kW` : '') +
              (stale ? ' (stale — re-solve)' : '')
            : '✗ Not converged'}
        </div>
      )}
      {issues.length > 0 && (
        <>
          <button className="problems-toggle" onClick={() => setOpen(!open)}>
            {errors > 0 && <span className="err-count">{errors} error{errors === 1 ? '' : 's'}</span>}
            {warnings > 0 && <span className="warn-count">{warnings} warning{warnings === 1 ? '' : 's'}</span>}
            {open ? ' ▾' : ' ▸'}
          </button>
          {open && (
            <ul className="problems-list">
              {issues.map((i, k) => (
                <li key={k} className={i.severity}>
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
