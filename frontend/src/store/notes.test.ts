import { beforeEach, describe, expect, it } from 'vitest'
import { autoLayout } from '../lib/layout'
import { everything } from '../lib/find'
import { commonFields } from '../lib/selection'
import { hasElements } from '../lib/defaults'
import type { CircuitJSON, SolveResult } from '../types/circuit'
import { toCircuitJSON, useCircuitStore } from './circuitStore'
import { useResultsStore } from './resultsStore'

const solved = { converged: true } as SolveResult

function fresh() {
  useCircuitStore.getState().clearAll()
  const s = useCircuitStore.getState()
  const src = s.addNodeAt('vsource', { x: 100, y: 100 })
  const note = s.addNote({ x: 400, y: 100 }, src)
  useResultsStore.setState({ result: solved, stale: false })
  return { src, note }
}

describe('notes', () => {
  beforeEach(() => useCircuitStore.setState({ placementType: null }))

  it('are placed selected, pointing where asked, and end placement mode', () => {
    useCircuitStore.getState().setPlacement('note')
    const { src, note } = fresh()
    const n = useCircuitStore.getState().nodes.find((x) => x.id === note)!
    expect(n.selected).toBe(true)
    expect(n.width).toBe(160)
    expect(n.data.params.target).toBe(src)
    expect(n.data.params.name).toBeUndefined()
    expect(useCircuitStore.getState().placementType).toBeNull()
  })

  it('never make the results stale', () => {
    const { note } = fresh()
    const s = useCircuitStore.getState()
    s.updateNodeParams(note, { text: 'Peak load' })
    s.setNoteWidth(note, 233)
    s.onNodesChange([{ type: 'position', id: note, position: { x: 500, y: 500 } }])
    s.onNodesChange([{ type: 'remove', id: note }])
    expect(useResultsStore.getState().stale).toBe(false)
    expect(useCircuitStore.getState().dirty).toBe(true)
  })

  it('snap their width to the grid, never narrower than 60', () => {
    const { note } = fresh()
    useCircuitStore.getState().setNoteWidth(note, 233)
    expect(useCircuitStore.getState().nodes.find((x) => x.id === note)!.width).toBe(230)
    useCircuitStore.getState().setNoteWidth(note, 10)
    expect(useCircuitStore.getState().nodes.find((x) => x.id === note)!.width).toBe(60)
  })

  it('still let an element edit make them stale', () => {
    const { src } = fresh()
    useCircuitStore.getState().updateNodeParams(src, { pu: 1.02 })
    expect(useResultsStore.getState().stale).toBe(true)
  })

  it('do not rotate or flip', () => {
    const { note } = fresh()
    const s = useCircuitStore.getState()
    s.rotateNodes([note])
    s.flipNodes([note], 'horizontal')
    const p = useCircuitStore.getState().nodes.find((x) => x.id === note)!.data.params
    expect(p.rotation).toBeUndefined()
    expect(p.flip).toBeUndefined()
  })

  it('are found by their text, and do not count as circuit', () => {
    const { note } = fresh()
    useCircuitStore.getState().updateNodeParams(note, { text: 'Replace   recloser\nin 2027' })
    expect(everything().find((h) => h.id === note)?.name).toBe('Replace recloser in 2027')
    expect(hasElements([{ type: 'note' }])).toBe(false)
    expect(hasElements([{ type: 'note' }, { type: 'load' }])).toBe(true)
  })

  it('keep their words and arrows out of bulk edits', () => {
    expect(commonFields(['note', 'note']).map((f) => f.key)).toEqual(['size', 'frame'])
  })

  it('stay beside what they point at through a Clean up, and elsewhere stay put', () => {
    const { src, note } = fresh()
    const loose = useCircuitStore.getState().addNote({ x: 900, y: 900 })
    const c: CircuitJSON = toCircuitJSON(useCircuitStore.getState())
    const pos = (id: string) => c.nodes.find((n) => n.id === id)!.position!
    const offset = { x: pos(note).x - pos(src).x, y: pos(note).y - pos(src).y }
    const looseBefore = { ...pos(loose) }
    autoLayout(c)
    expect(c.nodes).toHaveLength(3)
    expect({ x: pos(note).x - pos(src).x, y: pos(note).y - pos(src).y }).toEqual(offset)
    expect(pos(loose)).toEqual(looseBefore)
  })
})
