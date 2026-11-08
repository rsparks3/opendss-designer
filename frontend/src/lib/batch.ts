import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { BatchResult } from '../types/circuit'
import { runJob } from './jobs'

/** Solve every scenario at every load level as a background job and keep
 *  the matrix in the results store. Returns true when a result landed. */
export async function runBatch(): Promise<boolean> {
  const rs = useResultsStore.getState()
  if (rs.batchRunning) return false
  const abort = new AbortController()
  rs.setBatchRunning(true, abort)
  try {
    const result = await runJob<BatchResult>(
      '/api/jobs/batch',
      { circuit: toCircuitJSON(useCircuitStore.getState()) },
      {
        signal: abort.signal,
        onProgress: (p) => useResultsStore.getState().setBatchProgress(p),
      },
    )
    const store = useResultsStore.getState()
    store.setBatch(result)
    const bad = result.cells.filter((c) => !c.converged).length
    store.setFlash(
      `${result.solves} case${result.solves === 1 ? '' : 's'} solved` +
        (bad ? `, ${bad} did not converge` : '') +
        (result.cancelled ? ' (cancelled part way)' : ''),
      bad ? 'error' : 'info',
      6000,
    )
    return true
  } catch (err) {
    const msg = (err as Error).message
    useResultsStore.getState().setFlash(msg === 'cancelled' ? 'Batch run cancelled.' : `Batch run: ${msg}`, msg === 'cancelled' ? 'info' : 'error')
    return false
  } finally {
    useResultsStore.getState().setBatchRunning(false)
  }
}
