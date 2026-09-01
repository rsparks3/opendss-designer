import { expect, test } from '@playwright/test'
import { NODE_SIZE } from '../src/lib/defaults'
import type { NodeType } from '../src/types/circuit'

const TYPES = (Object.keys(NODE_SIZE) as NodeType[]).filter((t) => t !== 'busbar')

// Every symbol's terminal sits at its container's centre while the canvas snaps
// the container's top-left corner, so a box dimension that is not a multiple of
// SYMBOL_PITCH puts the terminal half a grid step off and every wire to a
// busbar picks up a small permanent bend.
//
// This measures what is actually PAINTED — the handle's DOM rect and the edge
// path's own coordinates — after a real snap-on-drag. Store arithmetic can
// agree while CSS or React Flow's handle measurement shifts the real terminal.
test('every symbol wires to a busbar with no bend', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)

  const circuit = {
    version: 1, name: 'gridcheck',
    nodes: [
      { id: 'bus', type: 'busbar', position: { x: 0, y: 400 }, width: 360, params: { name: 'bus' } },
      ...TYPES.map((t, i) => ({
        id: t, type: t,
        position: {
          x: Math.round(((40 * i + 10) - NODE_SIZE[t].w / 2) / 10) * 10,
          y: 400 - 140 - NODE_SIZE[t].h,
        },
        params: { name: t },
      })),
    ],
    edges: TYPES.map((t, i) => ({
      id: `e${i}`, kind: 'wire', source: t,
      // transformer/breaker are 2-terminal: sitting above the bar they drop
      // from t2 (bottom). The rest expose only t1.
      sourceHandle: t === 'transformer' || t === 'breaker' ? 't2' : 't1',
      target: 'bus', targetHandle: `b${2 * i}`, params: {},
    })),
  }
  await page.evaluate((c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c), circuit as never)
  await expect(page.locator('.react-flow__node')).toHaveCount(TYPES.length + 1)

  for (const t of TYPES) {
    const box = (await page.locator(`.react-flow__node[data-id="${t}"]`).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 6)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 4, box.y + 10, { steps: 4 })
    await page.mouse.up()
  }

  // 1. Every edge path: read the actual d attribute and collect distinct x's.
  const paths = await page.evaluate(() =>
    Array.from(document.querySelectorAll('path.react-flow__edge-path')).map((p) => ({
      id: (p.closest('.react-flow__edge') as HTMLElement | null)?.dataset.id ?? '?',
      d: p.getAttribute('d') ?? '',
    })),
  )
  // Guard against the check passing because nothing was selected.
  expect(paths.length).toBe(TYPES.length)
  expect(paths.every((p) => /[ML]/.test(p.d))).toBe(true)
  // Edge paths are cubic Beziers (M x,y C x,y x,y x,y), so the bend lives in
  // the control points, not just the M/L anchors. Pull the x out of EVERY
  // "x,y" pair: a truly vertical drop has exactly one distinct x across all
  // of them.
  const jogs = paths.filter((p) => {
    const xs = [...p.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[1]))
    return xs.length < 2 || new Set(xs.map((x) => x.toFixed(3))).size !== 1
  })

  // 2. Cross-check against the painted handle rects at zoom 1.
  const rects = await page.evaluate((types: string[]) => {
    const out: Record<string, number> = {}
    for (const t of types) {
      const h = document.querySelector(`.react-flow__node[data-id="${t}"] .react-flow__handle`)!
      const r = h.getBoundingClientRect()
      out[t] = r.x + r.width / 2
    }
    const bus = document.querySelectorAll('.react-flow__node[data-id="bus"] .react-flow__handle')
    types.forEach((t, i) => {
      const r = (bus[2 * i] as HTMLElement).getBoundingClientRect()
      out[`${t}__handle`] = r.x + r.width / 2
    })
    return out
  }, TYPES)
  const domOff = TYPES.filter((t) => Math.abs(rects[t] - rects[`${t}__handle`]) > 0.01)
    .map((t) => `${t}: ${(rects[t] - rects[`${t}__handle`]).toFixed(2)}px`)

  expect(jogs.map((j) => `${j.id} -> ${j.d}`)).toEqual([])
  expect(domOff).toEqual([])
})

// A circuit saved before the boxes went onto SYMBOL_PITCH. The case that needs
// migrating is a node PLACED and never dragged: the old addNodeAt stored
// `click - oldWidth/2` without snapping, so the corner itself sat off-grid
// (a transformer at 170-24 = 146). Loading must come out aligned with no drag
// at all -- an autosave restore does exactly this on every page load.
test('a pre-pitch circuit opens aligned without dragging', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)

  const OLD_W: Record<string, number> = {
    vsource: 48, transformer: 48, load: 40, breaker: 36,
    capacitor: 40, generator: 44, pvsystem: 44, storage: 44,
  }
  const clickX = (i: number) => 40 * i + 10 // where the old build's grid-snapped click landed
  const legacy = {
    version: 1, name: 'legacy',
    nodes: [
      { id: 'bus', type: 'busbar', position: { x: 0, y: 400 }, width: 360, params: { name: 'bus' } },
      ...TYPES.map((t, i) => ({
        id: t, type: t,
        position: { x: clickX(i) - OLD_W[t] / 2, y: 200 },
        params: { name: t },
      })),
    ],
    edges: TYPES.map((t, i) => ({
      id: `e${i}`, kind: 'wire', source: t,
      sourceHandle: t === 'transformer' || t === 'breaker' ? 't2' : 't1',
      target: 'bus', targetHandle: `b${2 * i}`, params: {},
    })),
  }
  // Sanity: these corners really are off-grid, or the test proves nothing.
  const offGrid = TYPES.filter((t, i) => (clickX(i) - OLD_W[t] / 2) % 10 !== 0)
  expect(offGrid.length).toBeGreaterThan(0)

  await page.evaluate((c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c), legacy as never)
  await expect(page.locator('.react-flow__node')).toHaveCount(TYPES.length + 1)

  const paths = await page.evaluate(() =>
    Array.from(document.querySelectorAll('path.react-flow__edge-path')).map((p) => ({
      id: (p.closest('.react-flow__edge') as HTMLElement | null)?.dataset.id ?? '?',
      d: p.getAttribute('d') ?? '',
    })),
  )
  expect(paths.length).toBe(TYPES.length)
  const jogs = paths.filter((p) => {
    const xs = [...p.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[1]))
    return xs.length < 2 || new Set(xs.map((x) => x.toFixed(3))).size !== 1
  })
  expect(jogs.map((j) => `${j.id} -> ${j.d}`)).toEqual([])
})
