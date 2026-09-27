import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const sample13 = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../src/opendss_designer/samples/ieee-13-bus.oneline.json', import.meta.url)),
    'utf-8',
  ),
)

type Page = import('@playwright/test').Page
const state = (page: Page) => page.evaluate(() => (window as any).opendssDesigner.circuit.getState())

async function open(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate((c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c), sample13)
}

const loads = (page: Page) =>
  page.evaluate(() =>
    (window as any).opendssDesigner.circuit.getState().nodes
      .filter((n: any) => n.type === 'load')
      .map((n: any) => ({ name: n.data.params.name, kw: n.data.params.kw, shape: n.data.params.loadshape, selected: !!n.selected })),
  )

test('right-click a bus, select everything downstream, keep only loads, scale them', async ({ page }) => {
  await open(page)
  const bus671 = await page.evaluate(() =>
    (window as any).opendssDesigner.circuit.getState().nodes.find((n: any) => n.type === 'busbar' && n.data.params.name === '671').id)
  await page.locator(`[data-id="${bus671}"]`).click({ button: 'right' })
  await page.getByRole('button', { name: 'Select everything downstream' }).click()

  // The lateral: buses, loads, capacitors, a switch, lines — a mixed selection.
  await expect(page.locator('.properties .palette-title')).toContainText(/Edit \d+ elements/)
  const before = await loads(page)
  expect(before.filter((l: any) => l.selected).map((l: any) => l.name).sort())
    .toEqual(['611', '652', '671', '675a', '675b', '675c', '692'])

  // Narrow to the loads with the chip, then grow them by 10 %.
  await page.locator('.bulk-chip', { hasText: /loads/ }).click()
  await expect(page.locator('.properties .palette-title')).toContainText('Edit 7 elements')
  const kw = page.locator('.prop-row', { hasText: 'Power (kW)' }).locator('input')
  await expect(kw).toHaveAttribute('placeholder', '(mixed)')
  await kw.fill('×1.1')
  await kw.blur()
  const after = await loads(page)
  const byName = Object.fromEntries(after.map((l: any) => [l.name, l]))
  expect(byName['675a'].kw).toBeCloseTo(485 * 1.1, 6)
  expect(byName['611'].kw).toBeCloseTo(170 * 1.1, 6)
  // Loads outside the lateral are untouched.
  expect(byName['634a'].kw).toBe(160)

  // One undo puts all seven back.
  await page.getByRole('button', { name: /Undo/ }).click()
  const undone = await loads(page)
  expect(undone.find((l: any) => l.name === '675a').kw).toBe(485)
})

test('the Elements table filter selects matching loads for a bulk load-shape assignment', async ({ page }) => {
  await open(page)
  await page.evaluate(() =>
    (window as any).opendssDesigner.circuit.getState().setLoadShape('day24', { intervalMin: 60, points: [0.5, 1, 0.8], kind: 'load' }))
  await page.getByRole('button', { name: 'Elements', exact: true }).click()
  await page.getByRole('button', { name: 'Loads', exact: true }).click()
  const filter = page.locator('.bp-filter input')
  await filter.fill('kw>=170')
  await expect(page.locator('.bp-count')).toContainText('7 of 15')
  await page.getByRole('button', { name: /Select 7 matching/ }).click()
  await expect(page.locator('.properties .palette-title')).toContainText('Edit 7 elements')
  await expect(page.locator('.bp-table tr.selected')).toHaveCount(7)

  const shape = page.locator('.prop-row', { hasText: 'Loadshape' }).locator('select')
  await shape.selectOption('day24')
  const after = await loads(page)
  expect(after.filter((l: any) => l.shape === 'day24').map((l: any) => l.name).sort())
    .toEqual(['611', '645', '646', '671', '675a', '675c', '692'])
})

test('a phase pick from the menu selects only the loads on that phase', async ({ page }) => {
  await open(page)
  const load645 = await page.evaluate(() =>
    (window as any).opendssDesigner.circuit.getState().nodes.find((n: any) => n.type === 'load' && n.data.params.name === '645').id)
  await page.locator(`[data-id="${load645}"]`).click({ button: 'right' })
  await page.getByRole('button', { name: 'Select all loads on phase B' }).click()
  const picked = (await loads(page)).filter((l: any) => l.selected).map((l: any) => l.name).sort()
  expect(picked).toEqual(['634b', '645', '646', '670b', '671', '675b'])
})
