import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { api } from './api'

const SOLVE_ISSUE_CODES = new Set(['dss-error', 'not-converged', 'solve-failed'])

/** Run a snapshot power flow on the current circuit and publish the results.
 *  Shared by the Solve button and auto-solve. Returns false when the request
 *  itself failed (network/server), true otherwise. */
export async function runSolve(): Promise<boolean> {
  const results = useResultsStore.getState()
  if (results.solving) return true
  results.setSolving(true)
  try {
    const result = await api.solve(toCircuitJSON(useCircuitStore.getState()))
    const store = useResultsStore.getState()
    store.setResult(result)
    if (result.busNames) useCircuitStore.getState().mergeBusNames(result.busNames)
    const solveIssues = result.issues.filter(
      (i) => i.severity === 'error' || SOLVE_ISSUE_CODES.has(i.code),
    )
    store.setIssues([
      ...store.issues.filter((i) => !SOLVE_ISSUE_CODES.has(i.code)),
      ...solveIssues.filter((i) => SOLVE_ISSUE_CODES.has(i.code)),
    ])
    return true
  } catch {
    return false
  } finally {
    useResultsStore.getState().setSolving(false)
  }
}
