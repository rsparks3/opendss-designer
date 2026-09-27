import { describe, expect, it } from 'vitest'
import sample34 from '../../../src/opendss_designer/samples/ieee-34-bus.oneline.json'
import sample123 from '../../../src/opendss_designer/samples/ieee-123-bus.oneline.json'
import type { CircuitJSON } from '../types/circuit'
import { elkLayout } from './elkLayout'
import { autoLayout, sizeOf } from './layout'

const fresh = (c: unknown) => JSON.parse(JSON.stringify(c)) as CircuitJSON

function overlaps(c: CircuitJSON): string[] {
  const boxes = c.nodes.map((n) => ({ id: n.id, x: n.position!.x, y: n.position!.y, ...sizeOf(n) }))
  const out: string[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.id}/${b.id}`)
    }
  }
  return out
}

describe('elkLayout', () => {
  it('places every node of the 34-bus feeder on the grid, nothing on top of anything', async () => {
    const c = fresh(sample34)
    await elkLayout(c)
    for (const n of c.nodes) {
      expect(n.position!.x % 10).toBe(0)
      expect(n.position!.y % 10).toBe(0)
    }
    expect(overlaps(c)).toEqual([])
  })

  it('routes in right angles', async () => {
    const c = fresh(sample34)
    await elkLayout(c)
    let routed = 0
    for (const e of c.edges) {
      const w = e.waypoints ?? []
      if (w.length) routed++
      for (let i = 1; i < w.length; i++) {
        expect(w[i].x === w[i - 1].x || w[i].y === w[i - 1].y).toBe(true)
      }
    }
    expect(routed).toBeGreaterThan(10)
  })

  it('keeps pass-through buses compact and the rest labelled', async () => {
    const c = fresh(sample34)
    await elkLayout(c)
    const bars = c.nodes.filter((n) => n.type === 'busbar')
    const compact = bars.filter((n) => n.params.compact)
    expect(compact.length).toBeGreaterThanOrEqual(3)
    for (const b of compact) expect(b.width).toBe(60)
    expect(bars.length - compact.length).toBeGreaterThan(5)
  })

  it('lays out the 123-bus feeder', async () => {
    const c = fresh(sample123)
    await elkLayout(c)
    expect(overlaps(c)).toEqual([])
  })

  it('runs left to right when asked, with series devices on their side', async () => {
    const c = fresh(sample34)
    await elkLayout(c, { direction: 'LR' })
    const src = c.nodes.find((n) => n.type === 'vsource')!
    const xs = c.nodes.map((n) => n.position!.x)
    const ys = c.nodes.map((n) => n.position!.y)
    // Wider than tall, source at the left.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(Math.max(...ys) - Math.min(...ys))
    expect(src.position!.x).toBeLessThanOrEqual(Math.min(...xs) + 200)
    const reg = c.nodes.find((n) => n.type === 'regulator')!
    expect(reg.params.rotation).toBe(270)
  })
})

describe('autoLayout left to right', () => {
  it('turns series devices and runs the feeder across the page', () => {
    const c = fresh(sample34)
    autoLayout(c, { direction: 'LR' })
    const xs = c.nodes.map((n) => n.position!.x)
    const ys = c.nodes.map((n) => n.position!.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(Math.max(...ys) - Math.min(...ys))
    expect(c.nodes.find((n) => n.type === 'regulator')!.params.rotation).toBe(270)
  })

  it('top to bottom leaves every symbol upright', () => {
    const c = fresh(sample34)
    autoLayout(c)
    expect(c.nodes.every((n) => !n.params.rotation)).toBe(true)
  })
})
