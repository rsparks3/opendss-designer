import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const fixturePath = fileURLToPath(
  new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url),
)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

async function openWithFixture(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate(
    (c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c),
    fixture,
  )
  await expect(page.locator('.react-flow__node')).toHaveCount(fixture.nodes.length)
}

// A substation transformer often has a tertiary. Adding one has to grow the
// symbol a terminal, expose the two extra reactances, and be undoable without
// leaving a wire attached to a terminal that no longer exists.
test('a tertiary winding adds a third terminal and its reactances', async ({ page }) => {
  await openWithFixture(page)
  await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState().selectOnly('node', 'n_xfmr'),
  )
  const xfmr = page.locator('.react-flow__node-transformer')
  await expect(xfmr.locator('[data-handleid="t3"]')).toHaveCount(0)
  await expect(page.locator('.prop-row', { hasText: 'X(H-T)' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Add tertiary winding' }).click()
  await expect(xfmr.locator('[data-handleid="t3"]')).toHaveCount(1)
  await expect(page.locator('.prop-row', { hasText: 'X(H-T)' })).toBeVisible()
  await expect(page.locator('.prop-row', { hasText: 'X(L-T)' })).toBeVisible()
  await expect(page.locator('.winding legend', { hasText: 'Tertiary (t3)' })).toBeVisible()
  await expect(xfmr.locator('.sub-label')).toHaveText('115/12.47/4.16 kV')
  // The new terminal is not wired to anything, which the validator reports.
  await expect(page.getByRole('button', { name: /Solve/ })).toBeDisabled()

  // Wire the tertiary somewhere, then take the winding away again: the wire
  // has nowhere to attach and goes with it.
  const before = await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState().edges.length,
  )
  await page.evaluate(() => {
    const store = (window as any).opendssDesigner.circuit.getState()
    const bus = store.nodes.find((n: any) => n.type === 'busbar')
    store.onConnect({ source: 'n_xfmr', sourceHandle: 't3', target: bus.id, targetHandle: 'b0' })
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).opendssDesigner.circuit.getState().edges.length))
    .toBe(before + 1)

  await page.getByRole('button', { name: 'Remove tertiary winding' }).click()
  await expect(xfmr.locator('[data-handleid="t3"]')).toHaveCount(0)
  await expect(page.locator('.prop-row', { hasText: 'X(H-T)' })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => (window as any).opendssDesigner.circuit.getState().edges.length))
    .toBe(before)
  await expect(page.getByRole('button', { name: /Solve/ })).toBeEnabled()
})
