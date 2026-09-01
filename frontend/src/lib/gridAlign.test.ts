import { describe, expect, it } from 'vitest'
import { NODE_SIZE, SYMBOL_PITCH } from './defaults'
import { busbarHandleCount, fromCircuitJSON, snapBusbarWidth } from '../store/circuitStore'
import type { CircuitJSON } from '../types/circuit'
import type { NodeType } from '../types/circuit'

// The canvas snaps a node's top-left corner to a 10px grid (EditorCanvas
// snapGrid). A symbol's terminal handle sits at the container's center, so
// terminals only land on the grid when w/2 and h/2 are multiples of 10 —
// i.e. when both dimensions are multiples of the 20px symbol pitch. When they
// are not, every wire to a busbar picks up a permanent w/2 mod 10 bend.
const GRID = 10

describe('grid alignment', () => {
  const symbols = (Object.keys(NODE_SIZE) as NodeType[]).filter((t) => t !== 'busbar')

  it.each(symbols)('%s terminals land on the grid in every rotation', (type) => {
    const { w, h } = NODE_SIZE[type]
    expect(w % SYMBOL_PITCH).toBe(0)
    expect(h % SYMBOL_PITCH).toBe(0)
    // 0/180 uses w, 90/270 swaps to h — both halves must be on the grid.
    expect((w / 2) % GRID).toBe(0)
    expect((h / 2) % GRID).toBe(0)
  })

  it('busbar handles land on the grid at every snapped width', () => {
    for (let raw = 40; raw <= 600; raw += 7) {
      const width = snapBusbarWidth(raw)
      expect(width % SYMBOL_PITCH).toBe(0)
      const count = busbarHandleCount(width)
      for (let i = 0; i < count; i++) {
        // BusbarNode places handle i at (i + 0.5) * SYMBOL_PITCH from the
        // bar's grid-snapped left edge.
        expect(((i + 0.5) * SYMBOL_PITCH) % GRID).toBe(0)
      }
      // Every handle stays on the bar.
      expect((count - 0.5) * SYMBOL_PITCH).toBeLessThanOrEqual(width)
    }
  })

  it('a symbol centered on a busbar handle forms an exactly vertical wire', () => {
    const busX = 120 // grid-snapped bar origin
    for (const type of symbols) {
      const { w } = NODE_SIZE[type]
      const handleX = busX + 2.5 * SYMBOL_PITCH // bar handle b2 at 170
      // Drop the symbol so its terminal targets that handle, then let the
      // canvas snap its corner the way a drag would.
      const corner = Math.round((handleX - w / 2) / GRID) * GRID
      expect(corner + w / 2).toBe(handleX)
    }
  })
})

describe('loading a pre-pitch circuit', () => {
  // Corners recorded under the old boxes (transformer 48 wide, generator 44,
  // breaker 36) sat on the grid themselves but put the terminal off it.
  const legacy = {
    version: 1,
    name: 'legacy',
    nodes: [
      { id: 'bus', type: 'busbar', position: { x: 0, y: 300 }, width: 250, params: {} },
      { id: 'tx', type: 'transformer', position: { x: -14, y: 100 }, params: {} },
      { id: 'g', type: 'generator', position: { x: 48, y: 100 }, params: {} },
      { id: 'cb', type: 'breaker', position: { x: 92, y: 100 }, params: {} },
    ],
    edges: [],
  } as unknown as CircuitJSON

  it('re-snaps corners so terminals land on the grid', () => {
    const { nodes } = fromCircuitJSON(legacy)
    for (const n of nodes) {
      // Math.abs: a snapped negative corner yields -0, which !== +0 under toBe.
      expect(Math.abs(n.position.x % GRID)).toBe(0)
      expect(Math.abs(n.position.y % GRID)).toBe(0)
      if (n.type === 'busbar') continue
      const { w } = NODE_SIZE[n.type as NodeType]
      expect(Math.abs((n.position.x + w / 2) % GRID)).toBe(0)
    }
  })

  it('re-snaps busbar widths onto the pitch', () => {
    const bus = fromCircuitJSON(legacy).nodes.find((n) => n.type === 'busbar')!
    expect(bus.width! % SYMBOL_PITCH).toBe(0)
    expect(bus.width).toBe(260) // 250 -> 12.5 pitches -> 13 handles
  })

  it('moves nothing by more than half a grid step', () => {
    const { nodes } = fromCircuitJSON(legacy)
    for (const n of nodes) {
      const before = legacy.nodes.find((o) => o.id === n.id)!.position!
      expect(Math.abs(n.position.x - before.x)).toBeLessThanOrEqual(GRID / 2)
      expect(Math.abs(n.position.y - before.y)).toBeLessThanOrEqual(GRID / 2)
    }
  })
})
