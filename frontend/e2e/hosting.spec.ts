import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { menu } from './menu'

const fixturePath = fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

async function open(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate((c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c), fixture)
  await expect(page.locator('.react-flow__node')).toHaveCount(fixture.nodes.length)
}

test('the Hosting tab runs a study, colours the drawing and exports', async ({ page }) => {
  await open(page)
  await page.locator('.bp-header').getByRole('button', { name: 'Studies', exact: true }).click()
  const panel = page.locator('.hosting-panel')
  await panel.getByRole('combobox', { name: 'Method' }).selectOption('sensitivity')
  await panel.getByRole('button', { name: 'Run' }).click()
  await expect(panel.locator('table tbody tr').first()).toBeVisible({ timeout: 60_000 })
  await expect(panel.locator('.reliability-index').first()).toContainText('hosting capacity')
  // The overlay colours the buses and shows a legend.
  await panel.getByRole('button', { name: 'Show on the drawing' }).click()
  await expect(page.getByRole('list', { name: 'Hosting capacity' })).toBeVisible()
  await expect(page.locator('.react-flow__node[data-id="n_load"] .result-badge')).toContainText(/kW|MW/)
  // Exports produce files.
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'GeoJSON' }).click()])
  expect(download.suggestedFilename()).toMatch(/hosting-capacity\.geojson$/)
})

test('a DER is screened from the Analysis menu', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: /Solve/ }).first().click()
  await expect(page.locator('.status-line')).toContainText('Converged', { timeout: 20_000 })
  await menu(page, 'Analysis', 'Screen a DER interconnection…')
  const dialog = page.getByRole('dialog', { name: 'Screen a DER' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('spinbutton', { name: 'Size kW' }).fill('50')
  await dialog.getByRole('button', { name: 'Run the screens' }).click()
  await expect(dialog.locator('.screen-outcome')).toBeVisible({ timeout: 30_000 })
  // Eight screens, nine when the aggregate screen fails and the minimum-load one follows.
  expect(await dialog.locator('table tbody tr').count()).toBeGreaterThanOrEqual(8)
  await expect(dialog.locator('table')).toContainText('Effective grounding')
})

test('Model QA checks the model from the Studies tab', async ({ page }) => {
  await open(page)
  await page.locator('.bp-header').getByRole('button', { name: 'Studies', exact: true }).click()
  await page.locator('.studies-side').getByRole('button', { name: 'Model QA' }).click()
  await page.getByRole('button', { name: 'Check the model' }).click()
  await expect(page.locator('.study .reliability-index').first()).toContainText('Completeness', { timeout: 20_000 })
  await expect(page.locator('.study table tbody tr').first()).toBeVisible()
})
