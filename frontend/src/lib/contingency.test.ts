import { describe, expect, it } from 'vitest'
import type { N1Case } from '../types/circuit'
import { estimateN1Solves, n1CaseName, n1CaseOverrides, n1Candidates, tieIds } from './contingency'

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, data: { params } })

const NODES = [
  node('b1', 'breaker', { closed: true }),
  node('b2', 'breaker', { closed: true, tags: ['Feeder-Head'] }),
  node('tie', 'breaker', { closed: false, tie: true }),
  node('open', 'breaker', { closed: false }),
  node('f1', 'fuse'),
  node('t1', 'transformer'),
  node('r1', 'regulator', { enabled: false }),
  node('ld', 'load'),
]
const EDGES = [{ id: 'ln1', type: 'line', data: { params: {} } }, { id: 'w1', type: 'wire', data: { params: {} } }]

describe('N-1 estimate', () => {
  it('counts candidates as the backend does', () => {
    expect(tieIds(NODES)).toEqual(['tie'])
    expect(n1Candidates(NODES, EDGES, { candidates: 'switches' })).toBe(3) // b1, b2, f1 (open ones and the tie are not)
    expect(n1Candidates(NODES, EDGES, { candidates: 'transformers' })).toBe(1) // r1 is out of service
    expect(n1Candidates(NODES, EDGES, { candidates: 'all' })).toBe(5)
    expect(n1Candidates(NODES, EDGES, { candidates: 'switches', excludeTags: ['feeder-head'] })).toBe(2)
    expect(estimateN1Solves(NODES, EDGES, { candidates: 'switches' })).toBe(1 + 3 * 2)
  })

  it('takes every open breaker as a tie when none is marked', () => {
    const unmarked = NODES.map((n) => (n.id === 'tie' ? node('tie', 'breaker', { closed: false }) : n))
    expect(tieIds(unmarked)).toEqual(['tie', 'open'])
  })
})

describe('a row on the drawing', () => {
  const base = { base: { standbyRunning: [] } } as never
  const row = (more: Partial<N1Case>): N1Case => ({
    id: 'b1', element: 'B1', kind: 'breaker', converged: true, unservedKw: 100, bestTie: null, remainingUnservedKw: 100, ...more,
  })

  it('opens a switch, takes anything else out of service, and starts the standby units it used', () => {
    expect(n1CaseOverrides(row({ standbyStarted: ['g1'] }), base, () => 'breaker')).toEqual({
      b1: { closed: false },
      g1: { enabled: true, islandMode: 'isochronous' },
    })
    expect(n1CaseOverrides(row({ id: 'ln1', kind: 'line' }), base, () => undefined)).toEqual({ ln1: { enabled: false } })
  })

  it('closes the best tie and uses its standby units, not the no-action ones', () => {
    const c = row({
      standbyStarted: ['g1', 'g2'],
      bestTie: { tie: 'tie', tieName: 'TIE', restoredKw: 100, remainingUnservedKw: 0, newViolations: 0, standbyStarted: [] } as never,
    })
    expect(n1CaseOverrides(c, base, () => 'breaker')).toEqual({ b1: { closed: false }, tie: { closed: true } })
    expect(n1CaseName(c)).toBe('N-1: B1 out, TIE closed')
  })
})
