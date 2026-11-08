import { describe, expect, it } from 'vitest'
import { decideOverview, MIN_SYMBOL_ZOOM, nodeBounds, nodesInView, SYMBOL_BUDGET } from './viewBudget'

const grid = (n: number, pitch = 100) =>
  Array.from({ length: n }, (_, i) => ({
    type: 'load',
    position: { x: (i % 50) * pitch, y: Math.floor(i / 50) * pitch },
  }))

describe('nodesInView', () => {
  it('counts the nodes whose boxes touch the viewport', () => {
    const nodes = grid(2500)
    // Zoom 1, viewport 1000 x 500 at the origin: ten columns, five rows.
    expect(nodesInView(nodes, [0, 0, 1], 1000, 500, Infinity)).toBe(11 * 6)
    // Panned off the drawing entirely.
    expect(nodesInView(nodes, [-100000, 0, 1], 1000, 500, Infinity)).toBe(0)
  })

  it('stops counting at the cap', () => {
    const nodes = grid(2500)
    expect(nodesInView(nodes, [0, 0, 0.01], 1000, 500, 50)).toBe(50)
  })

  it('ignores notes and zones', () => {
    const nodes = [
      { type: 'note', position: { x: 0, y: 0 } },
      { type: 'zone', position: { x: 0, y: 0 } },
      { type: 'busbar', position: { x: 0, y: 0 } },
    ]
    expect(nodesInView(nodes, [0, 0, 1], 500, 500, Infinity)).toBe(1)
  })
})

describe('decideOverview', () => {
  it('shows symbols while the view holds fewer than the budget', () => {
    expect(decideOverview(false, SYMBOL_BUDGET.enter, 0.5)).toBe(false)
    expect(decideOverview(false, SYMBOL_BUDGET.enter + 1, 0.5)).toBe(true)
  })

  it('keeps the overview until the count drops below the lower bound', () => {
    expect(decideOverview(true, SYMBOL_BUDGET.leave + 1, 0.5)).toBe(true)
    expect(decideOverview(true, SYMBOL_BUDGET.leave, 0.5)).toBe(false)
  })

  it('is always the overview when symbols would be unreadable', () => {
    expect(decideOverview(false, 3, MIN_SYMBOL_ZOOM / 2)).toBe(true)
  })
})

describe('nodeBounds', () => {
  it('spans every box, using the known symbol sizes', () => {
    const b = nodeBounds([
      { type: 'load', position: { x: 10, y: 20 } },
      { type: 'busbar', position: { x: 100, y: 200 }, width: 300 },
    ])
    expect(b).toEqual({ x: 10, y: 20, width: 390, height: 194 })
  })

  it('is empty for no nodes', () => {
    expect(nodeBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
