// Handle hit-testing for the connection-grab gesture (see store/grabStore.ts).
//
// React Flow tags every rendered handle with data-nodeid/data-handleid, so the
// drop target can be found straight from the DOM without reaching into the
// library's internals. The geometry half is a pure function so it unit-tests
// without a browser.

export interface HandleCandidate {
  nodeId: string
  handleId: string
  /** Handle centre in client (screen) coordinates. */
  x: number
  y: number
}

/** Closest candidate within `radius` px of (x, y), or null if none is near. */
export function nearestHandle(
  candidates: HandleCandidate[],
  x: number,
  y: number,
  radius: number,
): HandleCandidate | null {
  let best: HandleCandidate | null = null
  let bestD = radius * radius
  for (const c of candidates) {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2
    if (d <= bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

/** Every handle currently rendered, with its centre in client coordinates. */
export function collectHandles(root: ParentNode = document): HandleCandidate[] {
  const out: HandleCandidate[] = []
  for (const el of root.querySelectorAll('.react-flow__handle')) {
    const nodeId = el.getAttribute('data-nodeid')
    const handleId = el.getAttribute('data-handleid')
    if (!nodeId || !handleId) continue
    const r = el.getBoundingClientRect()
    out.push({ nodeId, handleId, x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }
  return out
}
