import { useState } from 'react'
import { useInstanceHealth } from '../lib/instance'
import { describeInstance } from '../lib/plan'

const DISMISS_KEY = 'opendss-designer.demoBannerDismissed'

/**
 * A dismissal is remembered per banner *title*, so dismissing the guest
 * banner does not hide the one that appears after signing in (or after a
 * plan change).
 */
function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY)
  } catch {
    return null // storage unavailable — showing the banner is the safe default
  }
}

/**
 * Shown only on a hosted instance: `/api/health` reports mode "demo", or a
 * gateway in front has described the caller's plan. A local `pip install`
 * renders nothing at all, which keeps demo mode's rule that it only ever adds
 * constraints and never changes the desktop experience.
 *
 * The wording comes from `describeInstance`: the app renders plan strings it
 * is handed and has no notion of accounts itself.
 */
export function DemoBanner() {
  const health = useInstanceHealth()
  const [dismissed, setDismissed] = useState<string | null>(readDismissed)

  const text = describeInstance(health)
  if (!text) return null
  // '1' is what older builds stored; it only ever meant the generic banner.
  if (dismissed === text.title || (dismissed === '1' && text.title === 'Hosted instance.')) return null

  const onDismiss = () => {
    setDismissed(text.title)
    try {
      localStorage.setItem(DISMISS_KEY, text.title)
    } catch {
      // storage unavailable — it will reappear next visit, which is fine
    }
  }

  return (
    <div className="demo-banner" role="status">
      <span>
        <strong>{text.title}</strong> {text.body}
      </span>
      <span className="demo-banner-links">
        {text.links.map((link) => (
          <a key={link.url} href={link.url}>
            {link.label}
          </a>
        ))}
        <a href="https://opendssdesigner-docs.ryanmsparks.com" target="_blank" rel="noreferrer">
          Docs
        </a>
        <a href="https://github.com/rsparks3/opendss-designer" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <code>pip install opendss-designer</code>
      </span>
      <button type="button" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
