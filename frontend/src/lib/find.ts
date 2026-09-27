import { useCircuitStore } from '../store/circuitStore'

/** Edit → Find: what can be found, and in what order. */

export interface Hit {
  kind: 'node' | 'edge'
  id: string
  name: string
  type: string
  /** Nodes to frame: the node itself, or a line's two ends. */
  frame: string[]
}

/** Every element with a name, busbars included (by bus name). */
export function everything(): Hit[] {
  const { nodes, edges } = useCircuitStore.getState()
  const hits: Hit[] = nodes.map((n) => ({
    kind: 'node',
    id: n.id,
    name: String(n.data.params.name ?? ''),
    type: n.type ?? '',
    frame: [n.id],
  }))
  for (const e of edges) {
    if (e.type !== 'line') continue
    hits.push({ kind: 'edge', id: e.id, name: String(e.data?.params?.name ?? ''), type: 'line', frame: [e.source, e.target] })
  }
  return hits.filter((h) => h.name)
}

/** Names that start with the query come first, then names containing it. */
export function rankHits(hits: Hit[], query: string, limit = 12): Hit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const starts: Hit[] = []
  const contains: Hit[] = []
  for (const h of hits) {
    const n = h.name.toLowerCase()
    if (n.startsWith(q)) starts.push(h)
    else if (n.includes(q)) contains.push(h)
  }
  const byName = (a: Hit, b: Hit) => a.name.localeCompare(b.name, undefined, { numeric: true })
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, limit)
}
