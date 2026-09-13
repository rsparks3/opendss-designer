import { describe, expect, it } from 'vitest'
import { formatAmps, formatSeconds, logTicks, operateSeconds, type TccTrace } from './tcc'

// A two-decade straight line on log-log paper: 100 A takes 10 s, 1000 A takes
// 0.1 s. The midpoint in log terms (316 A) must land at 1 s.
const line: TccTrace = {
  label: 'test',
  curve: 'x',
  fault: 'phase',
  pickupA: 100,
  points: [
    [100, 10],
    [1000, 0.1],
  ],
}

describe('operateSeconds', () => {
  it('interpolates the way the curve is drawn — straight on log-log paper', () => {
    expect(operateSeconds(line, 100)).toBeCloseTo(10, 6)
    expect(operateSeconds(line, 1000)).toBeCloseTo(0.1, 6)
    expect(operateSeconds(line, 316.2278)).toBeCloseTo(1, 3)
  })

  it('does not operate below the first point', () => {
    expect(operateSeconds(line, 99)).toBeNull()
    expect(operateSeconds(line, 1)).toBeNull()
  })

  it('holds the last point past the end of the curve, as the engine does', () => {
    expect(operateSeconds(line, 5000)).toBe(0.1)
  })
})

describe('logTicks', () => {
  it('marks the decades and fills in the 2-9 lines between', () => {
    const ticks = logTicks(1, 100)
    expect(ticks.filter((t) => t.major).map((t) => t.v)).toEqual([1, 10, 100])
    expect(ticks.map((t) => t.v)).toContain(20)
    expect(ticks.every((t) => t.v >= 1 && t.v <= 100)).toBe(true)
  })

  it('covers a range that starts mid-decade', () => {
    const ticks = logTicks(0.05, 3)
    expect(ticks[0].v).toBeGreaterThanOrEqual(0.05)
    expect(ticks[ticks.length - 1].v).toBeLessThanOrEqual(3)
    expect(ticks.filter((t) => t.major).map((t) => t.v)).toEqual([0.1, 1])
  })
})

describe('formatting', () => {
  it('keeps currents readable across the decades a feeder spans', () => {
    expect(formatAmps(6.5)).toBe('6.5')
    expect(formatAmps(65)).toBe('65')
    expect(formatAmps(650)).toBe('650')
    expect(formatAmps(6500)).toBe('6.5k')
    expect(formatAmps(65000)).toBe('65k')
  })

  it('shows enough decimals to tell fast trips apart', () => {
    expect(formatSeconds(300)).toBe('300')
    expect(formatSeconds(1.5)).toBe('1.5')
    expect(formatSeconds(0.45)).toBe('0.45')
    expect(formatSeconds(0.045)).toBe('0.045')
  })
})
