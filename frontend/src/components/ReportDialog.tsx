import { useEffect, useRef, useState } from 'react'
import { OVERLAY_LABELS } from '../lib/exportDiagram'
import { exportReport, sectionAvailability, type ReportFormat } from '../lib/report/exportReport'
import { SECTION_LABELS, type SectionKey } from '../lib/report/model'
import { useResultsStore } from '../store/resultsStore'
import { readFlag, useUiStore, writePref } from '../store/uiStore'

const ORDER: SectionKey[] = ['loadflow', 'diagram', 'shortcircuit', 'protection', 'timeseries']

const WHAT: Record<SectionKey, string> = {
  loadflow: 'Summary, abnormal conditions, bus voltages, branch flows, loads and generation, losses, voltage profile',
  diagram: 'The drawing, with its notes',
  shortcircuit: 'Three-phase and line-to-ground fault currents and impedances at every bus',
  protection: 'Device settings, operating times, interrupting duty, coordination findings, TCC plot',
  timeseries: 'Energy, losses, peak demand and the voltage extremes of the last run',
}

const FORMATS: [ReportFormat, string][] = [
  ['pdf', 'PDF'],
  ['xlsx', 'Excel workbook'],
  ['both', 'Both'],
]

const DEFAULT_ON: SectionKey[] = ['loadflow', 'diagram']

/** The choices made last time, in this browser. */
function remembered(): { format: ReportFormat; sections: Set<SectionKey> } {
  const format: ReportFormat = readFlag('report.xlsx', false)
    ? readFlag('report.pdf', true) ? 'both' : 'xlsx'
    : 'pdf'
  const sections = new Set(ORDER.filter((k) => readFlag(`report.${k}`, DEFAULT_ON.includes(k))))
  return { format, sections }
}

function remember(format: ReportFormat, sections: Set<SectionKey>) {
  writePref('report.pdf', format === 'xlsx' ? '0' : '1')
  writePref('report.xlsx', format === 'pdf' ? '0' : '1')
  for (const k of ORDER) writePref(`report.${k}`, sections.has(k) ? '1' : '0')
}

/** File → Export → Study report: pick the format and the sections. */
export function ReportDialog({ onClose }: { onClose: () => void }) {
  const [{ format, sections }, setChoice] = useState(remembered)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const openDialog = useUiStore((s) => s.openDialog)
  const overlay = useResultsStore((s) => s.overlay)
  const available = sectionAvailability()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  const chosen = ORDER.filter((k) => sections.has(k) && !available[k])
  const toggle = (k: SectionKey) => {
    const next = new Set(sections)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setChoice({ format, sections: next })
  }

  const run = async () => {
    setError(null)
    setBusy('Starting…')
    remember(format, sections)
    try {
      await exportReport({ format, sections: chosen, onProgress: setBusy })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="modal-box wide"
        role="dialog"
        aria-label="Study report"
        tabIndex={-1}
        ref={box}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
      >
        <div className="modal-title">Study report</div>
        <fieldset className="prefs-group">
          <legend>Format</legend>
          <div className="report-formats">
            {FORMATS.map(([f, label]) => (
              <label key={f} className="prefs-radio">
                <input
                  type="radio"
                  name="report-format"
                  checked={format === f}
                  onChange={() => setChoice({ format: f, sections })}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="prefs-group">
          <legend>Sections</legend>
          {ORDER.map((k) => {
            const why = available[k]
            return (
              <label key={k} className={`report-section${why ? ' disabled' : ''}`} title={why ?? undefined}>
                <input
                  type="checkbox"
                  checked={!why && sections.has(k)}
                  disabled={!!why}
                  onChange={() => toggle(k)}
                />
                <span>
                  <strong>{SECTION_LABELS[k]}</strong>
                  <span className="report-what">{why ?? WHAT[k]}</span>
                </span>
              </label>
            )
          })}
          <div className="library-note">
            The one-line is drawn with the overlay that is on
            {overlay === 'off' ? ' (none)' : ` (${OVERLAY_LABELS[overlay]})`}. A study not yet run is run
            first. The title block and the abnormal-condition limits are in{' '}
            <button type="button" className="link-button" onClick={() => openDialog('project')}>
              Project properties
            </button>
            .
          </div>
        </fieldset>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          {busy && <span className="report-busy" role="status">{busy}</span>}
          <button type="button" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="button" className="modal-primary" onClick={() => void run()} disabled={!!busy || !chosen.length}>
            Export
          </button>
        </div>
      </div>
    </div>
  )
}
