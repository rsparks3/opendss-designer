import { beforeEach, describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/full-circuit.oneline.json'
import type { CircuitJSON } from '../types/circuit'
import { toCircuitJSON, useCircuitStore } from './circuitStore'
import { useResultsStore } from './resultsStore'

const FIXTURE = fixture as unknown as CircuitJSON

describe('scenarios in the store', () => {
  beforeEach(() => {
    useCircuitStore.getState().loadCircuit(JSON.parse(JSON.stringify(FIXTURE)))
    useCircuitStore.getState().activateScenario(null)
    useCircuitStore.setState({ scenarios: [], activeScenario: null, scenarioBase: null, loadLevels: null, activeLevel: null })
  })

  it('edits inside a scenario become deltas; the base is untouched', () => {
    const s = useCircuitStore.getState()
    const brk = s.nodes.find((n) => n.type === 'breaker')!
    const id = s.addScenario('Open the breaker')
    expect(useCircuitStore.getState().activeScenario).toBe(id)
    useCircuitStore.getState().updateNodeParams(brk.id, { closed: false })
    // The document written while the scenario is open: base nodes + deltas.
    const json = toCircuitJSON(useCircuitStore.getState())
    expect(json.nodes.find((n) => n.id === brk.id)!.params.closed).not.toBe(false)
    expect(json.activeScenario).toBe(id)
    expect(json.scenarios![0].overrides).toEqual({ [brk.id]: { closed: false } })
    // Back to the base: the drawing is the base again, the deltas stay.
    useCircuitStore.getState().activateScenario(null)
    const after = useCircuitStore.getState()
    expect(after.nodes.find((n) => n.id === brk.id)!.data.params.closed).not.toBe(false)
    expect(after.scenarios[0].overrides).toEqual({ [brk.id]: { closed: false } })
    expect(after.scenarioBase).toBeNull()
    // And reopening applies them.
    useCircuitStore.getState().activateScenario(id)
    expect(useCircuitStore.getState().nodes.find((n) => n.id === brk.id)!.data.params.closed).toBe(false)
  })

  it('adding and removing elements in a scenario round-trips through the document', () => {
    const s = useCircuitStore.getState()
    const id = s.addScenario('Add PV, drop a load')
    const load = useCircuitStore.getState().nodes.find((n) => n.type === 'load')!
    const pvId = useCircuitStore.getState().addNodeAt('pvsystem', { x: 500, y: 500 })
    useCircuitStore.getState().onNodesChange([{ type: 'remove', id: load.id }])
    const json = toCircuitJSON(useCircuitStore.getState())
    const sc = json.scenarios!.find((x) => x.id === id)!
    expect(sc.addedNodes.map((n) => n.id)).toEqual([pvId])
    expect(sc.removed).toContain(load.id)
    expect(json.nodes.some((n) => n.id === load.id)).toBe(true)
    expect(json.nodes.some((n) => n.id === pvId)).toBe(false)
    // Load that document fresh: the open scenario is reopened on the base.
    useCircuitStore.getState().loadCircuit(json)
    const st = useCircuitStore.getState()
    expect(st.activeScenario).toBe(id)
    expect(st.nodes.some((n) => n.id === pvId)).toBe(true)
    expect(st.nodes.some((n) => n.id === load.id)).toBe(false)
    expect(st.scenarioBase!.nodes.some((n) => n.id === load.id)).toBe(true)
    expect(st.dirty).toBe(false)
  })

  it('duplicate, rename and remove', () => {
    const s = useCircuitStore.getState()
    const id = s.addScenario('A')
    const copy = useCircuitStore.getState().duplicateScenario(id)!
    expect(useCircuitStore.getState().scenarios.map((x) => x.name)).toEqual(['A', 'A (copy)'])
    useCircuitStore.getState().updateScenario(copy, { name: 'B', description: 'why' })
    expect(useCircuitStore.getState().scenarios[1]).toMatchObject({ name: 'B', description: 'why' })
    useCircuitStore.getState().removeScenario(id)
    const st = useCircuitStore.getState()
    expect(st.scenarios.map((x) => x.id)).toEqual([copy])
    expect(st.activeScenario).toBeNull()
  })

  it('load levels: the active one follows renames and removals', () => {
    const s = useCircuitStore.getState()
    s.setLoadLevels([{ name: 'Peak', loadmult: 1, rating: 'normal' }, { name: 'Min', loadmult: 0.3, rating: 'normal' }])
    useCircuitStore.getState().setActiveLevel('Min')
    expect(useCircuitStore.getState().activeLevel).toBe('Min')
    expect(toCircuitJSON(useCircuitStore.getState())).toMatchObject({ activeLevel: 'Min' })
    useCircuitStore.getState().setLoadLevels([{ name: 'Peak', loadmult: 1, rating: 'normal' }])
    expect(useCircuitStore.getState().activeLevel).toBeNull()
    useCircuitStore.getState().setActiveLevel('nope')
    expect(useCircuitStore.getState().activeLevel).toBeNull()
    useCircuitStore.getState().setLoadLevels(null)
    expect(toCircuitJSON(useCircuitStore.getState()).loadLevels).toBeUndefined()
  })

  it('a level change marks the results stale', () => {
    useResultsStore.setState({ stale: false })
    useCircuitStore.getState().setLoadLevels([{ name: 'Peak', loadmult: 1, rating: 'normal' }])
    useResultsStore.setState({ stale: false })
    useCircuitStore.getState().setActiveLevel('Peak')
    expect(useResultsStore.getState().stale).toBe(true)
  })
})
