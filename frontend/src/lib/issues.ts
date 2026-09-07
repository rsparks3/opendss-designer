import type { Issue } from '../types/circuit'

/** Codes that only a solve can produce; validation never emits them. */
export const SOLVE_ISSUE_CODES = new Set(['dss-error', 'not-converged', 'solve-failed'])

/**
 * Fold the issues a solve or time-series run returned into the Problems
 * list. Validation owns the list and rewrites it on the next edit; between
 * edits this keeps what validation found and adds anything the engine
 * refused on, so a refusal is never silent.
 *
 * Before this, a refused solve only kept the three solve-specific codes, so
 * a compiler-level error such as a load pointing at a deleted load shape
 * left the diagram with no result, no overlay and no message at all.
 */
export function mergeRunIssues(existing: Issue[], fromRun: Issue[]): Issue[] {
  const base = existing.filter((i) => !SOLVE_ISSUE_CODES.has(i.code))
  const seen = new Set(base.map(key))
  const added = fromRun.filter(
    (i) => (i.severity === 'error' || SOLVE_ISSUE_CODES.has(i.code)) && !seen.has(key(i)),
  )
  return [...base, ...added]
}

/** The first error's message, for a toast; null when there is none. */
export function firstError(issues: Issue[]): string | null {
  return issues.find((i) => i.severity === 'error')?.message ?? null
}

function key(i: Issue): string {
  return `${i.code}|${i.nodeId ?? ''}|${i.edgeId ?? ''}|${i.message}`
}
