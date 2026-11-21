import { describe, expect, it } from 'vitest'
import { chainMargins, curveLibrary, faultSignature, formatAmps, formatSeconds, logTicks, operateSeconds, retrace, type TccDevice, type TccTrace } from './tcc'

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

describe('redrawing, chains and margins (facility plan 2.5)', () => {
  const VI: [number, number][] = [[1.1, 135], [2, 13.5], [10, 1.5], [20, 0.711]]
  const lib = { iec_vi: VI, iec_si: [[1.1, 70.9], [10, 2.97], [20, 2.27]] as [number, number][] }
  const relay: TccDevice = {
    nodeId: 'r', name: 'R', kind: 'relay', switch: 'r', bus: 'b',
    faultA3ph: 3000, faultA1ph: 2800,
    traces: [{ label: 'R phase', curve: 'iec_vi', fault: 'phase', pickupA: 300, timeDial: 0.3, delay: 0,
      keys: { curve: 'phasecurve', pickup: 'phasetrip', td: 'tdphase' },
      points: VI.map(([m, s]) => [m * 300, s * 0.3]) }],
  }
  const fuse: TccDevice = {
    nodeId: 'f', name: 'F', kind: 'fuse', switch: 'f', bus: 'c', faultA3ph: 3000, faultA1ph: 2900,
    traces: [{ label: 'F (tlink)', curve: 'tlink', fault: 'phase', pickupA: 65, keys: { curve: 'fusecurve', pickup: 'ratedcurrent' },
      points: [[130, 300], [650, 1], [3250, 0.02], [6500, 0.012]] }],
  }

  it('redraws a relay from its params without a solve', () => {
    const same = retrace(relay, { phasetrip: 300, tdphase: 0.3 }, lib)
    expect(operateSeconds(same.traces[0], 3000)).toBeCloseTo(0.45, 2)
    const slower = retrace(relay, { phasetrip: 300, tdphase: 0.6 }, lib)
    expect(operateSeconds(slower.traces[0], 3000)).toBeCloseTo(0.9, 2)
    const higher = retrace(relay, { phasetrip: 600, tdphase: 0.3 }, lib)
    expect(higher.traces[0].points[0][0]).toBeCloseTo(660, 0)
    const other = retrace(relay, { phasecurve: 'iec_si' }, lib)
    expect(other.traces[0].curve).toBe('iec_si')
    // A curve the library does not hold keeps the traced points; 'none' drops the trace.
    expect(retrace(relay, { phasecurve: 'mystery' }, lib).traces[0].points).toEqual(relay.traces[0].points)
    expect(retrace(relay, { phasecurve: 'none' }, lib).traces).toEqual([])
  })

  it('grades a chain at the downstream fault current', () => {
    const [m] = chainMargins([fuse, relay])
    expect(m.fault).toBe('phase')
    expect(m.amps).toBe(3000)
    expect(m.marginS).toBeGreaterThan(0.25)
    expect(m.ok).toBe(true)
    const tight = chainMargins([fuse, retrace(relay, { tdphase: 0.05 }, lib)])[0]
    expect(tight.ok).toBe(false)
  })

  it('a curve edit is not a fault-current change', () => {
    const nodes = [{ id: 'r', type: 'relay', data: { params: { phasetrip: 300, normamps: 400 } } }]
    const base = faultSignature(nodes, [])
    expect(faultSignature([{ ...nodes[0], data: { params: { phasetrip: 600, normamps: 400 } } }], [])).toBe(base)
    expect(faultSignature([{ ...nodes[0], data: { params: { phasetrip: 300, normamps: 400, enabled: false } } }], [])).not.toBe(base)
  })

  it('builds the library from the served curves and the circuit\'s own', () => {
    const l = curveLibrary([{ name: 'TLINK', points: [[1, 2], [3, 4]] }], { mine: { multiples: [1, 2], seconds: [5, 6] } })
    expect(l.tlink).toEqual([[1, 2], [3, 4]])
    expect(l.mine).toEqual([[1, 5], [2, 6]])
  })
})
