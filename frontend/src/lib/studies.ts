import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore, type StudyKey } from '../store/resultsStore'
import { runJob } from './jobs'

/**
 * The M14 studies: each runs on the current circuit (open scenario, active
 * level), as a background job or a direct call, and lands its result in
 * the results store under its key, where the Studies tab and the report
 * read it. The result shapes are those of `opendss_designer.studies`.
 */

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) {
    const text = await res.text()
    let detail = text
    try {
      detail = JSON.parse(text).detail ?? text
    } catch {
      // not JSON
    }
    throw new Error(detail || `${path} failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

type Body = Record<string, unknown>

/** Run `key` as a job (when `job`) or a direct call, keeping the result. */
export async function runStudy(key: StudyKey, path: string, body: Body, job: boolean): Promise<boolean> {
  const rs = useResultsStore.getState()
  if (rs.studyRunning[key]) return false
  const abort = new AbortController()
  rs.setStudyRunning(key, true, abort)
  const circuit = toCircuitJSON(useCircuitStore.getState())
  try {
    const result = job
      ? await runJob<{ converged?: boolean; issues?: { severity: string; message: string }[] }>(path, { circuit, ...body }, {
          signal: abort.signal,
          onProgress: (p) => useResultsStore.getState().setStudyProgress(key, p),
        })
      : await post<{ converged?: boolean; issues?: { severity: string; message: string }[] }>(path, { circuit, ...body })
    const store = useResultsStore.getState()
    // A study that cannot fail to converge (the QA report) carries no flag.
    if (result.converged === false) {
      const why = result.issues?.find((i) => i.severity === 'error')?.message
      store.setFlash(why ? `${LABELS[key]}: ${why}` : `${LABELS[key]}: nothing could be evaluated.`)
      return false
    }
    store.setStudy(key, result)
    return true
  } catch (err) {
    const msg = (err as Error).message
    useResultsStore.getState().setFlash(
      msg === 'cancelled' ? `${LABELS[key]} cancelled.` : `${LABELS[key]}: ${msg}`,
      msg === 'cancelled' ? 'info' : 'error',
    )
    return false
  } finally {
    useResultsStore.getState().setStudyRunning(key, false)
  }
}

export const LABELS: Record<StudyKey, string> = {
  n1: 'N-1 contingency',
  transfer: 'Transfer capability',
  switching: 'Switching sequence',
  sweep: 'Setting sweep',
  cvr: 'CVR evaluation',
  placement: 'Capacitor placement',
  balance: 'Phase balance',
  losses: 'Loss evaluation',
  capacity: 'Capacity',
  qa: 'Model QA',
  tlm: 'Service transformers',
}

export const fmtKw = (kw: number | null | undefined) =>
  kw == null ? '—' : kw >= 1000 ? `${(kw / 1000).toFixed(2)} MW` : `${kw.toFixed(0)} kW`
export const fmtPu = (v: number | null | undefined, d = 3) => (v == null ? '—' : v.toFixed(d))
export const fmtPct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v.toFixed(d)} %`)
