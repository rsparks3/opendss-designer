import { useEffect, useRef, useState } from 'react'
import { DEFAULT_LIMITS, EMPTY_STUDY, limitsOf, limitsProblem, sameLimits, studyIsEmpty } from '../lib/limits'
import { useCircuitStore } from '../store/circuitStore'
import type { LimitsJSON, StudyInfoJSON } from '../types/circuit'

const STUDY_FIELDS: [keyof StudyInfoJSON, string][] = [
  ['title', 'Study title'],
  ['caseName', 'Case'],
  ['engineer', 'Engineer'],
  ['company', 'Company'],
]

const LIMIT_FIELDS: [keyof LimitsJSON, string, string][] = [
  ['vminPu', 'Undervoltage below', 'pu'],
  ['vmaxPu', 'Overvoltage above', 'pu'],
  ['warnPct', 'Loading warning at', '%'],
  ['overloadPct', 'Overload at', '%'],
]

/** File → Project properties: the study report's title block, and the
 *  planning criteria every overlay, legend and report applies. Both save
 *  with the project. The study info is cosmetic; new limits re-flag the
 *  results, so they are applied together rather than keystroke by keystroke. */
export function ProjectDialog({ onClose }: { onClose: () => void }) {
  const study = useCircuitStore((s) => s.study) ?? EMPTY_STUDY
  const setStudy = useCircuitStore((s) => s.setStudy)
  const stored = useCircuitStore((s) => s.limits)
  const setLimits = useCircuitStore((s) => s.setLimits)
  const [draft, setDraft] = useState<Record<keyof LimitsJSON, string>>(() => asText(limitsOf(stored)))
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  const parsed: LimitsJSON = {
    vminPu: Number(draft.vminPu),
    vmaxPu: Number(draft.vmaxPu),
    warnPct: Number(draft.warnPct),
    overloadPct: Number(draft.overloadPct),
  }
  const problem = limitsProblem(parsed)
  const changed = !problem && !sameLimits(parsed, limitsOf(stored))

  const edit = (key: keyof StudyInfoJSON, value: string | boolean) => {
    const next = { ...study, [key]: value }
    setStudy(studyIsEmpty(next) ? null : next)
  }
  const apply = () => {
    if (!changed) return
    // The defaults are stored as nothing, so a project that never changed
    // them follows any later change to what the defaults are.
    setLimits(sameLimits(parsed, DEFAULT_LIMITS) ? null : parsed)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box wide"
        role="dialog"
        aria-label="Project properties"
        tabIndex={-1}
        ref={box}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-title">Project properties</div>
        <fieldset className="prefs-group">
          <legend>Study</legend>
          <div className="project-grid">
            {STUDY_FIELDS.map(([key, label]) => (
              <label key={key}>
                {label}
                <input value={String(study[key] ?? '')} maxLength={200} onChange={(e) => edit(key, e.target.value)} />
              </label>
            ))}
          </div>
          <label>
            Description
            <textarea
              rows={3}
              value={study.description}
              maxLength={4000}
              onChange={(e) => edit('description', e.target.value)}
            />
          </label>
          <label className="prefs-radio">
            <input type="checkbox" checked={study.sheet === true} onChange={(e) => edit('sheet', e.target.checked)} />
            Sheet border and title block on exported images
          </label>
          <div className="library-note">
            Printed in the title block of study reports and, with the box ticked, in the corner of every
            SVG and PNG export, inside a drawing border.
          </div>
        </fieldset>
        <fieldset className="prefs-group">
          <legend>Abnormal-condition limits</legend>
          <div className="project-grid">
            {LIMIT_FIELDS.map(([key, label, unit]) => (
              <label key={key}>
                {label} ({unit})
                <input
                  type="number"
                  step={unit === 'pu' ? 0.005 : 5}
                  aria-label={label}
                  value={draft[key]}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && apply()}
                />
              </label>
            ))}
          </div>
          {problem && <div className="modal-error">{problem}</div>}
          <div className="library-note">
            Used by the voltage and loading overlays, their legends, the solve's violation flags and
            study reports. The defaults are ANSI C84.1 Range A (0.95–1.05 pu) and 100 % of rating.
          </div>
          <div className="project-buttons">
            <button type="button" disabled={!changed} onClick={apply}>
              Apply limits
            </button>
            <button
              type="button"
              disabled={sameLimits(limitsOf(stored), DEFAULT_LIMITS) && sameLimits(parsed, DEFAULT_LIMITS)}
              onClick={() => {
                setDraft(asText(DEFAULT_LIMITS))
                setLimits(null)
              }}
            >
              Use the defaults
            </button>
          </div>
        </fieldset>
        <div className="modal-actions">
          <button type="button" className="modal-primary" onClick={() => { apply(); onClose() }}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function asText(l: LimitsJSON): Record<keyof LimitsJSON, string> {
  return {
    vminPu: String(l.vminPu),
    vmaxPu: String(l.vmaxPu),
    warnPct: String(l.warnPct),
    overloadPct: String(l.overloadPct),
  }
}
