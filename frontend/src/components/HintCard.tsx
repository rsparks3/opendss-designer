import { HINT_BY_ID } from '../lib/struggles'
import { useHintStore } from '../store/hintStore'

/**
 * The card that appears when the editor thinks someone is stuck (see
 * lib/struggles for when). One at a time; "Got it" retires that hint for
 * good, the close button hides it for now, and it goes away by itself when
 * the person does the thing it teaches.
 */
export function HintCard() {
  const active = useHintStore((s) => s.active)
  const dismiss = useHintStore((s) => s.dismiss)
  if (!active) return null
  const hint = HINT_BY_ID[active]
  return (
    <div className="struggle-hint" role="status" data-hint={active}>
      <span className="struggle-hint-icon" aria-hidden="true">
        💡
      </span>
      <div className="struggle-hint-text">
        <div className="struggle-hint-title">{hint.title}</div>
        <div className="struggle-hint-body">{hint.body}</div>
        <div className="struggle-hint-actions">
          <button type="button" onClick={() => dismiss(true)}>
            Got it
          </button>
          <span className="struggle-hint-note">Help hints can be turned off in Preferences.</span>
        </div>
      </div>
      <button
        type="button"
        className="struggle-hint-close"
        aria-label="Hide this hint for now"
        title="Hide for now"
        onClick={() => dismiss(false)}
      >
        ×
      </button>
    </div>
  )
}
