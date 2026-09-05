import type { HealthInfo } from './api'

/**
 * What the instance banner should say, derived purely from `/api/health`.
 *
 * The app has no idea what an account or a plan *is*. A hosted gateway may
 * describe the caller's plan in the health payload (name, a usage message,
 * links such as "Sign in" or "Upgrade"), and this renders those strings.
 * Without a plan block the wording falls back to the generic hosted-instance
 * text. A local install returns `null`: no banner at all.
 */
export interface BannerLink {
  label: string
  url: string
}

export interface BannerText {
  title: string
  body: string
  links: BannerLink[]
}

export function describeInstance(health: HealthInfo | null): BannerText | null {
  if (!health) return null
  const plan = health.plan
  if (!plan && health.mode !== 'demo') return null

  const maxNodes = health.limits?.maxNodes
  const sizeNote = maxNodes
    ? `Circuits are limited to ${maxNodes.toLocaleString()} elements and long time-series runs are capped.`
    : 'This instance runs with size and time limits.'
  if (plan) {
    return {
      title: `${plan.name} plan.`,
      body: [plan.message, sizeNote].filter(Boolean).join(' '),
      links: (plan.links ?? []).filter(isSafeLink),
    }
  }
  return { title: 'Hosted instance.', body: sizeNote, links: [] }
}

/**
 * The permanent toolbar corner: the plan name plus its links ("Guest · Sign
 * in", "Free plan · Account"). Unlike the banner it cannot be dismissed, so a
 * visitor who closed the banner can still find the way in. `null` on a local
 * install, or when there is nothing to link to.
 */
export function describeCorner(health: HealthInfo | null): { label: string; links: BannerLink[] } | null {
  const plan = health?.plan
  if (!plan) return null
  const links = (plan.links ?? []).filter(isSafeLink)
  if (links.length === 0) return null
  return { label: `${plan.name} plan`, links }
}

/** Belt to the server's braces: only web links ever become an href. */
function isSafeLink(link: BannerLink): boolean {
  return link.url.startsWith('https://') || link.url.startsWith('/')
}
