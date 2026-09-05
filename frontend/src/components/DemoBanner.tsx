import { useEffect, useState } from 'react'
import { api, type HealthInfo } from '../lib/api'
import { describeInstance } from '../lib/plan'

const DISMISS_KEY = 'opendss-designer.demoBannerDismissed'

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
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false // storage unavailable — showing the banner is the safe default
    }
  })

  useEffect(() => {
    // Best effort: if health is unreachable the app still works, so failing
    // here must not block the editor from loading.
    api.health().then(setHealth).catch(() => {})
  }, [])

  const text = describeInstance(health)
  if (!text || dismissed) return null

  const onDismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
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
