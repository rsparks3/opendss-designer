import { describe, expect, it } from 'vitest'
import type { AppEdge, AppNode } from '../store/circuitStore'
import { placeOnMap } from './geoPlacement'

const node = (id: string, type: string, geo?: { x: number; y: number }): AppNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: { params: {}, ...(geo ? { geo } : {}) } }) as AppNode
const wire = (id: string, s: string, t: string): AppEdge => ({ id, source: s, target: t, type: 'wire', data: { params: {} } })
const line = (id: string, s: string, t: string, geometry?: { x: number; y: number }[]): AppEdge =>
  ({ id, source: s, target: t, type: 'line', data: { params: {}, ...(geometry ? { geometry } : {}) } })
const identity = (p: { x: number; y: number }) => ({ x: p.x, y: p.y })

describe('placeOnMap', () => {
  it('puts buses at their coordinates and a device midway between its buses', () => {
    const p = placeOnMap(
      [node('b1', 'busbar', { x: 0, y: 0 }), node('b2', 'busbar', { x: 100, y: 40 }), node('t', 'transformer')],
      [wire('w1', 'b1', 't'), wire('w2', 't', 'b2')],
      identity,
    )
    expect(p.pos.get('t')).toEqual({ x: 50, y: 20 })
    expect([...p.own].sort()).toEqual(['b1', 'b2'])
    expect(p.placed).toBe(3)
  })

  it('hangs a load from its bus and follows a line along its GIS route', () => {
    const p = placeOnMap(
      [node('b1', 'busbar', { x: 0, y: 0 }), node('b2', 'busbar', { x: 10, y: 0 }), node('ld', 'load')],
      [line('l', 'b1', 'b2', [{ x: 5, y: 5 }]), wire('w', 'ld', 'b2')],
      identity,
    )
    expect(p.pos.get('ld')).toEqual({ x: 10, y: 0 })
    expect(p.hanging.get('b2')).toEqual(['ld'])
    expect(p.lines[0].pts).toEqual([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }])
  })

  it('places a bus with no coordinates between its neighbours, and leaves the unreachable off', () => {
    const p = placeOnMap(
      [node('a', 'busbar', { x: 0, y: 0 }), node('m', 'busbar'), node('c', 'busbar', { x: 20, y: 0 }),
        node('far', 'busbar'), node('note', 'note')],
      [line('l1', 'a', 'm'), line('l2', 'm', 'c')],
      identity,
    )
    expect(p.pos.get('m')).toEqual({ x: 10, y: 0 })
    expect(p.pos.has('far')).toBe(false)
    expect(p.total).toBe(4)
    expect(p.placed).toBe(3)
  })

  it('drops a coordinate the projection cannot place', () => {
    const p = placeOnMap([node('a', 'busbar', { x: 1, y: 1 })], [], () => null)
    expect(p.placed).toBe(0)
  })
})
