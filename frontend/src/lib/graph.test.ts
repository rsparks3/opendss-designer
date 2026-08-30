import { describe, expect, it } from 'vitest'
import type { SolveResult } from '../types/circuit'
import { computeGraph } from './graph'

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
  elements: {
    'line.ln1': {
      id: 'e_ln1', currents: [80, 82, 79], kw: 950, kvar: 300, normAmps: 400,
      loadingPct: 20.5, violations: [], lossKw: 0.6, lossKvar: 1.4,
    },
    'load.ld1': {
      id: 'n_ld', currents: [80], kw: 940, kvar: 290, normAmps: null,
      loadingPct: null, violations: [], lossKw: null, lossKvar: null,
    },
  },
  lineBuses: { e_ln1: ['mid', 'end'], ln_bad: ['mid', 'orphan'] },
  nodeBuses: { xf: ['src', 'mid'], n_ld: ['end'] },
} as unknown as SolveResult

const nodes = [
  { id: 'xf', type: 'transformer' },
  { id: 'n_ld', type: 'load' },
]

describe('computeGraph — bus quantities', () => {
  it('produces x-sorted rows for every reachable solved bus, with topology segments', () => {
    const { rows, segments } = computeGraph(result, nodes, 'dist', 'vmin')
    expect(rows.map((r) => r.id)).toEqual(['src', 'mid', 'end'])
    expect(rows[2].violation).toBe('undervoltage')
    expect(rows.some((r) => r.id === 'orphan')).toBe(false) // no distance
    expect(segments).toContainEqual({ from: 'mid', to: 'end', dashed: false })
    expect(segments).toContainEqual({ from: 'src', to: 'mid', dashed: true })
    expect(segments).toHaveLength(2)
  })

  it('supports a non-distance X quantity', () => {
    const { rows } = computeGraph(result, nodes, 'vmin', 'vmax')
    // orphan has vmin, so with X=vmin it appears; rows sorted by x
    expect(rows.map((r) => r.x)).toEqual([...rows.map((r) => r.x)].sort((a, b) => a - b))
    expect(rows).toHaveLength(4)
  })
})

describe('computeGraph — element quantities', () => {
  it('plots each element at its source-side bus', () => {
    const { rows, segments } = computeGraph(result, nodes, 'dist', 'kw')
    expect(segments).toHaveLength(0) // no topology segments for element plots
    const line = rows.find((r) => r.id === 'line.ln1')!
    expect(line.bus).toBe('mid') // mid (1.2 km) is nearer the source than end
    expect(line.x).toBe(1.2)
    expect(line.y).toBe(950)
    const load = rows.find((r) => r.id === 'load.ld1')!
    expect(load.x).toBe(3.7)
  })

  it('derives max phase current and skips elements with null values', () => {
    const amps = computeGraph(result, nodes, 'dist', 'amps').rows
    expect(amps.find((r) => r.id === 'line.ln1')!.y).toBe(82)
    const losses = computeGraph(result, nodes, 'dist', 'losskw').rows
    expect(losses.map((r) => r.id)).toEqual(['line.ln1']) // load has null loss
    const loading = computeGraph(result, nodes, 'dist', 'loading').rows
    expect(loading.map((r) => r.id)).toEqual(['line.ln1']) // load has null loading
  })
})
