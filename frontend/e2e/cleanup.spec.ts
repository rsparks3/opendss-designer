import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url)),
    'utf-8',
  ),
)

const state = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const s = (window as any).opendssDesigner.circuit.getState()
    const load = s.nodes.find((n: any) => n.id === 'n_load2')
    const wire = s.edges.find((e: any) => e.source === 'n_load2' || e.target === 'n_load2')
    const busId = wire.source === 'n_load2' ? wire.target : wire.source
    const bus = s.nodes.find((n: any) => n.id === busId)
    return { load: load.position, bus: bus.position, busWidth: bus.width, rotation: load.data.params.rotation }
  })

test('Clean up hangs a stray load back under its bus, and Undo puts it back', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate((c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c), fixture)

  // Drag the load far away and rotate it, as a messy import would leave it.
  await page.evaluate(() => {
    const s = (window as any).opendssDesigner.circuit.getState()
    s.onNodesChange([{ id: 'n_load2', type: 'position', position: { x: -900, y: -700 }, dragging: false }])
    s.updateNodeParams('n_load2', { rotation: 90 })
  })
  const before = await state(page)
  expect(before.load.x).toBe(-900)

  await page.getByRole('button', { name: /Clean up/ }).click()
  const after = await state(page)
  expect(after.rotation).toBeUndefined()
  expect(after.load.y).toBeGreaterThan(after.bus.y)
  expect(after.load.x + 20).toBeGreaterThanOrEqual(after.bus.x)
  expect(after.load.x + 20).toBeLessThanOrEqual(after.bus.x + after.busWidth)

  await page.getByRole('button', { name: /Undo/ }).click()
  const undone = await state(page)
  expect(undone.rotation).toBe(90)
  expect(undone.load).toEqual(before.load)
})
