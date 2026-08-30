import { describe, expect, it } from 'vitest'
import {
  decimate,
  normalizeAverage,
  normalizePeak,
  parseShapeText,
  shapeStats,
} from './shapeCsv'

describe('parseShapeText', () => {
  it('parses one value per line', () => {
    expect(parseShapeText('0.4\n1\n0.6\n')).toEqual({ points: [0.4, 1, 0.6], error: null })
  })

  it('parses comma/semicolon/whitespace separated values', () => {
    expect(parseShapeText('0.4, 1; 0.6\t0.8').points).toEqual([0.4, 1, 0.6, 0.8])
  })

  it('drops a monotonic first column as a time axis', () => {
    expect(parseShapeText('0,0.4\n1,1.0\n2,0.6').points).toEqual([0.4, 1.0, 0.6])
  })

  it('keeps both columns when col 0 is not monotonic', () => {
    expect(parseShapeText('0.9,0.4\n0.2,1.0').points).toEqual([0.9, 0.4, 0.2, 1.0])
  })

  it('tolerates a single header row and blank/comment lines', () => {
    expect(parseShapeText('timestamp,kwh\n\n# note\n0,0.4\n1,0.8').points).toEqual([0.4, 0.8])
  })

  it('reports non-numeric junk mid-file as an error', () => {
    expect(parseShapeText('0.4\noops\n0.6').error).toMatch(/not numeric/)
  })

  it('reports empty input', () => {
    expect(parseShapeText('  \n').error).toMatch(/No numeric/)
  })
})

describe('normalization', () => {
  it('normalizePeak scales the largest magnitude to 1.0', () => {
    expect(normalizePeak([1, 2, 4])).toEqual([0.25, 0.5, 1])
    expect(normalizePeak([-4, 2])).toEqual([-1, 0.5]) // sign preserved
  })

  it('normalizeAverage scales the mean to 1.0', () => {
    expect(normalizeAverage([1, 2, 3])).toEqual([0.5, 1, 1.5])
  })

  it('leaves all-zero shapes untouched', () => {
    expect(normalizePeak([0, 0])).toEqual([0, 0])
    expect(normalizeAverage([0, 0])).toEqual([0, 0])
  })
})

describe('decimate', () => {
  const wave = Array.from({ length: 1000 }, (_, i) => ({
    x: i,
    y: Math.sin(i / 20) + (i === 500 ? 5 : 0), // spike to preserve
  }))

  it('returns short series unchanged', () => {
    const pts = wave.slice(0, 10)
    expect(decimate(pts, 100)).toBe(pts)
  })

  it('caps the point count and preserves the global extremes', () => {
    const out = decimate(wave, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    const ys = out.map((p) => p.y)
    expect(Math.max(...ys)).toBeCloseTo(Math.max(...wave.map((p) => p.y)), 5) // spike survived
    expect(Math.min(...ys)).toBeCloseTo(Math.min(...wave.map((p) => p.y)), 5)
  })

  it('keeps x ascending within each emitted pair', () => {
    const out = decimate(wave, 50)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].x).toBeGreaterThanOrEqual(out[i - 1].x)
    }
  })
})

describe('shapeStats', () => {
  it('computes npts/min/max/avg', () => {
    expect(shapeStats([1, 2, 3])).toEqual({ npts: 3, min: 1, max: 3, avg: 2 })
  })
})
