// A tidy tree layout, for circuits too large for dagre.
//
// Dagre's crossing minimisation rebuilds a graph per rank on every sweep, so
// its cost grows with nodes times depth, and a real feeder is deep: seven
// seconds and more for the IEEE 8500-node feeder. A radial feeder is a tree,
// and a tree drawn tidily has no crossings to minimise.
//
// Reingold-Tilford by contours: subtrees are laid side by side as close as
// their outlines allow depth by depth -- a long trunk tucks its laterals in
// under one another instead of the drawing growing as wide as all its leaves
// laid end to end -- and each node sits centred over its children. Every
// depth is one row as tall as its tallest box. Edges that close a loop (a
// tie, a parallel path) do not steer the placement.

export interface TreeBox {
  id: string
  /** Box size along the drawing's own axes (before any direction swap). */
  width: number
  height: number
}

export interface TreeOptions {
  /** 'TB': depth runs down the page; 'LR': across it. */
  direction: 'TB' | 'LR'
  /** Space between neighbouring boxes in a row. */
  nodesep: number
  /** Space between rows. */
  ranksep: number
}

/** A laid-out subtree: its outline at every depth (arrays indexed by
 *  absolute depth, holes above it) in a frame of its own, the root's
 *  position in that frame, and its deepest depth. */
interface Outline {
  left: number[]
  right: number[]
  root: number
  deepest: number
}

/** The heaviest child (the trunk carrying on) in the middle and the rest
 *  alternating either side of it, starting on the right at even depths and
 *  on the left at odd ones. Laterals all on one side would each have to
 *  step one column further out than the next to clear it; alternating, a
 *  lateral only has the trunk to clear. With no single heaviest child the
 *  order is left as given. */
function trunkInTheMiddle(kids: string[], count: Map<string, number>, depth: number): string[] {
  if (kids.length < 2) return kids
  let heavy = 0
  let tie = false
  for (let j = 1; j < kids.length; j++) {
    const c = count.get(kids[j])!
    const h = count.get(kids[heavy])!
    if (c > h) [heavy, tie] = [j, false]
    else if (c === h) tie = true
  }
  if (tie) return kids
  const left: string[] = []
  const right: string[] = []
  kids.forEach((k, j) => {
    if (j === heavy) return
    ;((left.length + right.length + depth) % 2 === 0 ? right : left).push(k)
  })
  return [...left.reverse(), kids[heavy], ...right]
}

/** Centre of each box, keyed by id, like dagre's `g.node(id)`. `edges` are
 *  [from, to] pairs pointing away from the roots. */
export function treeLayout(
  boxes: TreeBox[],
  edges: [string, string][],
  opts: TreeOptions,
): Map<string, { x: number; y: number }> {
  const lr = opts.direction === 'LR'
  // Work in (breadth, depth): breadth across a row, depth down the tree.
  const size = new Map(boxes.map((b) => [b.id, lr ? { b: b.height, d: b.width } : { b: b.width, d: b.height }]))
  const children = new Map<string, string[]>()
  const hasParent = new Set<string>()
  for (const [a, b] of edges) {
    if (a === b || hasParent.has(b) || !size.has(a) || !size.has(b)) continue
    hasParent.add(b)
    const list = children.get(a)
    if (list) list.push(b)
    else children.set(a, [b])
  }

  // Depth by breadth-first walk from every root; a node reached twice
  // (a loop) keeps its first parent, and anything a loop left unreached is
  // treated as a root of its own.
  const depth = new Map<string, number>()
  const order: string[] = []
  const roots: string[] = []
  const walk = (root: string) => {
    roots.push(root)
    depth.set(root, 0)
    const queue = [root]
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]
      order.push(id)
      const kids = (children.get(id) ?? []).filter((k) => !depth.has(k))
      children.set(id, kids)
      for (const k of kids) {
        depth.set(k, depth.get(id)! + 1)
        queue.push(k)
      }
    }
  }
  for (const b of boxes) if (!hasParent.has(b.id) && !depth.has(b.id)) walk(b.id)
  for (const b of boxes) if (!depth.has(b.id)) walk(b.id)

  // Each depth's row is as deep as its deepest box.
  const rowDepth: number[] = []
  for (const id of order) {
    const d = depth.get(id)!
    rowDepth[d] = Math.max(rowDepth[d] ?? 0, size.get(id)!.d)
  }
  const rowCentre: number[] = []
  let at = 0
  for (let d = 0; d < rowDepth.length; d++) {
    rowCentre[d] = at + rowDepth[d] / 2
    at += rowDepth[d] + opts.ranksep
  }

  // Lay subtrees side by side as tightly as their outlines allow. The first
  // outline is grown in place (its arrays are not needed afterwards), so a
  // merge costs only the depths the incoming subtree spans. Returns where
  // each subtree's root landed, in the first one's frame.
  const merge = (parts: Outline[], startDepth: number): { acc: Outline; at: number[] } => {
    const acc = parts[0]
    const at = [acc.root]
    for (let i = 1; i < parts.length; i++) {
      const c = parts[i]
      let shift = -Infinity
      const shared = Math.min(acc.deepest, c.deepest)
      for (let d = startDepth; d <= shared; d++) {
        if (acc.right[d] === undefined || c.left[d] === undefined) continue
        shift = Math.max(shift, acc.right[d] + opts.nodesep - c.left[d])
      }
      if (shift === -Infinity) shift = 0
      at.push(c.root + shift)
      for (let d = startDepth; d <= c.deepest; d++) {
        if (c.left[d] === undefined) continue
        if (d <= acc.deepest && acc.left[d] !== undefined) {
          acc.right[d] = c.right[d] + shift
        } else {
          acc.left[d] = c.left[d] + shift
          acc.right[d] = c.right[d] + shift
        }
      }
      acc.deepest = Math.max(acc.deepest, c.deepest)
    }
    return { acc, at }
  }

  // Children before parents: reverse breadth-first order.
  const outline = new Map<string, Outline>()
  const count = new Map<string, number>() // nodes in each subtree
  const offset = new Map<string, number>() // child's breadth relative to its parent
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    const d = depth.get(id)!
    const half = size.get(id)!.b / 2
    let kids = children.get(id) ?? []
    count.set(id, 1 + kids.reduce((n, k) => n + count.get(k)!, 0))
    kids = trunkInTheMiddle(kids, count, d)
    children.set(id, kids)
    if (!kids.length) {
      const o: Outline = { left: [], right: [], root: 0, deepest: d }
      o.left[d] = -half
      o.right[d] = half
      outline.set(id, o)
      continue
    }
    const { acc, at } = merge(kids.map((k) => outline.get(k)!), d + 1)
    // Over the heaviest child when there is one -- the trunk carries on
    // straight down and its laterals branch off to the side, the way a
    // feeder is drawn -- and over the middle of the row otherwise.
    // Centring every pole between the next pole and its lateral walks the
    // trunk diagonally across the page.
    let heavy = 0
    let tie = false
    kids.forEach((k, j) => {
      if (j === 0) return
      const c = count.get(k)!
      const h = count.get(kids[heavy])!
      if (c > h) [heavy, tie] = [j, false]
      else if (c === h) tie = true
    })
    const x = tie || kids.length === 1 ? (at[0] + at[at.length - 1]) / 2 : at[heavy]
    kids.forEach((k, j) => {
      offset.set(k, at[j] - x)
      outline.delete(k)
    })
    acc.left[d] = x - half
    acc.right[d] = x + half
    acc.root = x
    outline.set(id, acc)
  }

  // The roots, side by side the same way, a little further apart.
  const breadth = new Map<string, number>()
  if (roots.length) {
    const parts = roots.map((r) => outline.get(r)!)
    const { at } = merge(parts, 0)
    roots.forEach((r, j) => breadth.set(r, at[j]))
  }
  for (const id of order) {
    if (!breadth.has(id)) continue
    for (const k of children.get(id) ?? []) breadth.set(k, breadth.get(id)! + offset.get(k)!)
  }

  const out = new Map<string, { x: number; y: number }>()
  for (const id of order) {
    const b = breadth.get(id)!
    const d = rowCentre[depth.get(id)!]
    out.set(id, lr ? { x: d, y: b } : { x: b, y: d })
  }
  return out
}
