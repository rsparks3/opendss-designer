import { describe, expect, it } from 'vitest'
import { nearestHandle, type HandleCandidate } from './grabTarget'

const h = (nodeId: string, handleId: string, x: number, y: number): HandleCandidate => ({
  nodeId,
  handleId,
  x,
  y,
})

describe('nearestHandle', () => {
  const candidates = [h('a', 't1', 0, 0), h('b', 't1', 100, 0), h('c', 'b3', 100, 40)]

  it('returns the closest candidate inside the radius', () => {
    expect(nearestHandle(candidates, 96, 6, 30)).toEqual(h('b', 't1', 100, 0))
    expect(nearestHandle(candidates, 96, 36, 30)).toEqual(h('c', 'b3', 100, 40))
  })

  it('returns null when everything is out of range', () => {
    expect(nearestHandle(candidates, 50, 200, 30)).toBeNull()
  })

  it('treats the radius as inclusive', () => {
    expect(nearestHandle([h('a', 't1', 0, 0)], 30, 0, 30)).not.toBeNull()
    expect(nearestHandle([h('a', 't1', 0, 0)], 31, 0, 30)).toBeNull()
  })

  it('has no candidate to offer on an empty canvas', () => {
    expect(nearestHandle([], 0, 0, 30)).toBeNull()
  })
})
