import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { parsePathPoints, simplifyCollinear } from '../src/lib/edgeGeometry'

// Adding a routing point must not reshape the edge: the corners ReactFlow's
// smoothstep router drew are adopted as waypoints alongside the new point.
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url)),
    'utf-8',
  ),
)

async function openEditor(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate(
    (c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c),
    fixture,
  )
  await page.locator('.react-flow__controls-fitview').click()
  await page.waitForTimeout(300)
}

/** The `d` attribute of an edge's drawn path. */
function pathOf(page: Page, edgeId: string) {
  return page.evaluate(
    (id) =>
      document
        .querySelector(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`)
        ?.getAttribute('d') ?? '',
    edgeId,
  )
}

/** Screen coordinates of a point a fraction of the way along an edge — SVG
 *  gives us both the point and the flow-to-screen matrix. */
function pointOnEdge(page: Page, edgeId: string, fraction: number) {
  return page.evaluate(
    ({ id, fraction }) => {
      const path = document.querySelector(
        `.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`,
      ) as SVGPathElement
      const p = path.getPointAtLength(path.getTotalLength() * fraction)
      const m = path.getScreenCTM()!
      return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
    },
    { id: edgeId, fraction },
  )
}

/** Screen points sampled along an edge. */
function pointsAlongEdge(page: Page, edgeId: string, fractions: number[]) {
  return page.evaluate(
    ({ id, fractions }) => {
      const path = document.querySelector(
        `.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`,
      ) as SVGPathElement
      const m = path.getScreenCTM()!
      const len = path.getTotalLength()
      return fractions.map((f) => {
        const p = path.getPointAtLength(len * f)
        return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
      })
    },
    { id: edgeId, fractions },
  )
}

/** A spot in the middle stretch of an edge, well clear of its routing dots —
 *  double-clicking a dot deliberately removes it, and the ends of a wire are
 *  covered by the symbols it joins. */
async function clearSpotOn(page: Page, edgeId: string) {
  const dots = await Promise.all(
    (await page.locator('.waypoint-dot').all()).map(async (d) => {
      const b = (await d.boundingBox())!
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }),
  )
  const fractions = Array.from({ length: 21 }, (_, i) => 0.25 + (i / 20) * 0.5)
  const candidates = await pointsAlongEdge(page, edgeId, fractions)
  const clearance = (p: { x: number; y: number }) =>
    dots.length ? Math.min(...dots.map((d) => Math.hypot(d.x - p.x, d.y - p.y))) : Infinity
  const best = candidates.reduce((a, b) => (clearance(b) > clearance(a) ? b : a))
  expect(clearance(best)).toBeGreaterThan(12)
  return best
}

function waypointsOf(page: Page, edgeId: string) {
  return page.evaluate(
    (id) =>
      (window as any).opendssDesigner.circuit
        .getState()
        .edges.find((e: any) => e.id === id)?.data?.waypoints ?? [],
    edgeId,
  )
}

// e7 leaves the feeder busbar and elbows down to the capacitor, so it has a
// shape to lose.
const ELBOW_EDGE = 'e7'

test('double-clicking a wire adds a routing point without changing its shape', async ({ page }) => {
  await openEditor(page)
  const before = await pathOf(page, ELBOW_EDGE)
  expect(simplifyCollinear(parsePathPoints(before)).length).toBeGreaterThan(2) // has corners

  const at = await pointOnEdge(page, ELBOW_EDGE, 0.3)
  await page.mouse.dblclick(at.x, at.y)
  await page.waitForTimeout(200)

  // The corners are now waypoints, and the drawn polyline is the same shape.
  const wps = await waypointsOf(page, ELBOW_EDGE)
  expect(wps.length).toBeGreaterThanOrEqual(3)
  const after = await pathOf(page, ELBOW_EDGE)
  expect(simplifyCollinear(parsePathPoints(after))).toEqual(
    simplifyCollinear(parsePathPoints(before)),
  )
})

test('a second routing point keeps the shape too, and dots are draggable', async ({ page }) => {
  await openEditor(page)
  // Zoom in so the dots and the click targets are comfortably apart on screen.
  for (let i = 0; i < 3; i++) await page.locator('.react-flow__controls-zoomin').click()
  await page.waitForTimeout(300)
  const first = await pointOnEdge(page, ELBOW_EDGE, 0.3)
  await page.mouse.dblclick(first.x, first.y)
  await page.waitForTimeout(150)
  const afterFirst = await pathOf(page, ELBOW_EDGE)

  const second = await clearSpotOn(page, ELBOW_EDGE)
  await page.mouse.dblclick(second.x, second.y)
  await page.waitForTimeout(150)

  expect((await waypointsOf(page, ELBOW_EDGE)).length).toBeGreaterThanOrEqual(4)
  expect(simplifyCollinear(parsePathPoints(await pathOf(page, ELBOW_EDGE)))).toEqual(
    simplifyCollinear(parsePathPoints(afterFirst)),
  )

  // The edge is selected after the double-click, so its routing dots show.
  await expect(page.locator('.waypoint-dot').first()).toBeVisible()
})

test('straighten clears the adopted waypoints', async ({ page }) => {
  await openEditor(page)
  const at = await pointOnEdge(page, ELBOW_EDGE, 0.3)
  await page.mouse.dblclick(at.x, at.y)
  await page.waitForTimeout(150)
  expect((await waypointsOf(page, ELBOW_EDGE)).length).toBeGreaterThan(0)

  await page.mouse.click(at.x, at.y, { button: 'right' })
  await page.getByRole('button', { name: /Straighten/ }).click()
  expect(await waypointsOf(page, ELBOW_EDGE)).toEqual([])
})
