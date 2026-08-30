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

test('shapes tab: edit a loadshape via CSV paste', async ({ page }) => {
  await openWithFixture(page)
  await page.getByRole('button', { name: 'Shapes' }).click()
  // The fixture ships a day24 shape, already assigned to the load.
  await page.locator('.shapes-item', { hasText: 'day24' }).click()
  await expect(page.locator('.shape-chart')).toBeVisible()

  const values = Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 18 ? 1 : 0.4))
  await page.locator('.shapes-csv textarea').fill(values.join('\n'))
  await page.getByRole('button', { name: /Load CSV into/ }).click()
  await expect(page.locator('.flash-toast')).toContainText('24 points')
})

test('shape kinds: two library tabs, PV dropdown filtered to irradiance', async ({ page }) => {
  await openWithFixture(page)
  await page.getByRole('button', { name: 'Shapes' }).click()
  // Load tab (default) lists day24 but not the irradiance shape.
  await expect(page.locator('.shapes-item', { hasText: 'day24' })).toBeVisible()
  await expect(page.locator('.shapes-item', { hasText: 'sun24' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Irradiance' }).click()
  await expect(page.locator('.shapes-item', { hasText: 'sun24' })).toBeVisible()
  await expect(page.locator('.shapes-item', { hasText: 'day24' })).toHaveCount(0)
  // The NSRDB fetcher lives under the irradiance tab.
  await expect(page.getByRole('button', { name: /Fetch NSRDB irradiance/ })).toBeVisible()

  // The PV system's shape dropdown offers only irradiance shapes.
  await page.locator('.react-flow__node-pvsystem').click()
  const pvSelect = page
    .locator('.prop-row', { hasText: 'Irradiance shape' })
    .locator('select')
  const options = await pvSelect.locator('option').allTextContents()
  expect(options.join(',')).toContain('sun24')
  expect(options.join(',')).not.toContain('day24')
})

test('NSRDB fetch prompts for the NLR API key on first use', async ({ page }) => {
  await openWithFixture(page)
  await page.getByRole('button', { name: 'Shapes' }).click()
  await page.getByRole('button', { name: 'Irradiance' }).click()
  await page.getByRole('button', { name: /Fetch NSRDB irradiance/ }).click()
  await expect(page.locator('.nsrdb-cred-line')).toContainText("You'll be asked")

  // No saved key: the fetch button opens the prompt instead of fetching.
  await page.getByRole('button', { name: 'Fetch irradiance' }).click()
  const modal = page.locator('.modal-box')
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('developer.nlr.gov/signup')

  // Save stays disabled until both a key and a plausible email are entered.
  const save = modal.getByRole('button', { name: 'Save key' })
  await expect(save).toBeDisabled()
  await modal.locator('input').first().fill('testkey123')
  await modal.locator('input').nth(1).fill('not-an-email')
  await expect(save).toBeDisabled()
  await modal.locator('input').nth(1).fill('ryan@example.com')
  await expect(save).toBeEnabled()

  await modal.getByRole('button', { name: 'Cancel' }).click()
  await expect(modal).toHaveCount(0)
})

test('a remembered NLR key shows masked with a change option', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem(
      'opendss-designer.nlrApiCred',
      JSON.stringify({ apiKey: 'testkey1234', email: 'ryan@example.com' }),
    )
  })
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.getByRole('button', { name: 'Shapes' }).click()
  await page.getByRole('button', { name: 'Irradiance' }).click()
  await page.getByRole('button', { name: /Fetch NSRDB irradiance/ }).click()

  const credLine = page.locator('.nsrdb-cred-line')
  await expect(credLine).toContainText('••••1234')
  await expect(credLine).toContainText('ryan@example.com')

  // 'change' opens the prompt prefilled — and saving from here does NOT fetch.
  await credLine.getByRole('button', { name: 'change' }).click()
  const modal = page.locator('.modal-box')
  await expect(modal.locator('input').first()).toHaveValue('testkey1234')
  await modal.locator('input').first().fill('newkey5678')
  await modal.getByRole('button', { name: 'Save key' }).click()
  await expect(modal).toHaveCount(0)
  await expect(credLine).toContainText('••••5678')
})

test('daily time-series run: progress, Time-mode graph, summary', async ({ page }) => {
  await openWithFixture(page)
  const run = page.getByRole('button', { name: '▶ Run', exact: true })
  await expect(run).toBeEnabled()
  await run.click()

  // Completion opens the Graph tab in Time mode with a summary + polyline.
  await expect(page.locator('.ts-summary')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.ts-summary')).toContainText('MWh')
  await expect(page.locator('.vp-trace').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Time' })).toHaveClass(/active/)

  // Switch to a bus quantity: default picks the lowest-voltage buses.
  await page.getByLabel('Quantity').selectOption({ label: 'Bus V min (pu)' })
  await expect(page.locator('.vp-trace').first()).toBeVisible()
  await expect(page.locator('.ts-picker summary')).toContainText('Buses')

  // Snapshot mode still works after a run.
  await page.getByRole('button', { name: 'Snapshot' }).click()
  await expect(page.locator('.graph-controls').getByLabel('Y axis')).toBeVisible()
})
