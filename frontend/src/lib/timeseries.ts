import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import type { TimeSeriesResult } from '../types/circuit'

type TsEvent =
  | { type: 'progress'; step: number; total: number }
  | { type: 'result'; result: TimeSeriesResult }
  | { type: 'error'; message: string }

/** Run a daily/yearly time series, streaming SSE progress into the results
 *  store. POSTs the circuit in the body, so this reads the response stream
 *  directly (EventSource can't POST). Returns true when a result landed. */
export async function runTimeSeries(mode: 'daily' | 'yearly', stepMin: 60 | 15): Promise<boolean> {
  const results = useResultsStore.getState()
  if (results.tsRunning || results.solving) return false
  const abort = new AbortController()
  results.setTsRunning(true, abort)

  try {
    const res = await fetch('/api/timeseries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        circuit: toCircuitJSON(useCircuitStore.getState()),
        mode,
        stepMin,
      }),
      signal: abort.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`timeseries failed: ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result: TimeSeriesResult | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        if (!block.startsWith('data: ')) continue
        const ev = JSON.parse(block.slice(6)) as TsEvent
        if (ev.type === 'progress') {
          useResultsStore.getState().setTsProgress({ step: ev.step, total: ev.total })
        } else if (ev.type === 'error') {
          throw new Error(ev.message)
        } else {
          result = ev.result
        }
      }
    }

    if (!result) throw new Error('The run ended without a result.')
    const store = useResultsStore.getState()
    if (result.converged) {
      store.setTimeseries(result)
      const s = result.summary
      if (s) {
        store.setFlash(
          `${result.steps} steps solved — ${(s.energyKwh / 1000).toFixed(1)} MWh served, ` +
            `${(s.lossesKwh / 1000).toFixed(2)} MWh losses, peak ${(s.peakKw / 1000).toFixed(2)} MW @ h ${s.peakHour}`,
          'info',
          8000,
        )
      }
      return true
    }
    if (result.cancelled) {
      store.setFlash('Time-series run cancelled.', 'info')
    } else if (result.nonConvergedSteps.length) {
      // Partial convergence: keep the result but warn.
      store.setTimeseries(result)
      store.setFlash(
        `${result.nonConvergedSteps.length}${result.nonConvergedSteps.length >= 50 ? '+' : ''} of ` +
          `${result.steps} steps did not converge — affected samples read 0.`,
      )
      return true
    } else {
      const firstError = result.issues.find((i) => i.severity === 'error')
      store.setFlash(firstError?.message ?? 'Time-series run failed.')
    }
    return false
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      useResultsStore.getState().setFlash('Time-series run cancelled.', 'info')
    } else if (err instanceof TypeError) {
      useResultsStore.getState().setFlash(
        'Time-series request failed — is the backend still running?',
      )
    } else {
      useResultsStore.getState().setFlash(`Time series: ${(err as Error).message}`)
    }
    return false
  } finally {
    useResultsStore.getState().setTsRunning(false)
  }
}
