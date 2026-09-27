import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url)),
    'utf-8',
  ),
)

async function open(page: import('@playwright/test').Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate(
    (c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c),
    fixture,
  )
  await page.getByRole('button', { name: 'Line codes', exact: true }).click()
}

test('a circuit carries its line codes, shown as OpenDSS writes them', async ({ page }) => {
  await open(page)
  await expect(page.locator('.curves-item')).toHaveCount(1)
  await expect(page.locator('.curves-item')).toContainText('mtx601')
  await expect(page.locator('.curves-item')).toContainText('1 line')
  await expect(page.locator('.curves-used')).toContainText('LN2')

  // The R matrix is the lower triangle, rows separated by |, and editing
  // one entry changes the stored matrix on both sides of the diagonal.
  const r = page.locator('.lc-matrix', { hasText: 'R ' }).locator('input')
  await expect(r).toHaveValue('0.3465 | 0.156 0.3375 | 0.158 0.1535 0.3414')
  await r.fill('0.35 | 0.2 0.34 | 0.158 0.1535 0.3414')
  await r.blur()
  const stored = await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState().lineCodes.mtx601.rmatrix,
  )
  expect(stored[0][1]).toBe(0.2)
  expect(stored[1][0]).toBe(0.2)

  // A ragged row is refused with a message, and the matrix is unchanged.
  await r.fill('0.35 | 0.2')
  await r.blur()
  await expect(page.locator('.flash-toast')).toContainText('expected 3 rows')
  const unchanged = await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState().lineCodes.mtx601.rmatrix,
  )
  expect(unchanged[0][0]).toBe(0.35)
})

test('a line picks a code from the properties panel and loses its own R/X fields', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: '+ New line code' }).click()
  await expect(page.locator('.curves-item')).toHaveCount(2)

  // LN1 is on a preset today; put it on the new code.
  await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().selectOnly('edge', 'e4'))
  const conductor = page.locator('.prop-row', { hasText: 'Conductor' }).locator('select')
  await expect(page.locator('.prop-row', { hasText: 'R1' })).toHaveCount(1)
  await conductor.selectOption('code1')
  await expect(page.locator('.prop-row', { hasText: 'R1' })).toHaveCount(0)
  const params = await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState()
      .edges.find((e: any) => e.id === 'e4').data.params,
  )
  expect(params.linecode).toBe('code1')
  expect(params.phases).toBe(3)

  // And the circuit still solves, with the code emitted for the engine.
  const solve = page.getByRole('button', { name: /Solve/ })
  await expect(solve).toBeEnabled()
  await solve.click()
  await expect(
    page.locator('.result-badge').filter({ hasText: 'pu' }).first(),
  ).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.flash-toast.error')).toHaveCount(0)
})
