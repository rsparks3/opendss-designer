import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url)), 'utf-8'),
)

// The fixture is in UTM zone 12N, and two of its buses carry coordinates.
async function open(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate((c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c), fixture)
}

const geoOf = (page: Page, name: string) =>
  page.evaluate(
    (name) => (window as any).opendssDesigner.circuit.getState().nodes.find((n: any) => n.data.params.name === name).data.geo ?? null,
    name,
  )

const row = (page: Page, name: string) =>
  page.locator('.bp-table tbody tr').filter({ has: page.locator(`input[value="${name}"]`) })

test('the Elements table shows coordinates, edits them, and finds elements without one', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Elements', exact: true }).click()
  await page.getByRole('combobox', { name: 'Element type' }).selectOption('busbar')
  await expect(page.locator('.bp-table th', { hasText: 'X (m)' })).toBeVisible()
  await expect(page.locator('.bp-table th', { hasText: 'Y (m)' })).toBeVisible()

  const cells = (name: string) => row(page, name).locator('td.bp-cell input').filter({ hasNot: page.locator('[type=checkbox]') })
  const x = (name: string) => cells(name).nth(-2)
  const y = (name: string) => cells(name).nth(-1)
  await expect(x('BUS-MV')).toHaveValue('699900.5')
  await expect(y('BUS-MV')).toHaveValue('3703200.25')

  // Edit one half of an existing coordinate.
  await x('BUS-MV').fill('699950')
  await x('BUS-MV').press('Enter')
  expect(await geoOf(page, 'BUS-MV')).toEqual({ x: 699950, y: 3703200.25 })

  // `x=` lists the buses with no coordinate of their own.
  const filter = page.locator('.bp-filter input')
  await filter.fill('x=')
  const total = await page.evaluate(() =>
    (window as any).opendssDesigner.circuit.getState().nodes.filter((n: any) => n.type === 'busbar').length)
  await expect(page.locator('.bp-count')).toContainText(`${total - 2} of ${total}`)

  // A bus without one gets a point once both halves are in.
  const name = await page.evaluate(() =>
    (window as any).opendssDesigner.circuit.getState().nodes.find((n: any) => n.type === 'busbar' && !n.data.geo).data.params.name)
  await filter.fill('')
  await x(name).fill('700000')
  await x(name).press('Enter')
  expect(await geoOf(page, name)).toBeNull()
  await y(name).fill('3703500')
  await y(name).press('Enter')
  expect(await geoOf(page, name)).toEqual({ x: 700000, y: 3703500 })

  // Clearing a cell takes the coordinate away; undo brings it back.
  await y(name).fill('')
  await y(name).press('Enter')
  expect(await geoOf(page, name)).toBeNull()
  await page.getByRole('button', { name: /Undo/ }).click()
  expect(await geoOf(page, name)).toEqual({ x: 700000, y: 3703500 })
})

test('the DSS view shows the compiled script and follows edits', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'DSS', exact: true }).click()
  const code = page.getByTestId('dss-code')
  await expect(code).toContainText(/New Circuit\./i)
  await expect(page.locator('.dss-status')).toContainText(/\d+ lines · read-only/)
  // Bus coordinates ride along as SetBusXY, so the file stays one file.
  await expect(code).toContainText('setbusxy bus=bus-mv x=699900.5 y=3703200.25')

  // An edit elsewhere shows up in the script.
  const load = await page.evaluate(() =>
    (window as any).opendssDesigner.circuit.getState().nodes.find((n: any) => n.type === 'load'))
  await page.evaluate((id) => (window as any).opendssDesigner.circuit.getState().updateNodeParams(id, { kw: 123.25 }), load.id)
  await expect(code).toContainText('kW=123.25', { ignoreCase: true })

  // Find counts and steps through matches.
  await page.getByLabel('Find in script').fill('new load.')
  await expect(page.locator('.dss-count')).toContainText(/^1 of \d+$/)
  await page.getByLabel('Find in script').press('Enter')
  await expect(page.locator('.dss-count')).toContainText(/^2 of \d+$/)
  await expect(page.locator('.dss-hit')).toBeVisible()

  // And back to the one-line.
  await page.getByRole('button', { name: 'One-line', exact: true }).click()
  await expect(page.locator('.react-flow')).toBeVisible()
})
