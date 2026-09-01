import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from '@playwright/test'

// Re-routing: dragging from a terminal that already holds exactly one wire
// moves that wire's end instead of drawing a second one.
const fixturePath = fileURLToPath(
  new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url),
)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

async function openEditor(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate(
    (c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c),
    fixture,
  )
  await expect(page.locator('.react-flow__node')).toHaveCount(fixture.nodes.length)
  // loadCircuit does not refit the view, and this suite works in screen
  // coordinates — without this the circuit sits partly outside the viewport.
  await page.locator('.react-flow__controls-fitview').click()
  await expect(terminal(page, 'n_bus3', 'c0')).toBeInViewport()
}

function terminal(page: Page, nodeId: string, handleId: string): Locator {
  return page.locator(
    `.react-flow__node[data-id="${nodeId}"] .react-flow__handle[data-handleid="${handleId}"]`,
  )
}

async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('terminal is not visible')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Press a terminal, drag to a point, release. */
async function dragTerminal(page: Page, from: Locator, to: { x: number; y: number }) {
  const start = await centerOf(from)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // Several moves: the gesture only engages past a small drag threshold.
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

/** The circuit's edges, straight from the store. */
function edges(page: Page) {
  return page.evaluate(() =>
    (window as any).opendssDesigner.circuit
      .getState()
      .edges.map((e: any) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
      })),
  )
}

test('dragging an occupied terminal moves that wire instead of adding one', async ({ page }) => {
  await openEditor(page)
  const before = await edges(page)

  // e7 runs from the feeder busbar's c0 handle to the capacitor. Grab it at
  // the busbar end and walk it along the bar to a free handle.
  await dragTerminal(page, terminal(page, 'n_bus3', 'c0'), await centerOf(terminal(page, 'n_bus3', 'c7')))

  const after = await edges(page)
  expect(after).toHaveLength(before.length) // moved, not duplicated
  const moved = after.find((e) => e.id === 'e7')!
  expect(moved.sourceHandle).toBe('c7')
  expect(moved.target).toBe('n_cap') // the far end never moved
  expect(moved.targetHandle).toBe('t1')

  // Electrically identical, so the circuit still solves cleanly.
  const solve = page.getByRole('button', { name: /Solve/ })
  await expect(solve).toBeEnabled()
  await solve.click()
  await expect(
    page.locator('.result-badge').filter({ hasText: 'pu' }).first(),
  ).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.flash-toast.error')).toHaveCount(0)
})

test('a wire dropped on empty canvas snaps back', async ({ page }) => {
  await openEditor(page)
  const before = await edges(page)

  const box = (await page.locator('.react-flow__pane').boundingBox())!
  await dragTerminal(page, terminal(page, 'n_cap', 't1'), { x: box.x + 40, y: box.y + box.height - 40 })

  expect(await edges(page)).toEqual(before)
})

test('a refused drop explains itself and changes nothing', async ({ page }) => {
  await openEditor(page)
  const before = await edges(page)

  // The capacitor's wire already comes from this busbar; dropping its far end
  // back on the same bar would connect the busbar to itself.
  await dragTerminal(page, terminal(page, 'n_cap', 't1'), await centerOf(terminal(page, 'n_bus3', 'c5')))

  await expect(page.locator('.flash-toast')).toContainText(/cannot be connected to itself/i)
  expect(await edges(page)).toEqual(before)
})

test('a free terminal still draws a new wire', async ({ page }) => {
  await openEditor(page)
  const before = await edges(page)

  // n_bus3:c7 holds nothing, so dragging from it is an ordinary connection.
  // The storage element's terminal is occupied, which never stopped a
  // terminal from being a valid drop target.
  await dragTerminal(page, terminal(page, 'n_bus3', 'c7'), await centerOf(terminal(page, 'n_stg', 't1')))

  const after = await edges(page)
  expect(after).toHaveLength(before.length + 1)
})

test('Alt+drag from an occupied terminal draws a new wire instead of moving one', async ({ page }) => {
  await openEditor(page)
  const before = await edges(page)

  await page.keyboard.down('Alt')
  await dragTerminal(page, terminal(page, 'n_bus3', 'c0'), await centerOf(terminal(page, 'n_load', 't1')))
  await page.keyboard.up('Alt')

  const after = await edges(page)
  expect(after).toHaveLength(before.length + 1)
  // The wire that was already on that terminal stayed exactly where it was.
  expect(after.find((e) => e.id === 'e7')).toEqual(before.find((e) => e.id === 'e7'))
})
