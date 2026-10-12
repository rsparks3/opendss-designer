import { describe, expect, it } from 'vitest'
import results from './report/__fixtures__/full-circuit.results.json'
import type { ReliabilityResult } from '../types/circuit'
import {
  indicesLine,
  reliabilityLegend,
  reliabilityOf,
  SECTION_COLORS,
  sectionColor,
  sectionHeadedBy,
  UNSECTIONED_COLOR,
} from './reliability'

const rel = results.reliability as unknown as ReliabilityResult

describe('reliability on the drawing', () => {
  it('colours each section distinctly and the unprotected trunk grey', () => {
    const colours = rel.sections.map((s) => sectionColor(rel, s.id))
    expect(new Set(colours).size).toBe(rel.sections.length)
    expect(colours[0]).toBe(SECTION_COLORS[0])
    expect(sectionColor(rel, null)).toBe(UNSECTIONED_COLOR)
    expect(sectionColor(rel, 'nope')).toBe(UNSECTIONED_COLOR)
  })

  it('finds an element by its diagram id, and the section it heads', () => {
    const fuse = reliabilityOf(rel, 'n_fuse')!
    expect(fuse.name).toBe('line.fu1')
    expect(sectionHeadedBy(rel, 'n_fuse')?.device).toBe('fuse')
    expect(sectionHeadedBy(rel, 'n_load')).toBeNull()
    expect(reliabilityOf(rel, 'n_load')).toBeNull()
    expect(reliabilityOf({ ...rel, converged: false }, 'n_fuse')).toBeNull()
  })

  it('words the legend with the head device, customers and fault rate', () => {
    const rows = reliabilityLegend(rel, (id, fallback) => (id === 'n_fuse' ? 'FU1' : fallback))
    expect(rows.length).toBe(rel.sections.length + 1)
    expect(rows.find((r) => r.label.startsWith('FU1'))?.label).toMatch(/· \d+ cust · [\d.]+ \/yr$/)
    expect(rows.at(-1)).toEqual({ label: 'no protective device upstream', color: UNSECTIONED_COLOR })
    expect(reliabilityLegend(null, (_id, f) => f)).toEqual([])
  })

  it('prints the three indices on one line', () => {
    expect(indicesLine({ saifi: 0.188606, saidi: 0.651531, caidi: 3.4545 })).toBe('SAIFI 0.189 · SAIDI 0.652 h · CAIDI 3.45 h')
    expect(indicesLine({ saifi: null, saidi: null, caidi: null })).toBe('SAIFI — · SAIDI — h · CAIDI — h')
  })
})
