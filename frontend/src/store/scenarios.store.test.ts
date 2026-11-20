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

  it('three scenarios survive save and load unchanged', () => {
    const st = () => useCircuitStore.getState()
    const brk = st().nodes.find((n) => n.type === 'breaker')!
    const load = st().nodes.find((n) => n.type === 'load')!
    st().addScenario('Breaker open')
    st().updateNodeParams(brk.id, { closed: false })
    st().addScenario('Load up')
    st().updateNodeParams(load.id, { kw: 1500 })
    st().addScenario('PV added')
    st().addNodeAt('pvsystem', { x: 600, y: 600 })
    st().activateScenario(null)
    const saved = JSON.parse(JSON.stringify(toCircuitJSON(st())))
    expect(saved.scenarios).toHaveLength(3)
    st().loadCircuit(JSON.parse(JSON.stringify(saved)))
    expect(JSON.parse(JSON.stringify(toCircuitJSON(st())))).toEqual(saved)
  })

  it('reorders, and promotes a scenario to the base with the others rebased', () => {
    const st = () => useCircuitStore.getState()
    const brk = st().nodes.find((n) => n.type === 'breaker')!
    const load = st().nodes.find((n) => n.type === 'load')!
    const kw0 = load.data.params.kw
    const a = st().addScenario('Load up')
    st().updateNodeParams(load.id, { kw: 1500 })
    const b = st().addScenario('Breaker open')
    st().updateNodeParams(brk.id, { closed: false })
    st().activateScenario(null)
    st().moveScenario(b, -1)
    expect(st().scenarios.map((x) => x.id)).toEqual([b, a])
    st().moveScenario(b, -1) // already first: nothing
    expect(st().scenarios.map((x) => x.id)).toEqual([b, a])

    st().promoteScenario(a)
    // The base is now "Load up"...
    expect(st().nodes.find((n) => n.id === load.id)!.data.params.kw).toBe(1500)
    expect(st().scenarios.map((x) => x.id)).toEqual([b])
    // ...and "Breaker open" still means what it meant: the old base's load,
    // breaker open -- so it now carries the load change back as well.
    st().activateScenario(b)
    expect(st().nodes.find((n) => n.id === brk.id)!.data.params.closed).toBe(false)
    expect(st().nodes.find((n) => n.id === load.id)!.data.params.kw).toBe(kw0)
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

describe('utility outage', () => {
  it('takes the utility out, makes every generator isochronous, and opens it', async () => {
    const campus = (await import('../../../src/opendss_designer/samples/installation-campus.oneline.json')).default
    useCircuitStore.getState().loadCircuit(JSON.parse(JSON.stringify(campus)) as unknown as CircuitJSON)
    const id = useCircuitStore.getState().addUtilityOutageScenario()!
    const s = useCircuitStore.getState()
    expect(s.activeScenario).toBe(id)
    const sc = s.scenarios.find((x) => x.id === id)!
    expect(sc.name).toBe('Utility outage')
    expect(sc.overrides).toEqual({
      util: { enabled: false },
      gen1: { enabled: true, islandMode: 'isochronous' },
      gen2: { enabled: true, islandMode: 'isochronous' },
    })
    expect(s.nodes.find((n) => n.id === 'util')!.data.params.enabled).toBe(false)
    // A second one gets its own name.
    useCircuitStore.getState().addUtilityOutageScenario()
    expect(useCircuitStore.getState().scenarios.map((x) => x.name).filter((n) => /^Utility outage( \d)?$/.test(n)))
      .toEqual(['Utility outage', 'Utility outage 2'])
  })
})
