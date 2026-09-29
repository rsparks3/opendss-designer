import { describe, expect, it } from 'vitest'
import { arrowHead, exitPoint, leaderLine, lineAnchor } from './noteLeader'

const note = { x: 0, y: 0, w: 100, h: 40 }

describe('note leader', () => {
  it('leaves the note through the side facing the target', () => {
    expect(exitPoint(note, { x: 300, y: 20 })).toEqual({ x: 100, y: 20 })
    expect(exitPoint(note, { x: 50, y: 200 })).toEqual({ x: 50, y: 40 })
  })

  it('stops short of a symbol and at a point on a line', () => {
    const toBox = leaderLine(note, { x: 200, y: 0, w: 40, h: 40 })!
    expect(toBox.from).toEqual({ x: 100, y: 20 })
    expect(toBox.to).toEqual({ x: 196, y: 20 })
    const toPoint = leaderLine(note, { x: 200, y: 20 })!
    expect(toPoint.to).toEqual({ x: 200, y: 20 })
  })

  it('draws nothing when the target is under the note', () => {
    expect(leaderLine(note, { x: 50, y: 20 })).toBeNull()
    expect(leaderLine(note, { x: 10, y: 5, w: 20, h: 20 })).toBeNull()
  })

  it('lands halfway along a line as drawn', () => {
    expect(lineAnchor([{ x: 0, y: 0 }, { x: 100, y: 100 }], [{ x: 100, y: 0 }])).toEqual({ x: 100, y: 0 })
  })

  it('points the arrowhead along the leader', () => {
    const [tip, a, b] = arrowHead({ x: 0, y: 0 }, { x: 10, y: 0 })
    expect(tip).toEqual({ x: 10, y: 0 })
    expect(a.x).toBeLessThan(10)
    expect(b.x).toBeLessThan(10)
    expect(a.y).toBeCloseTo(-b.y)
  })
})
