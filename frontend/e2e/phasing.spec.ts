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

const phasePicker = (page: Page) =>
  page.locator('.prop-row', { hasText: 'Phase(s)' }).locator('select')

// A feeder is mostly single-phase laterals, so which phase a line is on has to
// be visible on the drawing, not only in the inspector.
test('pinning a line to one phase labels it on the one-line', async ({ page }) => {
  await openWithFixture(page)

  // A 3-phase trunk says nothing by carrying all three.
  await expect(page.locator('.edge-phase')).toHaveCount(0)

  await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState().selectOnly('edge', 'e4'),
  )
  await expect(phasePicker(page)).toBeVisible()
  await phasePicker(page).selectOption('B')

  const chip = page.locator('.edge-phase')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveText('B')

  // Back to all three and the chip goes away again.
  await phasePicker(page).selectOption('ABC')
  await expect(page.locator('.edge-phase')).toHaveCount(0)
})

test('a pin the feeder cannot supply is reported', async ({ page }) => {
  await openWithFixture(page)

  // The panel starts collapsed; Graph opens it, then Problems is a tab in it.
  await page.getByRole('button', { name: 'Graph' }).click()
  await page.getByRole('button', { name: /Problems/ }).click()
  // Every element hangs off a 3-phase feeder, so nothing is short of a phase.
  await expect(page.locator('.bp-empty')).toContainText('No problems')

  // Put the lateral on B and the load on C: the load is now asking for a
  // phase that never reaches its bus.
  await page.evaluate(() => {
    const store = (window as any).opendssDesigner.circuit.getState()
    const line = store.edges.find((e: any) => e.data?.params?.name === 'LN1')
    const load = store.nodes.find((n: any) => n.data?.params?.name === 'LOAD1')
    store.updateEdgeParams(line.id, { phases: 1, phasing: 'B' })
    store.updateNodeParams(load.id, { phases: 1, phasing: 'C' })
  })

  // The chip proves the edit landed before the Problems list is judged.
  await expect(page.locator('.edge-phase')).toHaveText('B')
  await expect(
    page.locator('.problems-list li', { hasText: "'LOAD1' connects to phase C" }).first(),
  ).toBeVisible()
})
