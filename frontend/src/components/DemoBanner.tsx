import { useEffect, useState } from 'react'
import { api, type HealthInfo } from '../lib/api'

const DISMISS_KEY = 'opendss-designer.demoBannerDismissed'

/**
 * Shown only on a hosted demo instance (`/api/health` reports mode "demo").
 * A local `pip install` renders nothing at all, which keeps demo mode's rule
 * that it only ever adds constraints and never changes the desktop experience.
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

  if (!health || health.mode !== 'demo' || dismissed) return null

  const maxNodes = health.limits?.maxNodes
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
        <strong>Public demo.</strong>{' '}
        {maxNodes
          ? `Circuits are limited to ${maxNodes.toLocaleString()} elements and long time-series runs are capped. `
          : 'This instance runs with size and time limits. '}
        Nothing you draw is saved on the server — it stays in this browser.
      </span>
      <span className="demo-banner-links">
        <a href="https://opendssdesigner.ryanmsparks.com" target="_blank" rel="noreferrer">
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
