import { useFeatureLock } from '../lib/instance'
import type { FeatureKey } from '../lib/api'

/**
 * One line at the top of a panel whose feature the hosted plan withholds,
 * in the proxy's own words (which plan has it, where to upgrade). Nothing
 * renders on a local install, or on a plan that has the feature; the
 * buttons stay live either way, and a click gets the same sentence back
 * as a 403 from the server.
 */
export function LockedNote({ feature }: { feature: FeatureKey }) {
  const reason = useFeatureLock(feature)
  if (!reason) return null
  return (
    <div className="locked-note" role="note">
      <span aria-hidden="true">🔒</span> {reason}
    </div>
  )
}
