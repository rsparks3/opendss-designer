import { beforeEach, describe, expect, it } from 'vitest'
import { hasElements } from '../lib/defaults'
import { everything } from '../lib/find'
import { autoLayout, elementsInZone } from '../lib/layout'
import { commonFields } from '../lib/selection'
import type { SolveResult } from '../types/circuit'
import { toCircuitJSON, useCircuitStore } from './circuitStore'
import { useResultsStore } from './resultsStore'

const solved = { converged: true } as SolveResult

function fresh() {
  useCircuitStore.getState().clearAll()
  const s = useCircuitStore.getState()
  const src = s.addNodeAt('vsource', { x: 100, y: 100 })
  const load = s.addNodeAt('load', { x: 100, y: 300 })
  const zone = s.addZoneAt({ x: 43, y: 27, w: 151, h: 333 })
  useResultsStore.setState({ result: solved, stale: false })
  return { src, load, zone }
}

describe('zones', () => {
  beforeEach(() => useCircuitStore.setState({ placementType: null }))

  it('are drawn to a snapped rectangle, selected, and end placement mode', () => {
    useCircuitStore.getState().setPlacement('zone')
    const { zone } = fresh()
    const z = useCircuitStore.getState().nodes.find((x) => x.id === zone)!
    expect(z.selected).toBe(true)
    expect(z.position).toEqual({ x: 40, y: 30 })
    expect(z.width).toBe(150)
    expect(z.height).toBe(330)
    expect(z.data.params).toEqual({ label: '', color: 'grey' })
    expect(useCircuitStore.getState().placementType).toBeNull()
    // A click places a default-size one, likewise selected.
    const second = useCircuitStore.getState().addNodeAt('zone', { x: 500, y: 500 })
    const z2 = useCircuitStore.getState().nodes.find((x) => x.id === second)!
    expect(z2.selected && !useCircuitStore.getState().nodes.find((x) => x.id === zone)!.selected).toBe(true)
    expect([z2.width, z2.height]).toEqual([240, 160])
  })

  it('never make the results stale', () => {
    const { zone } = fresh()
    const s = useCircuitStore.getState()
    s.updateNodeParams(zone, { label: 'Substation A', color: 'blue' })
    s.setZoneSize(zone, 233, 97)
    s.onNodesChange([{ type: 'position', id: zone, position: { x: 500, y: 500 } }])
    s.onNodesChange([{ type: 'remove', id: zone }])
    expect(useResultsStore.getState().stale).toBe(false)
    expect(useCircuitStore.getState().dirty).toBe(true)
  })

  it('snap their size to the grid, never smaller than 60 by 40', () => {
    const { zone } = fresh()
    useCircuitStore.getState().setZoneSize(zone, 233, 97)
    let z = useCircuitStore.getState().nodes.find((x) => x.id === zone)!
    expect([z.width, z.height]).toEqual([230, 100])
    useCircuitStore.getState().setZoneSize(zone, 5, 5)
    z = useCircuitStore.getState().nodes.find((x) => x.id === zone)!
    expect([z.width, z.height]).toEqual([60, 40])
  })

  it('save their height, which no other node does', () => {
    const { zone, src } = fresh()
    const json = toCircuitJSON(useCircuitStore.getState())
    expect(json.nodes.find((n) => n.id === zone)).toMatchObject({ width: 150, height: 330 })
    expect('height' in json.nodes.find((n) => n.id === src)!).toBe(false)
  })

  it('do not rotate or flip, are found by their label, and are not circuit', () => {
    const { zone } = fresh()
    const s = useCircuitStore.getState()
    s.updateNodeParams(zone, { label: 'Feeder 12' })
    s.rotateNodes([zone])
    s.flipNodes([zone], 'horizontal')
    const p = useCircuitStore.getState().nodes.find((x) => x.id === zone)!.data.params
    expect(p.rotation).toBeUndefined()
    expect(p.flip).toBeUndefined()
    expect(everything().find((h) => h.id === zone)?.name).toBe('Feeder 12')
    expect(hasElements([{ type: 'zone' }, { type: 'note' }])).toBe(false)
    expect(commonFields(['zone', 'zone']).map((f) => f.key)).toEqual(['color'])
  })

  it('know what they hold, and follow it through a layout', () => {
    const { zone, src, load } = fresh()
    const json = toCircuitJSON(useCircuitStore.getState())
    const z = json.nodes.find((n) => n.id === zone)!
    expect(elementsInZone(z, json).sort()).toEqual([load, src].sort())
    // Hang the load off the source and lay it out: the elements move, and
    // the zone is redrawn around them with room for its label.
    useCircuitStore.getState().onConnect({ source: src, sourceHandle: 't1', target: load, targetHandle: 't1' })
    const laid = toCircuitJSON(useCircuitStore.getState())
    autoLayout(laid)
    const after = laid.nodes.find((n) => n.id === zone)!
    const held = laid.nodes.filter((n) => n.id === src || n.id === load)
    for (const n of held) {
      expect(n.position!.x).toBeGreaterThan(after.position!.x)
      expect(n.position!.y).toBeGreaterThan(after.position!.y)
      expect(n.position!.x + 40).toBeLessThan(after.position!.x + after.width!)
      expect(n.position!.y + 60).toBeLessThan(after.position!.y + after.height!)
    }
    expect(elementsInZone(after, laid).sort()).toEqual([load, src].sort())
    // The live circuit takes the new rectangle as one undo step.
    useCircuitStore.getState().applyLayout(laid)
    const live = useCircuitStore.getState().nodes.find((n) => n.id === zone)!
    expect([live.width, live.height]).toEqual([after.width, after.height])
    // An empty zone is left where it was.
    const empty = useCircuitStore.getState().addZoneAt({ x: 2000, y: 2000, w: 100, h: 100 })
    const again = toCircuitJSON(useCircuitStore.getState())
    autoLayout(again)
    expect(again.nodes.find((n) => n.id === empty)!.position).toEqual({ x: 2000, y: 2000 })
  })
})
