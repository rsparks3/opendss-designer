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

// Reliability is the first study that needs no solve of its own to read:
// pick the overlay, the engine runs it, and the drawing colours by section.
test('the Reliability overlay runs the study and colours the sections', async ({ page }) => {
  await open(page)
  // Give the loads customers so the indices mean something.
  await page.evaluate(() => {
    const s = (window as any).opendssDesigner.circuit.getState()
    s.updateNodeParams('n_load', { numcust: 120 })
    s.updateNodeParams('n_load2', { numcust: 30 })
  })
  await page.locator('.overlay-group').getByRole('button', { name: 'Reliability', exact: true }).click()
  const legend = page.getByRole('list', { name: 'Reliability' })
  await expect(legend).toBeVisible({ timeout: 20_000 })
  await expect(legend).toContainText('SAIFI')
  await expect(legend).toContainText('150 customers')
  // The fused lateral is its own section, named after the fuse.
  await expect(legend).toContainText('FU1')
  // Loads wear their customer counts; the fuse says what its section costs.
  await expect(page.locator('.react-flow__node[data-id="n_load"] .result-badge')).toContainText('120 cust')
  await expect(page.locator('.react-flow__node[data-id="n_fuse"] .result-badge')).toContainText('cust·int/yr')

  // The tab holds the numbers and the sections.
  await page.locator('.bp-header').getByRole('button', { name: 'Reliability', exact: true }).click()
  const panel = page.locator('.reliability-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.reliability-index').first()).toContainText('SAIFI')
  await expect(panel.locator('table tbody tr')).toHaveCount(4) // relay, recloser, fuse, and the unprotected trunk
  await expect(panel.locator('.reliability-warning')).toContainText('no protection section')

  // The export carries the sections' legend.
  const [download] = await Promise.all([page.waitForEvent('download'), menu(page, 'File', 'Export', 'Image (SVG)')])
  const svg = readFileSync((await download.path())!, 'utf-8')
  expect(svg).toContain('no protective device upstream')
  expect(svg).toMatch(/FU1 · \d+ cust/)

  // An edit clears the study, like the fault study.
  await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().updateNodeParams('n_load', { kw: 900 }))
  expect(await page.evaluate(() => (window as any).opendssDesigner.results.getState().reliability)).toBeNull()
})

test('the properties panel offers fault rates, repair times, customers and a meter', async ({ page }) => {
  await open(page)
  await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().selectOnly('node', 'n_load'))
  const customers = page.getByLabel('Customers')
  await expect(customers).toHaveAttribute('placeholder', '1')
  await customers.fill('75')
  await customers.press('Enter')
  expect(await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().nodes.find((n: any) => n.id === 'n_load').data.params.numcust)).toBe(75)

  await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().selectOnly('edge', 'e4'))
  await expect(page.getByLabel('Fault rate')).toHaveAttribute('placeholder', '0.1')
  await expect(page.getByLabel('Repair time')).toHaveAttribute('placeholder', '3')
  const meter = page.getByLabel('Reliability meter here')
  await expect(meter).not.toBeChecked()
  await meter.check()
  expect(await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().edges.find((e: any) => e.id === 'e4').data.params.meter)).toBe(true)
})
