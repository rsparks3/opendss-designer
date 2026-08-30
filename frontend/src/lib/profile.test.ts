import { describe, expect, it } from 'vitest'
import type { SolveResult } from '../types/circuit'
import { computeProfile } from './profile'

const result = {
  converged: true,
  buses: {
    src: { vminPu: 1.0, vmaxPu: 1.0, vangDeg: [], vmagPu: [], kvBase: 66.4, nodes: [1, 2, 3] },
    mid: { vminPu: 0.98, vmaxPu: 0.985, vangDeg: [], vmagPu: [], kvBase: 7.2, nodes: [1, 2, 3] },
    end: {
      vminPu: 0.94, vmaxPu: 0.95, vangDeg: [], vmagPu: [], kvBase: 7.2, nodes: [1, 2, 3],
      violation: 'undervoltage',
    },
    orphan: { vminPu: 1.0, vmaxPu: 1.0, vangDeg: [], vmagPu: [], kvBase: 7.2, nodes: [1] },
  },
  busDistances: { src: 0, mid: 1.2, end: 3.7 }, // orphan: unreachable, no distance
  lineBuses: { ln1: ['mid', 'end'], ln_bad: ['mid', 'orphan'] },
  nodeBuses: { xf: ['src', 'mid'], ld: ['end'] },
} as unknown as SolveResult

const nodes = [
  { id: 'xf', type: 'transformer' },
  { id: 'ld', type: 'load' },
]

describe('computeProfile', () => {
  it('produces distance-sorted points for every reachable solved bus', () => {
    const { points } = computeProfile(result, nodes)
    expect(points.map((p) => p.bus)).toEqual(['src', 'mid', 'end'])
    expect(points[2].violation).toBe('undervoltage')
  })

  it('skips buses without a distance (unreachable/orphaned)', () => {
    const { points, segments } = computeProfile(result, nodes)
    expect(points.some((p) => p.bus === 'orphan')).toBe(false)
    expect(segments.some((s) => s.to === 'orphan' || s.from === 'orphan')).toBe(false)
  })

  it('emits solid segments for lines and dashed for 2-terminal devices', () => {
    const { segments } = computeProfile(result, nodes)
    expect(segments).toContainEqual({ from: 'mid', to: 'end', dashed: false })
    expect(segments).toContainEqual({ from: 'src', to: 'mid', dashed: true })
    expect(segments).toHaveLength(2) // the load (1-terminal) adds nothing
  })
})
