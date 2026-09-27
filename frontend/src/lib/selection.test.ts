import { describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/full-circuit.oneline.json'
import sample13 from '../../../src/opendss_designer/samples/ieee-13-bus.oneline.json'
import { fromCircuitJSON } from '../store/circuitStore'
import type { CircuitJSON } from '../types/circuit'
import {
  allOfType, applyNumberEdit, commonFields, commonValue, downstreamOf, isRelativeEdit,
  matchesFilter, onPhase,
} from './selection'

const ieee13 = fromCircuitJSON(sample13 as unknown as CircuitJSON)
const name = (id: string) =>
  String(ieee13.nodes.find((n) => n.id === id)?.data.params.name ?? ieee13.edges.find((e) => e.id === id)?.data?.params.name)
const busId = (busName: string) =>
  ieee13.nodes.find((n) => n.type === 'busbar' && n.data.params.name === busName)!.id

describe('downstreamOf', () => {
  it('picks a whole lateral from its bus, and nothing upstream', () => {
    const picked = downstreamOf(ieee13.nodes, ieee13.edges, { kind: 'node', id: busId('671') })
    const names = new Set(picked.nodeIds.map(name))
    // 671 feeds 680, 684, 611, 652, 692 and 675 (through the switch).
    for (const b of ['671', '680', '684', '611', '652', '692', '675']) expect(names).toContain(b)
    for (const b of ['632', '650', '633', '634', '645', '646', 'sourcebus']) expect(names).not.toContain(b)
    // The loads at 675 come along; the source does not.
    expect([...names].some((n) => n.startsWith('675'))).toBe(true)
    expect(names.has('source')).toBe(false)
  })

  it('from a line, takes what the line feeds', () => {
    const line = ieee13.edges.find((e) => e.data?.params.name === '684652')!
    const picked = downstreamOf(ieee13.nodes, ieee13.edges, { kind: 'edge', id: line.id })
    const names = new Set(picked.nodeIds.map(name))
    expect(names).toEqual(new Set(['652']))
    expect(picked.edgeIds).toContain(line.id)
  })

  it('falls back to the connected component of an island', () => {
    const { nodes, edges } = fromCircuitJSON(fixture as unknown as CircuitJSON)
    const noSource = nodes.filter((n) => n.type !== 'vsource')
    const picked = downstreamOf(noSource, edges, { kind: 'node', id: 'n_bus3' })
    expect(picked.nodeIds).toContain('n_bus3')
    expect(picked.nodeIds).toContain('n_cap')
  })
})

describe('allOfType / onPhase', () => {
  it('lists loads, and only those on a phase', () => {
    const loads = allOfType(ieee13.nodes, ieee13.edges, 'load')
    expect(loads.nodeIds.length).toBe(15)
    const onB = loads.nodeIds.filter((id) => onPhase(ieee13.nodes.find((n) => n.id === id)!.data.params, 'B'))
    // 671 (3φ), 634b, 645, 646 (B-C), 675b, 670b.
    expect(onB.map(name).sort()).toEqual(['634b', '645', '646', '670b', '671', '675b'])
    expect(allOfType(ieee13.nodes, ieee13.edges, 'line').edgeIds.length).toBe(11)
  })
})

describe('commonFields / commonValue', () => {
  it('keeps only the fields every type has, never the name', () => {
    const keys = commonFields(['load', 'pvsystem']).map((f) => f.key)
    expect(keys).not.toContain('name')
    expect(keys).toContain('loadshape')
    expect(keys).toContain('phasing')
    expect(keys).not.toContain('pmpp')
    expect(commonFields(['load']).map((f) => f.key)).toContain('kw')
  })
  it('reports a shared value or mixed', () => {
    expect(commonValue([1, 1, 1])).toEqual({ value: 1, mixed: false })
    expect(commonValue([1, 2])).toEqual({ value: undefined, mixed: true })
    expect(commonValue([undefined, null])).toEqual({ value: undefined, mixed: false })
  })
})

describe('applyNumberEdit', () => {
  it('sets, scales and shifts', () => {
    expect(applyNumberEdit('100', 40)).toBe(100)
    expect(applyNumberEdit('×1.1', 40)).toBeCloseTo(44)
    expect(applyNumberEdit('x1.5', 40)).toBe(60)
    expect(applyNumberEdit('*2', 40)).toBe(80)
    expect(applyNumberEdit('/2', 40)).toBe(20)
    expect(applyNumberEdit('+5', 40)).toBe(45)
    expect(applyNumberEdit('-5', 40)).toBe(35)
    expect(applyNumberEdit('=-5', 40)).toBe(-5)
    expect(applyNumberEdit('abc', 40)).toBeNull()
    expect(applyNumberEdit('×1.1', undefined)).toBeNull()
    expect(isRelativeEdit('×1.1')).toBe(true)
    expect(isRelativeEdit('-5')).toBe(true)
    expect(isRelativeEdit('5')).toBe(false)
  })
})

describe('matchesFilter', () => {
  const p = { name: 'S701a', kw: 140, kv: 4.8, loadshape: 'day24', phasing: 'AB', model: 1 }
  it('matches names, numbers and text', () => {
    expect(matchesFilter(p, '701')).toBe(true)
    expect(matchesFilter(p, 'kw>100')).toBe(true)
    expect(matchesFilter(p, 'kw>200')).toBe(false)
    expect(matchesFilter(p, 'kv=4.8 model!=2')).toBe(true)
    expect(matchesFilter(p, 'loadshape:day')).toBe(true)
    expect(matchesFilter(p, 'phasing=ab')).toBe(true)
    expect(matchesFilter(p, 'kw>=140 kw<=140')).toBe(true)
    expect(matchesFilter(p, 'missing>1')).toBe(false)
    expect(matchesFilter(p, '')).toBe(true)
  })
})
