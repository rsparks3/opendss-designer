import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { expect, test, type Page } from '@playwright/test'

// The schema fixture doubles as the e2e circuit: every node type, both edge
// types, and it solves cleanly.
const fixturePath = fileURLToPath(
  new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url),
)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

async function openEditor(page: Page) {
  // Start every test from a clean slate (no autosave restore).
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
}

async function loadFixture(page: Page) {
  await page.evaluate(
    (c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c),
    fixture,
  )
  await expect(page.locator('.react-flow__node')).toHaveCount(fixture.nodes.length)
}

test('place a source from the palette onto the canvas', async ({ page }) => {
  await openEditor(page)
  await page.getByRole('button', { name: 'Source' }).click()
  await page.locator('.react-flow__pane').click({ position: { x: 300, y: 200 } })
  await expect(page.locator('.react-flow__node-vsource')).toHaveCount(1)
  // Placement is sticky until Escape. (Click far from the pane center: the
  // initial fitView centers the first node there, and clicking a node
  // selects it instead of placing.)
  await page.locator('.react-flow__pane').click({ position: { x: 150, y: 330 } })
  await expect(page.locator('.react-flow__node-vsource')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await page.locator('.react-flow__pane').click({ position: { x: 620, y: 90 } })
  await expect(page.locator('.react-flow__node-vsource')).toHaveCount(2)
})

test('keyboard: place with S, copy/paste with Ctrl+C/V', async ({ page }) => {
  await openEditor(page)
  await page.keyboard.press('s')
  await page.locator('.react-flow__pane').click({ position: { x: 300, y: 200 } })
  await expect(page.locator('.react-flow__node-vsource')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.locator('.react-flow__node-vsource').click()
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect(page.locator('.react-flow__node-vsource')).toHaveCount(2)
})

test('right-click context menu duplicates a node', async ({ page }) => {
  await openEditor(page)
  await page.keyboard.press('l')
  await page.locator('.react-flow__pane').click({ position: { x: 300, y: 200 } })
  await page.keyboard.press('Escape')
  await page.locator('.react-flow__node-load').click({ button: 'right' })
  await page.getByRole('button', { name: /Duplicate/ }).click()
  await expect(page.locator('.react-flow__node-load')).toHaveCount(2)
})

test('solve the fixture circuit and see voltage results', async ({ page }) => {
  await openEditor(page)
  await loadFixture(page)
  const solve = page.getByRole('button', { name: /Solve/ })
  await expect(solve).toBeEnabled() // validation found no errors
  await solve.click()
  // Voltage overlay is the default — badges like "0.998 pu" appear per bus.
  await expect(
    page.locator('.result-badge').filter({ hasText: 'pu' }).first(),
  ).toBeVisible({ timeout: 20_000 })
  // No error toast.
  await expect(page.locator('.flash-toast.error')).toHaveCount(0)
})

test('fault overlay, losses tab, and voltage profile', async ({ page }) => {
  await openEditor(page)
  await loadFixture(page)
  await page.getByRole('button', { name: /Solve/ }).click()
  await expect(
    page.locator('.result-badge').filter({ hasText: 'pu' }).first(),
  ).toBeVisible({ timeout: 20_000 })

  // Fault overlay triggers the fault study lazily and shows kA badges.
  await page.getByRole('button', { name: 'Fault' }).click()
  await expect(
    page.locator('.result-badge').filter({ hasText: 'kA' }).first(),
  ).toBeVisible({ timeout: 20_000 })

  // Losses tab: series elements with a total row.
  await page.getByRole('button', { name: 'Losses' }).click()
  await expect(page.getByRole('cell', { name: 'line.ln1' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Total' })).toBeVisible()

  // Graph tab: defaults to the classic per-phase voltage profile.
  await page.getByRole('button', { name: 'Graph' }).click()
  await expect(page.locator('.vp-chart')).toBeVisible()
  expect(await page.locator('.vp-dot').count()).toBeGreaterThanOrEqual(3)
  // Toggling a phase off removes its traces.
  const allDots = await page.locator('.vp-dot').count()
  await page.getByText('ph2', { exact: true }).click()
  expect(await page.locator('.vp-dot').count()).toBeLessThan(allDots)
  await page.getByText('ph2', { exact: true }).click()

  // Switching the Y axis to an element quantity re-plots.
  await page.getByLabel('Y axis').selectOption({ label: 'Loading (%)' })
  await expect(page.locator('.vp-chart')).toBeVisible()
  expect(await page.locator('.vp-dot').count()).toBeGreaterThanOrEqual(2)
})

test('export .dss, start new, and re-import the exported file', async ({ page }) => {
  await openEditor(page)
  await loadFixture(page)
  page.on('dialog', (d) => void d.accept())

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export .dss' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('schema-fixture.dss')
  // Read the exported text through the same endpoint the button used — the
  // Windows sandbox forbids opening Chromium's download artifact directly.
  const dssText = await (await page.request.post('/api/export/dss', { data: fixture })).text()
  expect(dssText).toContain('new circuit.')

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)

  await page.locator('input[accept*=".dss"]').setInputFiles({
    name: 'exported.dss',
    mimeType: 'text/plain',
    buffer: Buffer.from(dssText, 'utf-8'),
  })
  // The importer reads the model back through OpenDSS itself; exact node
  // counts depend on bus synthesis, so assert the key elements returned.
  await expect(page.locator('.react-flow__node-vsource')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.locator('.react-flow__node-load')).toHaveCount(1)
  await expect(page.locator('.react-flow__node-transformer')).toHaveCount(1)
})
