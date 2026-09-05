import { useInstanceHealth } from '../lib/instance'
import { describeCorner } from '../lib/plan'

/**
 * Top-right of the toolbar on a hosted instance: "Guest plan · Sign in" or
 * "Free plan · Account". Always visible, unlike the dismissable banner, so
 * the way to sign in never disappears. Renders nothing on a local install.
 */
export function PlanCorner() {
  const corner = describeCorner(useInstanceHealth())
  if (!corner) return null
  return (
    <div className="tb-plan" role="navigation" aria-label="Account">
      <span className="tb-plan-name">{corner.label}</span>
      {corner.links.map((link) => (
        <a key={link.url} href={link.url} className="tb-plan-link">
          {link.label}
        </a>
      ))}
    </div>
  )
}
