import { describe, expect, it } from 'vitest'
import type { Issue } from '../types/circuit'
import { firstError, mergeRunIssues } from './issues'

const err = (code: string, message: string, nodeId?: string): Issue =>
  ({ severity: 'error', code, message, nodeId }) as Issue
const warn = (code: string, message: string): Issue => ({ severity: 'warning', code, message }) as Issue

describe('mergeRunIssues', () => {
  it('keeps what validation found and adds the engine refusal', () => {
    const existing = [warn('default-rating', 'LN1 uses a default rating')]
    const fromRun = [err('missing-loadshape', "Load 'L1' references loadshape 'ghost'", 'ld')]
    expect(mergeRunIssues(existing, fromRun)).toEqual([...existing, ...fromRun])
  })

  it('replaces stale solve-only issues but never drops validation ones', () => {
    const existing = [err('unconnected-terminal', 'x', 'n1'), err('not-converged', 'old')]
    const merged = mergeRunIssues(existing, [err('dss-error', 'new')])
    expect(merged.map((i) => i.code)).toEqual(['unconnected-terminal', 'dss-error'])
  })

  it('ignores run warnings and de-duplicates', () => {
    const existing = [err('missing-loadshape', 'same', 'ld')]
    const merged = mergeRunIssues(existing, [
      err('missing-loadshape', 'same', 'ld'),
      warn('default-rating', 'ignored'),
    ])
    expect(merged).toHaveLength(1)
  })

  it('reports the first error message', () => {
    expect(firstError([warn('a', 'w'), err('b', 'boom')])).toBe('boom')
    expect(firstError([warn('a', 'w')])).toBeNull()
  })
})
