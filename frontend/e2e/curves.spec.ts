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
  await page.getByRole('button', { name: 'Curves', exact: true }).click()
}

test('a circuit carries its own curves, and they are editable', async ({ page }) => {
  await open(page)
  // The fixture defines one, and the lateral fuse uses it.
  await expect(page.locator('.curves-item')).toHaveCount(1)
  await expect(page.locator('.curves-item')).toContainText('lateral-k')
  await expect(page.locator('.curves-used')).toContainText('FU1')

  // The points are the ones in the circuit, and editing them sticks.
  const points = page.locator('.curves-points textarea')
  await expect(points).toHaveValue(/^2, 300/)
  await points.fill('1.5, 20\n3, 2\n10, 0.2')
  await points.blur()
  const stored = await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState().tccCurves['lateral-k'],
  )
  expect(stored.multiples).toEqual([1.5, 3, 10])
  expect(stored.seconds).toEqual([20, 2, 0.2])
})

test('a new curve is offered to every protective device', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: '+ New curve' }).click()
  await expect(page.locator('.curves-item')).toHaveCount(2)

  // Select the relay and check its curve dropdown lists the new one.
  await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().selectOnly('node', 'n_rly'))
  const phaseCurve = page.locator('.prop-row', { hasText: 'Phase curve' }).locator('select')
  await expect(phaseCurve.locator('option', { hasText: 'curve1' })).toHaveCount(1)
  await phaseCurve.selectOption('curve1')
  const chosen = await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState()
      .nodes.find((n: any) => n.id === 'n_rly').data.params.phasecurve,
  )
  expect(chosen).toBe('curve1')
})
