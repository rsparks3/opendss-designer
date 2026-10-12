import { describe, expect, it } from 'vitest'
import { treeLayout } from './treeLayout'

const box = (id: string, width = 40, height = 20) => ({ id, width, height })
const opts = { direction: 'TB' as const, nodesep: 10, ranksep: 30 }

describe('treeLayout', () => {
  it('puts a parent centred over its children, one row per depth', () => {
    const pos = treeLayout([box('r'), box('a'), box('b')], [['r', 'a'], ['r', 'b']], opts)
    expect(pos.get('a')!.y).toBe(pos.get('b')!.y)
    expect(pos.get('a')!.y).toBeGreaterThan(pos.get('r')!.y)
    expect(pos.get('r')!.x).toBeCloseTo((pos.get('a')!.x + pos.get('b')!.x) / 2)
    // Siblings sit a box width plus the gap apart.
    expect(pos.get('b')!.x - pos.get('a')!.x).toBe(50)
  })

  it('never overlaps two boxes in a row, though a shallow subtree may sit over a deep one', () => {
    // r -> a -> (a1, a2, a3), r -> b, b -> b1 -> b2: rows must stay clear.
    const edges: [string, string][] = [
      ['r', 'a'], ['r', 'b'], ['a', 'a1'], ['a', 'a2'], ['a', 'a3'], ['b', 'b1'], ['b1', 'b2'],
    ]
    const ids = ['r', 'a', 'b', 'a1', 'a2', 'a3', 'b1', 'b2']
    const pos = treeLayout(ids.map((id) => box(id)), edges, opts)
    for (const p of ids) {
      for (const q of ids) {
        if (p === q || pos.get(p)!.y !== pos.get(q)!.y) continue
        expect(Math.abs(pos.get(p)!.x - pos.get(q)!.x)).toBeGreaterThanOrEqual(40 + 10)
      }
    }
  })

  it('ignores an edge that closes a loop, and places every node', () => {
    const edges: [string, string][] = [['r', 'a'], ['r', 'b'], ['a', 'c'], ['b', 'c']]
    const pos = treeLayout(['r', 'a', 'b', 'c'].map((id) => box(id)), edges, opts)
    expect(pos.size).toBe(4)
    expect(pos.get('c')!.x).toBe(pos.get('a')!.x) // c hangs under a, its first parent
    expect(pos.get('c')!.y).toBeGreaterThan(pos.get('a')!.y)
  })

  it('runs across the page for LR', () => {
    const pos = treeLayout([box('r'), box('a')], [['r', 'a']], { ...opts, direction: 'LR' })
    expect(pos.get('a')!.x).toBeGreaterThan(pos.get('r')!.x)
    expect(pos.get('a')!.y).toBe(pos.get('r')!.y)
  })

  it('tucks laterals in under a long trunk instead of laying leaves end to end', () => {
    // A trunk t0..t99 with a two-pole lateral off every pole: the outline
    // packing keeps it a few boxes wide, not a hundred.
    const ids: string[] = []
    const edges: [string, string][] = []
    for (let i = 0; i < 100; i++) {
      ids.push(`t${i}`, `a${i}`, `b${i}`)
      if (i) edges.push([`t${i - 1}`, `t${i}`])
      edges.push([`t${i}`, `a${i}`], [`a${i}`, `b${i}`])
    }
    const pos = treeLayout(ids.map((id) => box(id)), edges, opts)
    const xs = [...pos.values()].map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(10 * 50)
  })

  it('lays out a 20,000-node tree in well under a second', () => {
    const boxes = Array.from({ length: 20000 }, (_, i) => box(`n${i}`))
    const edges = boxes.slice(1).map((b, i): [string, string] => [`n${Math.floor(i / 3)}`, b.id])
    const t = performance.now()
    const pos = treeLayout(boxes, edges, opts)
    expect(pos.size).toBe(20000)
    expect(performance.now() - t).toBeLessThan(1000)
  })
})
