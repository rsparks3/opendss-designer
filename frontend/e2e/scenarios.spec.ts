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

const brk = fixture.nodes.find((n: { type: string }) => n.type === 'breaker').id

test('a load level picked in the toolbar changes what the solve reads', async ({ page }) => {
  await open(page)
  const level = page.getByRole('combobox', { name: 'Load level' }).first()
  await expect(level).toHaveValue('Peak')
  await page.getByRole('button', { name: /Solve/ }).first().click()
  await expect(page.locator('.status-line')).toContainText('Converged', { timeout: 20_000 })
  const peakKw = await page.evaluate(() => {
    const r = (window as any).opendssDesigner.results.getState().result
    return r.elements['load.load1'].kw as number
  })
  await level.selectOption('Minimum daytime')
  await expect(page.locator('.status-line')).toContainText('stale')
  await page.getByRole('button', { name: /Solve/ }).first().click()
  await expect(page.locator('.status-line')).toContainText('Minimum daytime', { timeout: 20_000 })
  const minKw = await page.evaluate(() => {
    const r = (window as any).opendssDesigner.results.getState().result
    return r.elements['load.load1'].kw as number
  })
  expect(minKw).toBeLessThan(0.35 * peakKw)
  expect(minKw).toBeGreaterThan(0.25 * peakKw)
})

test('opening a scenario swaps the drawing in and the base comes back', async ({ page }) => {
  await open(page)
  // The fixture's scenario opens the feeder breaker.
  const scenario = page.getByRole('combobox', { name: 'Scenario' })
  await scenario.selectOption('sc1')
  const closed = () =>
    page.evaluate((id) => (window as any).opendssDesigner.circuit.getState().nodes.find((n: { id: string }) => n.id === id).data.params.closed, brk)
  expect(await closed()).toBe(false)
  // An edit inside the scenario stays in the scenario.
  await page.evaluate((id) => (window as any).opendssDesigner.circuit.getState().updateNodeParams(id, { normamps: 999 }), brk)
  await scenario.selectOption('')
  expect(await closed()).not.toBe(false)
  const json = await page.evaluate(() => {
    const w = (window as any).opendssDesigner
    return w.toCircuitJSON ? w.toCircuitJSON(w.circuit.getState()) : null
  })
  if (json) {
    expect(json.scenarios[0].overrides[brk]).toEqual({ closed: false, normamps: 999 })
  } else {
    const overrides = await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().scenarios[0].overrides)
    expect(overrides[brk]).toEqual({ closed: false, normamps: 999 })
  }
  // The Scenarios tab lists both and says what changed.
  await page.locator('.bp-header').getByRole('button', { name: 'Scenarios', exact: true }).click()
  const panel = page.locator('.scenarios-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.scenarios-list li')).toHaveCount(2)
  await expect(panel.locator('.scenarios-list li').nth(1)).toContainText('1 change')
})

test('a batch run fills the matrix and the menu pins a baseline', async ({ page }) => {
  await open(page)
  await page.locator('.bp-header').getByRole('button', { name: 'Scenarios', exact: true }).click()
  const panel = page.locator('.scenarios-panel')
  await panel.getByRole('button', { name: 'Run all' }).click()
  // 2 cases × 3 levels.
  await expect(panel.locator('.scenarios-matrix tbody tr')).toHaveCount(6, { timeout: 60_000 })
  await expect(panel.locator('.scenarios-matrix tbody tr').first()).toContainText('Base case')
  // Pin the solve as a baseline from the menu, then the Compare tab knows it.
  await page.getByRole('button', { name: /Solve/ }).first().click()
  await expect(page.locator('.status-line')).toContainText('Converged', { timeout: 20_000 })
  await menu(page, 'Analysis', 'Pin solve as baseline')
  await page.locator('.bp-header').getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(page.locator('.compare-panel')).toContainText('Baseline')
  await expect(page.locator('.compare-panel')).toContainText('Base case at Peak')
})
