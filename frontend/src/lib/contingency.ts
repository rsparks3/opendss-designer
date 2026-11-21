import type { N1Case, N1Options, N1Result, Params } from '../types/circuit'

/**
 * N-1 helpers for the Contingency tab: the solve count a run will cost
 * (studies/contingency.py `estimate_n1_solves`, mirrored so the estimate
 * shows before anything is sent), and the parameter patches that put one
 * row's outage on the drawing -- as a preview or as a kept scenario.
 */

const SWITCHES = new Set(['breaker', 'fuse', 'recloser', 'relay'])

type El = { id: string; type?: string; data?: { params?: Params } }

const inService = (p: Params | undefined) => p?.enabled !== false

function tagsOf(p: Params | undefined): string[] {
  const t = p?.tags
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()) : []
}

/** The tie switches the backend will try: breakers marked *Tie switch*, or
 *  every normally-open breaker when none is marked. */
export function tieIds(nodes: El[]): string[] {
  const live = nodes.filter((n) => n.type === 'breaker' && inService(n.data?.params))
  const marked = live.filter((n) => n.data?.params?.tie === true)
  return (marked.length ? marked : live.filter((n) => n.data?.params?.closed === false)).map((n) => n.id)
}

/** How many elements the sweep takes out. */
export function n1Candidates(nodes: El[], edges: El[], opts: N1Options): number {
  const ties = new Set(tieIds(nodes))
  const exclude = new Set((opts.excludeTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))
  const kept = (p: Params | undefined) => inService(p) && !tagsOf(p).some((t) => exclude.has(t))
  let n = 0
  for (const node of nodes) {
    const p = node.data?.params
    if (!kept(p)) continue
    if (SWITCHES.has(node.type ?? '')) {
      if (opts.candidates !== 'transformers' && p?.closed !== false && !ties.has(node.id)) n++
    } else if ((node.type === 'transformer' || node.type === 'regulator') && opts.candidates !== 'switches') {
      n++
    }
  }
  if (opts.candidates === 'all') {
    for (const e of edges) if (e.type === 'line' && kept(e.data?.params)) n++
  }
  return n
}

/** Solves the run costs: the base, then each outage alone and with each tie. */
export function estimateN1Solves(nodes: El[], edges: El[], opts: N1Options): number {
  return 1 + n1Candidates(nodes, edges, opts) * (1 + tieIds(nodes).length)
}

/** The patches that reproduce a row: the element out (a switch opened, any
 *  other element out of service), the best tie closed, and the standby
 *  generators that row started running isochronous. */
export function n1CaseOverrides(c: N1Case, result: Pick<N1Result, 'base'>, kindOf: (id: string) => string | undefined): Record<string, Params> {
  const out: Record<string, Params> = {}
  out[c.id] = SWITCHES.has(kindOf(c.id) ?? c.kind) ? { closed: false } : { enabled: false }
  if (c.bestTie) out[c.bestTie.tie] = { closed: true }
  const started = new Set([...(result.base.standbyRunning ?? []), ...((c.bestTie ? c.bestTie.standbyStarted : c.standbyStarted) ?? [])])
  for (const id of started) out[id] = { enabled: true, islandMode: 'isochronous' }
  return out
}

/** The name a row's scenario gets. */
export function n1CaseName(c: N1Case): string {
  return c.bestTie ? `N-1: ${c.element} out, ${c.bestTie.tieName} closed` : `N-1: ${c.element} out`
}
