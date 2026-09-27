import { describe, expect, it } from 'vitest'
import { divideLength, midpoint, splitAt } from './splitLine'

describe('splitAt', () => {
  const straight = [
    { x: 100, y: 0 },
    { x: 100, y: 200 },
  ]

  it('finds the fraction along a straight vertical run', () => {
    const s = splitAt(straight, { x: 104, y: 50 })
    expect(s.point).toEqual({ x: 100, y: 50 })
    expect(s.fraction).toBeCloseTo(0.25)
    expect(s.vertical).toBe(true)
    expect(s.forward).toBe(true)
    expect(s.before).toEqual([])
    expect(s.after).toEqual([])
  })

  it('shares routing points out between the halves', () => {
    const bent = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
    ]
    const s = splitAt(bent, { x: 150, y: 98 })
    expect(s.point).toEqual({ x: 150, y: 100 })
    // 100 down + 150 across out of 400
    expect(s.fraction).toBeCloseTo(250 / 400)
    expect(s.before).toEqual([{ x: 0, y: 100 }])
    expect(s.after).toEqual([{ x: 200, y: 100 }])
    expect(s.vertical).toBe(false)
    expect(s.forward).toBe(true)
  })

  it('knows a line drawn upward from one drawn downward', () => {
    const up = [
      { x: 0, y: 200 },
      { x: 0, y: 0 },
    ]
    expect(splitAt(up, { x: 0, y: 100 }).forward).toBe(false)
  })
})

describe('midpoint', () => {
  it('is halfway along the drawn length, not between the ends', () => {
    expect(
      midpoint([
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 300, y: 100 },
      ]),
    ).toEqual({ x: 100, y: 100 })
  })
})

describe('divideLength', () => {
  it('splits and adds back up', () => {
    expect(divideLength(1, 0.25)).toEqual([0.25, 0.75])
    const [a, b] = divideLength(2.37, 1 / 3)
    expect(a + b).toBeCloseTo(2.37, 9)
    expect(a).toBe(0.79)
    const [c, d] = divideLength(2.5, 0.3338129)
    expect(c + d).toBe(2.5)
  })
})
