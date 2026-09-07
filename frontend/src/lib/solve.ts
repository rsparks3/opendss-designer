import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { api } from './api'
import { firstError, mergeRunIssues } from './issues'

/** Run a snapshot power flow on the current circuit and publish the results.
 *  Shared by the Solve button and auto-solve. Returns false when the request
 *  itself failed (network/server), true otherwise. */
export async function runSolve(): Promise<boolean> {
  const results = useResultsStore.getState()
  // Skip while a time-series run holds the engine (the request would just
  // queue behind it server-side); auto-solve retries on the next edit.
  if (results.solving || results.tsRunning) return true
  results.setSolving(true)
  try {
    const result = await api.solve(toCircuitJSON(useCircuitStore.getState()))
    const store = useResultsStore.getState()
    store.setResult(result)
    if (result.busNames) useCircuitStore.getState().mergeBusNames(result.busNames)
    // Everything the engine refused on goes into the Problems list, and a
    // refusal also says so out loud: an enabled Solve that quietly produced
    // nothing was the worst failure mode this app had.
    store.setIssues(mergeRunIssues(store.issues, result.issues))
    if (!result.converged) {
      const why = firstError(result.issues)
      store.setFlash(why ? `Solve refused: ${why}` : 'The power flow did not converge.', 'error', 8000)
    }
    return true
  } catch (err) {
    // TypeError from fetch means the request never reached the server.
    const msg =
      err instanceof TypeError
        ? 'Solve request failed — is the backend still running?'
        : `Solve failed: ${err instanceof Error ? err.message : String(err)}`
    useResultsStore.getState().setFlash(msg)
    return false
  } finally {
    useResultsStore.getState().setSolving(false)
  }
}
