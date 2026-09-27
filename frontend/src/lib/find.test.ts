import { describe, expect, it } from 'vitest'
import { rankHits, type Hit } from './find'

const hit = (name: string): Hit => ({ kind: 'node', id: name, name, type: 'load', frame: [name] })
const all = ['LOAD10', 'LOAD2', 'LOAD1', 'BIGLOAD', 'CAP1'].map(hit)

describe('rankHits', () => {
  it('puts names that start with the query first, in natural order', () => {
    expect(rankHits(all, 'load').map((h) => h.name)).toEqual(['LOAD1', 'LOAD2', 'LOAD10', 'BIGLOAD'])
  })

  it('ignores case and surrounding space', () => {
    expect(rankHits(all, '  cap ').map((h) => h.name)).toEqual(['CAP1'])
  })

  it('finds nothing for an empty query, and caps the list', () => {
    expect(rankHits(all, '')).toEqual([])
    expect(rankHits(all, 'o', 2)).toHaveLength(2)
  })
})
