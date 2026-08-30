import { useEffect, useRef, useState } from 'react'
import { fmtSimHour } from '../lib/axis'
import { runTimeSeries } from '../lib/timeseries'
import { useResultsStore } from '../store/resultsStore'
import type { TimeSeriesResult } from '../types/circuit'

const PLAY_MS = 100 // playback tick: ~10 recorded steps per second

/** Hours covered by one scrub position of a downsampled run. */
function bucketHours(ts: TimeSeriesResult): number {
  const totalH = (ts.steps * ts.stepMin) / 60
  return totalH / (ts.time.length / 2)
}

/** Modal shown when a run comes back downsampled: scrubbing an envelope is
 *  importantly different from scrubbing exact hours, so say it plainly. */
function EnvelopeNotice({ ts, onClose }: { ts: TimeSeriesResult; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">This run is downsampled</div>
        <div className="nrel-note">
          Long runs are compressed for display: this {ts.mode} run's{' '}
          {ts.steps.toLocaleString()} steps were reduced to {ts.time.length}{' '}
          scrub positions of alternating minimum/maximum values, each covering
          about {bucketHours(ts).toFixed(0)} hours. Scrubbing shows those
          envelope extremes — <b>not the exact network state at a specific
          hour</b>. Voltage badges read the bucket's worst case, which is
          usually what planning studies need.
        </div>
        <div className="nrel-note">
          For exact hour-by-hour scrubbing, run a <b>Daily</b> simulation
          (24–96 steps, never downsampled).
        </div>
        <div className="modal-actions">
          <button className="modal-primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

/** Transport bar (visible in time-series analysis mode): run controls plus a
 *  scrubber that drives the canvas overlays through the recorded run. */
export function TimeBar() {
  const analysisMode = useResultsStore((s) => s.analysisMode)
  const ts = useResultsStore((s) => s.timeseries)
  const tsIndex = useResultsStore((s) => s.tsIndex)
  const setTsIndex = useResultsStore((s) => s.setTsIndex)
  const tsRunning = useResultsStore((s) => s.tsRunning)
  const tsProgress = useResultsStore((s) => s.tsProgress)
  const issues = useResultsStore((s) => s.issues)
  const [mode, setMode] = useState<'daily' | 'yearly'>('daily')
  const [step, setStep] = useState<60 | 15>(60)
  const [playing, setPlaying] = useState(false)
  const [notice, setNotice] = useState(false)
  const noticedFor = useRef<TimeSeriesResult | null>(null)

  // A freshly completed downsampled run gets the envelope explanation once.
  useEffect(() => {
    if (ts?.downsampled && noticedFor.current !== ts) {
      noticedFor.current = ts
      setNotice(true)
    }
    if (!ts) setPlaying(false)
  }, [ts])

  // Playback: advance one recorded step per tick, stop at the end.
  useEffect(() => {
    if (!playing || !ts) return
    const timer = window.setInterval(() => {
      const s = useResultsStore.getState()
      if (!s.timeseries) return
      const next = (s.tsIndex ?? -1) + 1
      if (next >= s.timeseries.time.length) {
        setPlaying(false)
      } else {
        s.setTsIndex(next)
      }
    }, PLAY_MS)
    return () => window.clearInterval(timer)
  }, [playing, ts])

  if (analysisMode !== 'timeseries') return null

  const hasErrors = issues.some((i) => i.severity === 'error')
  const pct = tsProgress ? Math.round((100 * tsProgress.step) / tsProgress.total) : 0
  const onRun = () =>
    void runTimeSeries(mode, step).then((ok) => {
      if (ok) useResultsStore.getState().requestGraphTab()
    })
  const togglePlay = () => {
    if (!ts) return
    // Pressing play at the end restarts from hour 0.
    if (!playing && tsIndex != null && tsIndex >= ts.time.length - 1) setTsIndex(0)
    setPlaying(!playing)
  }

  return (
    <div className="time-bar">
      <select value={mode} onChange={(e) => setMode(e.target.value as 'daily' | 'yearly')}
              disabled={tsRunning} title="Time-series horizon">
        <option value="daily">Daily</option>
        <option value="yearly">Yearly</option>
      </select>
      <select value={String(step)} onChange={(e) => setStep(Number(e.target.value) as 60 | 15)}
              disabled={tsRunning} title="Step size">
        <option value="60">1 h</option>
        <option value="15">15 min</option>
      </select>
      {tsRunning ? (
        <button className="ts-run running"
                onClick={() => useResultsStore.getState().tsAbort?.abort()}
                title="Cancel the run">
          {pct}% ✕
        </button>
      ) : (
        <button className="ts-run" onClick={onRun} disabled={hasErrors}
                title={hasErrors
                  ? 'Fix the errors in the problems list first'
                  : 'Run the simulation (assign loadshapes in the Shapes tab first)'}>
          ▶ Run
        </button>
      )}
      <button className="tb-play" onClick={togglePlay} disabled={!ts}
              title={ts ? (playing ? 'Pause' : 'Play through the run') : 'Run a simulation first'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <input
        type="range"
        className="tb-scrub"
        min={0}
        max={ts ? ts.time.length - 1 : 0}
        value={tsIndex ?? 0}
        disabled={!ts}
        onChange={(e) => setTsIndex(Number(e.target.value))}
        title={ts ? 'Scrub through the recorded run' : 'Run a simulation first'}
      />
      <span className="tb-readout">
        {ts && tsIndex != null ? fmtSimHour(ts.time[tsIndex], ts.mode) : '— run to scrub —'}
      </span>
      {ts?.downsampled && (
        <button className="tb-envelope" onClick={() => setNotice(true)}
                title="Downsampled run: each scrub position is a min/max envelope bucket — click for details">
          ⓘ envelope ≈{bucketHours(ts).toFixed(0)} h
        </button>
      )}
      {notice && ts && <EnvelopeNotice ts={ts} onClose={() => setNotice(false)} />}
    </div>
  )
}
