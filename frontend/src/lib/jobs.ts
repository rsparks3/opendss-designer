import type { JobSnapshot } from '../types/circuit'

/**
 * Background studies. A study is started with one POST, which answers at
 * once with a job; its progress and result then stream from the job's
 * events endpoint. A client that loses the stream can read the result back
 * later with `fetchJob`, since the server keeps the last few.
 */

export interface JobProgress {
  done: number
  total: number
  message: string | null
}

async function postJob(path: string, body: unknown): Promise<JobSnapshot> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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
  return ((await res.json()) as { job: JobSnapshot }).job
}

export async function fetchJob<T>(id: string): Promise<JobSnapshot<T>> {
  const res = await fetch(`/api/jobs/${id}`)
  if (!res.ok) throw new Error(`job ${id}: ${res.status}`)
  return res.json() as Promise<JobSnapshot<T>>
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
}

/** Start a study and follow it to the end. Resolves with the result,
 *  rejects with the job's error (or 'cancelled'). */
export async function runJob<T>(
  path: string,
  body: unknown,
  opts: { onProgress?: (p: JobProgress) => void; onStarted?: (job: JobSnapshot) => void; signal?: AbortSignal } = {},
): Promise<T> {
  const job = await postJob(path, body)
  opts.onStarted?.(job)
  const abort = opts.signal
  if (abort) {
    abort.addEventListener('abort', () => void cancelJob(job.id), { once: true })
  }
  const res = await fetch(`/api/jobs/${job.id}/events`, { signal: abort })
  if (!res.ok || !res.body) throw new Error(`job ${job.id}: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: JobSnapshot<T> | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      if (!block.startsWith('data: ')) continue
      const ev = JSON.parse(block.slice(6)) as JobSnapshot<T> & { type: 'progress' | 'result' }
      if (ev.type === 'progress') opts.onProgress?.(ev.progress)
      else final = ev
    }
  }
  if (!final) {
    // The stream closed early (a proxy, a sleeping tab): ask for the job.
    final = await fetchJob<T>(job.id)
    if (final.status === 'running' || final.status === 'queued') {
      throw new Error('The study is still running on the server; check back for its result.')
    }
  }
  if (final.status === 'cancelled') throw new Error('cancelled')
  if (final.status !== 'done' || final.result === undefined) throw new Error(final.error ?? 'The study failed.')
  return final.result
}
