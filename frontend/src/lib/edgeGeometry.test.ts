import { describe, expect, it } from 'vitest'
import { insertPoint, interiorPoints, parsePathPoints, simplifyCollinear } from './edgeGeometry'

// A real smoothstep path as ReactFlow renders it at borderRadius 0: two legs
// joined by an elbow, with every corner emitted as a degenerate quadratic.
const SMOOTHSTEP =
  'M510 327L510 347L 510,361.25Q 510,361.25 510,361.25L 460,361.25' +
  'Q 460,361.25 460,361.25L460 375.5L460 395.5'

describe('parsePathPoints', () => {
  it('reads the corners of a smoothstep path, without the repeats', () => {
    expect(parsePathPoints(SMOOTHSTEP)).toEqual([
      { x: 510, y: 327 },
      { x: 510, y: 347 },
      { x: 510, y: 361.25 },
      { x: 460, y: 361.25 },
      { x: 460, y: 375.5 },
      { x: 460, y: 395.5 },
    ])
  })

  it('reads our own polyline form', () => {
    expect(parsePathPoints('M 0,0 L 40,0 L 40,80')).toEqual([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 80 },
    ])
  })

  it('copes with negative and fractional coordinates', () => {
    expect(parsePathPoints('M-12.5 -3L10 0')).toEqual([
      { x: -12.5, y: -3 },
      { x: 10, y: 0 },
    ])
  })

  it('returns nothing useful for a path it cannot read', () => {
    expect(parsePathPoints('')).toEqual([])
  })
})

describe('simplifyCollinear', () => {
  it('reduces a smoothstep path to its two real corners', () => {
    expect(simplifyCollinear(parsePathPoints(SMOOTHSTEP))).toEqual([
      { x: 510, y: 327 },
      { x: 510, y: 361.25 },
      { x: 460, y: 361.25 },
      { x: 460, y: 395.5 },
    ])
  })

  it('leaves a straight line as its endpoints', () => {
    expect(simplifyCollinear([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 }])).toEqual([
      { x: 0, y: 0 },
      { x: 9, y: 0 },
    ])
  })

  it('keeps genuine bends', () => {
    const bent = [{ x: 0, y: 0 }, { x: 10, y: 4 }, { x: 20, y: 0 }]
    expect(simplifyCollinear(bent)).toEqual(bent)
  })

  it('passes short paths through untouched', () => {
    expect(simplifyCollinear([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }])
  })
})

describe('interiorPoints', () => {
  it('drops the endpoints', () => {
    expect(interiorPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toEqual([
      { x: 1, y: 1 },
    ])
  })
  it('has nothing to give for a bare segment', () => {
    expect(interiorPoints([{ x: 0, y: 0 }, { x: 2, y: 2 }])).toEqual([])
  })
})

describe('insertPoint', () => {
  // An L: down the left side, then right along the bottom.
  const L = [{ x: 100, y: 0 }, { x: 100, y: 200 }, { x: 300, y: 200 }]

  it('lands the point on a vertical segment, snapping only along it', () => {
    expect(insertPoint(L, { x: 107, y: 63 })).toEqual({ index: 0, point: { x: 100, y: 60 } })
  })

  it('lands the point on a horizontal segment', () => {
    expect(insertPoint(L, { x: 244, y: 191 })).toEqual({ index: 1, point: { x: 240, y: 200 } })
  })

  it('keeps an off-grid segment coordinate exact', () => {
    const offGrid = [{ x: 361.25, y: 0 }, { x: 361.25, y: 100 }]
    expect(insertPoint(offGrid, { x: 358, y: 52 }).point).toEqual({ x: 361.25, y: 50 })
  })

  it('never slides the point past the end of its segment', () => {
    // Clicking beyond the corner still yields a point on the segment.
    const short = [{ x: 0, y: 0 }, { x: 0, y: 4 }]
    const { point } = insertPoint(short, { x: 0, y: 40 })
    expect(point.y).toBeGreaterThanOrEqual(0)
    expect(point.y).toBeLessThanOrEqual(4)
  })

  it('uses the exact projection on a diagonal segment', () => {
    const diagonal = [{ x: 0, y: 0 }, { x: 100, y: 100 }]
    expect(insertPoint(diagonal, { x: 60, y: 40 })).toEqual({ index: 0, point: { x: 50, y: 50 } })
  })

  it('picks the nearer of two candidate segments', () => {
    expect(insertPoint(L, { x: 290, y: 150 }).index).toBe(1)
    expect(insertPoint(L, { x: 150, y: 30 }).index).toBe(0)
  })
})
