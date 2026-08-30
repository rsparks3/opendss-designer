import { describe, expect, it } from 'vitest'
import type { CircuitEdgeJSON, CircuitJSON, CircuitNodeJSON, NodeType } from '../types/circuit'
import { NODE_SIZE } from './defaults'
import { autoLayout } from './layout'

function n(id: string, type: NodeType, width?: number): CircuitNodeJSON {
  return { id, type, position: { x: 0, y: 0 }, width: width ?? null, params: {} }
}

function e(
  id: string,
  source: string,
  target: string,
  handles: { sourceHandle?: string; targetHandle?: string } = {},
): CircuitEdgeJSON {
  return { id, type: 'wire', source, target, params: {}, ...handles }
}

/** src → busA → transformer → busB → two loads. */
function substation(): CircuitJSON {
  return {
    version: 1,
    name: 'layout-test',
    nodes: [
      n('src', 'vsource'),
      n('busA', 'busbar', 240),
      n('xf', 'transformer'),
      n('busB', 'busbar', 240),
      n('load1', 'load'),
      n('load2', 'load'),
    ],
    edges: [
      e('e1', 'src', 'busA', { sourceHandle: 't1' }),
      e('e2', 'busA', 'xf', { targetHandle: 't1' }),
      e('e3', 'xf', 'busB', { sourceHandle: 't2' }),
      e('e4', 'busB', 'load1', { targetHandle: 't1' }),
      e('e5', 'busB', 'load2', { targetHandle: 't1' }),
    ],
    busNames: {},
  }
}

const y = (c: CircuitJSON, id: string) => c.nodes.find((nd) => nd.id === id)!.position!.y
const cx = (c: CircuitJSON, id: string) => {
  const nd = c.nodes.find((x) => x.id === id)!
  const w = nd.type === 'busbar' ? (nd.width ?? NODE_SIZE.busbar.w) : NODE_SIZE[nd.type].w
  return nd.position!.x + w / 2
}

describe('autoLayout', () => {
  it('ranks the circuit top-down in the direction power flows', () => {
    const c = substation()
    autoLayout(c)
    expect(y(c, 'src')).toBeLessThan(y(c, 'busA'))
    expect(y(c, 'busA')).toBeLessThan(y(c, 'xf'))
    expect(y(c, 'xf')).toBeLessThan(y(c, 'busB'))
    expect(y(c, 'busB')).toBeLessThan(y(c, 'load1'))
    expect(y(c, 'busB')).toBeLessThan(y(c, 'load2'))
  })

  it('snaps every position to the 10px grid', () => {
    const c = substation()
    autoLayout(c)
    for (const nd of c.nodes) {
      expect(nd.position!.x % 10).toBe(0)
      expect(nd.position!.y % 10).toBe(0)
    }
  })

  it('centers two-terminal devices between the buses they join', () => {
    const c = substation()
    autoLayout(c)
    const mid = (cx(c, 'busA') + cx(c, 'busB')) / 2
    expect(Math.abs(cx(c, 'xf') - mid)).toBeLessThanOrEqual(10) // within one snap step
  })

  it('centers the source above the bus it feeds', () => {
    const c = substation()
    autoLayout(c)
    expect(Math.abs(cx(c, 'src') - cx(c, 'busA'))).toBeLessThanOrEqual(10)
  })

  it('spreads loads under their busbar on distinct positions', () => {
    const c = substation()
    autoLayout(c)
    const l1 = c.nodes.find((nd) => nd.id === 'load1')!.position!
    const l2 = c.nodes.find((nd) => nd.id === 'load2')!.position!
    expect(l1.x).not.toBe(l2.x)
  })

  it('routes busbar connections through the row facing the other endpoint', () => {
    const c = substation()
    autoLayout(c)
    const handleOn = (edgeId: string, busId: string) => {
      const ed = c.edges.find((x) => x.id === edgeId)!
      return ed.source === busId ? ed.sourceHandle! : ed.targetHandle!
    }
    // Source sits above busA → its wire lands on the top (b) row.
    expect(handleOn('e1', 'busA')).toMatch(/^b\d+$/)
    // The transformer hangs below busA → bottom (c) row.
    expect(handleOn('e2', 'busA')).toMatch(/^c\d+$/)
    // Transformer above busB → top row; loads below busB → bottom row.
    expect(handleOn('e3', 'busB')).toMatch(/^b\d+$/)
    expect(handleOn('e4', 'busB')).toMatch(/^c\d+$/)
    expect(handleOn('e5', 'busB')).toMatch(/^c\d+$/)
    // Handle indexes stay within the row's handle count (240px → 12).
    for (const ed of c.edges) {
      for (const h of [ed.sourceHandle, ed.targetHandle]) {
        const m = h?.match(/^[bc](\d+)$/)
        if (m) expect(Number(m[1])).toBeLessThan(12)
      }
    }
  })
})
