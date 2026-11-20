import { describe, expect, it } from 'vitest'
import campusJson from '../../../src/opendss_designer/samples/installation-campus.oneline.json'
import loopJson from '../../../src/opendss_designer/samples/looped-two-source.oneline.json'
import ieee13Json from '../../../src/opendss_designer/samples/ieee-13-bus.oneline.json'
import { fromCircuitJSON } from '../store/circuitStore'
import type { CircuitJSON, Params } from '../types/circuit'
import {
  buildTopology, busPriorities, downstream, firstProtectiveUpstream, highlightOf, upstreamPaths,
} from './trace'

// The same cases as tests/test_trace.py, so the drawing and the server agree.

const load = (json: unknown, patches: Record<string, Params> = {}) => {
  const c = fromCircuitJSON(json as CircuitJSON)
  const nodes = c.nodes.map((n) => (patches[n.id] ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patches[n.id] } } } : n))
  const edges = c.edges.map((e) => (patches[e.id] ? { ...e, data: { ...e.data!, params: { ...e.data!.params, ...patches[e.id] } } } : e))
  return buildTopology(nodes, edges)
}
const loadsBelow = (topo: ReturnType<typeof buildTopology>, id: string) =>
  new Set(downstream(topo, id).loads.rows.map((r) => r.id))

describe('trace: IEEE 13-bus', () => {
  it('every load has one path, to the substation', () => {
    const topo = load(ieee13Json)
    const loads = [...topo.nodes.values()].filter((n) => n.type === 'load')
    expect(loads.length).toBe(15)
    for (const n of loads) {
      const paths = upstreamPaths(topo, n.id)
      expect(paths.length).toBe(1)
      expect(paths[0].elements.length).toBe(paths[0].buses.length - 1)
    }
    const head = [...topo.nodes.values()].find((n) => n.data.params.name === 'sub')!
    expect(loadsBelow(topo, head.id)).toEqual(new Set(loads.map((n) => n.id)))
  })
})

describe('trace: installation campus', () => {
  it('a feeder breaker drops its feeder, a fuse its lateral', () => {
    const topo = load(campusJson)
    expect(loadsBelow(topo, 'brk_f1')).toEqual(new Set(['ld_hosp', 'ld_clinic']))
    expect(loadsBelow(topo, 'fu_clinic')).toEqual(new Set(['ld_clinic']))
    expect(loadsBelow(topo, 'brk_f3')).toEqual(new Set(['ld_hous', 'ld_school']))
    expect(loadsBelow(topo, 'brk_t')).toEqual(new Set(['ld_ops', 'ld_comms', 'ld_wh', 'ld_dining', 'ld_hous', 'ld_school']))
    expect(loadsBelow(topo, 'bus_hosp')).toEqual(new Set(['ld_hosp', 'ld_clinic']))
    expect(loadsBelow(topo, 'util').size).toBe(8)
  })

  it('totals by priority, critical first', () => {
    const { rows, byPriority } = downstream(load(campusJson), 'util').loads
    expect(byPriority.critical.kw).toBeCloseTo(1650)
    expect(byPriority.essential.kw).toBeCloseTo(850)
    expect(byPriority.nonessential.numcust).toBe(301)
    expect(rows[0].priority).toBe('critical')
  })

  it('a closed tie makes a loop; open and out-of-service elements break paths', () => {
    expect(loadsBelow(load(campusJson, { brk_tie: { closed: true } }), 'brk_f3').size).toBe(0)
    const open = load(campusJson, { brk_f3: { closed: false } })
    expect(upstreamPaths(open, 'ld_hous')).toEqual([])
    expect(loadsBelow(open, 'brk_f3').size).toBe(0)
    expect(upstreamPaths(load(campusJson, { ln_f1: { enabled: false } }), 'ld_hosp')).toEqual([])
  })

  it('first protective device upstream', () => {
    const topo = load(campusJson)
    expect(firstProtectiveUpstream(topo, 'ld_clinic')).toBe('fu_clinic')
    expect(firstProtectiveUpstream(topo, 'ld_hosp')).toBe('brk_f1')
    expect(firstProtectiveUpstream(topo, 'brk_f1')).toBe('brk_m')
  })

  it('an isochronous generator is a source; one in grid mode is not', () => {
    const iso = load(campusJson, { util: { enabled: false }, gen1: { enabled: true, islandMode: 'isochronous' } })
    expect([...iso.sources.keys()]).toEqual(['gen1'])
    expect(upstreamPaths(iso, 'ld_hosp')[0].sourceId).toBe('gen1')
    const grid = load(campusJson, { util: { enabled: false }, gen1: { enabled: true, islandMode: 'grid' } })
    expect(grid.sources.size).toBe(0)
  })

  it('busbars take the highest priority they would drop', () => {
    const pr = busPriorities(load(campusJson))
    expect(pr.get('bus_hosp')).toBe('critical')
    expect(pr.get('bus_a')).toBe('critical')
    expect(pr.get('bus_hous')).toBe('essential')
    expect(pr.get('bus_wh')).toBe('essential')
    // With the tie closed the housing bus still drops its own loads, but the
    // support bus no longer drops housing (it has another way round).
    const tied = busPriorities(load(campusJson, { brk_tie: { closed: true } }))
    expect(tied.get('bus_hous')).toBe('essential')
  })

  it('lights the path: the elements, busbars and wires along it', () => {
    const topo = load(campusJson)
    const [path] = upstreamPaths(topo, 'ld_clinic')
    const lit = highlightOf(topo, path.buses, path.elements)
    for (const id of ['fu_clinic', 'bus_hosp', 'brk_f1', 'bus_a', 'brk_m', 't1']) expect(lit.nodeIds).toContain(id)
    expect(lit.edgeIds).toContain('ln_f1')
    expect(lit.nodeIds).not.toContain('brk_f2')
  })
})

describe('trace: two sources on a loop', () => {
  it('a path to each source; the loop drops nothing, the spur fuse its spur', () => {
    const topo = load(loopJson)
    const paths = upstreamPaths(topo, 'ld_c')
    expect(paths.map((p) => p.sourceId)).toEqual(['sa', 'sb'])
    expect(paths[0].elements).toEqual(['l1'])
    expect(paths[1].elements).toEqual(['l3', 'l2'])
    expect(loadsBelow(topo, 'l2').size).toBe(0)
    expect(loadsBelow(topo, 'sa').size).toBe(0)
    expect(loadsBelow(topo, 'fu_e')).toEqual(new Set(['ld_e']))
    expect(loadsBelow(topo, 'bus_d')).toEqual(new Set(['ld_d', 'ld_e']))
    const pr = busPriorities(topo)
    expect(pr.get('bus_c')).toBe('critical')
    expect(pr.get('bus_e')).toBe('nonessential')
    expect(pr.get('bus_d')).toBe('essential')
  })
})

describe('traceView', () => {
  it('upstream lights the source and the path, not the other wires on its buses', async () => {
    const { traceView } = await import('./trace')
    const c = fromCircuitJSON(campusJson as unknown as CircuitJSON)
    const v = traceView(c.nodes, c.edges, 'upstream', 'ld_clinic')!
    for (const id of ['util', 't1', 'brk_m', 'bus_a', 'brk_f1', 'bus_hosp', 'fu_clinic', 'xf_clinic', 'ld_clinic']) expect(v.nodeIds).toContain(id)
    for (const id of ['w_util', 'w_m', 'ln_f1', 'w_clinic_f', 'w_clinic_l']) expect(v.edgeIds).toContain(id)
    for (const id of ['w_t_a', 'w_g1', 'w_hosp_x']) expect(v.edgeIds).not.toContain(id)
    const d = traceView(c.nodes, c.edges, 'downstream', 'brk_f1')!
    for (const id of ['w_g1', 'w_hosp_x', 'ln_f1', 'gen1']) expect([...d.edgeIds, ...d.nodeIds]).toContain(id)
  })
})

describe('islands', () => {
  it('a dark part is its own grey island; an isochronous generator lights its own', async () => {
    const { islandsOf, islandColorOf, DARK_ISLAND } = await import('./trace')
    const open = load(campusJson, { brk_f3: { closed: false } })
    const parts = islandsOf(open)
    expect(parts.filter((p) => p.energized).map((p) => p.sources)).toEqual([['util']])
    const c = fromCircuitJSON(campusJson as unknown as CircuitJSON)
    const nodes = c.nodes.map((n) => (n.id === 'util' ? { ...n, data: { ...n.data, params: { ...n.data.params, enabled: false } } }
      : n.id === 'gen1' || n.id === 'gen2' ? { ...n, data: { ...n.data, params: { ...n.data.params, enabled: true, islandMode: 'isochronous' } } }
        : n.id === 'brk_t' ? { ...n, data: { ...n.data, params: { ...n.data.params, closed: false } } } : n))
    const a = islandColorOf(nodes, c.edges, 'ld_hosp')
    const b = islandColorOf(nodes, c.edges, 'ld_ops')
    expect(a).toBeDefined()
    expect(a).not.toBe(b)
    expect(a).not.toBe(DARK_ISLAND)
    expect(islandColorOf(nodes, c.edges, 'w_g1')).toBe(a) // a wire takes its bus's island
  })
})
