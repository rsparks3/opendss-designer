import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// The schema fixture carries a relay -> recloser -> fuse chain down one feeder,
// which is exactly what a coordination plot is for.
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url)),
    'utf-8',
  ),
)

test('the Protection tab plots a curve per device with its fault current', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate(
    (c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c),
    fixture,
  )

  await page.getByRole('button', { name: 'Graph' }).click()
  await page.getByRole('button', { name: 'Protection' }).click()

  // The study runs against the real engine, so give it room.
  const traces = page.locator('.vp-chart path.vp-trace')
  await expect(traces.first()).toBeVisible({ timeout: 30_000 })

  // Fuse (1 curve) + recloser (fast + delayed) + relay (phase + ground).
  await expect(traces).toHaveCount(5)
  // One dashed fault line per device, at the current it would have to clear.
  await expect(page.locator('.vp-chart line.tcc-fault')).toHaveCount(3)

  for (const name of ['fu1', 'rec1', 'rly1']) {
    await expect(page.locator('.vp-chart text.tcc-legend', { hasText: name })).toBeVisible()
  }

  // Log axes: the time axis spans decades, so its labels are decade values.
  const yLabels = await page.locator('.vp-chart text.vp-tick').allTextContents()
  expect(yLabels).toContain('100')
  expect(yLabels.length).toBeGreaterThan(4)
})

test('clicking a device in the legend takes it off the plot', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate(
    (c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c),
    fixture,
  )
  await page.getByRole('button', { name: 'Graph' }).click()
  await page.getByRole('button', { name: 'Protection' }).click()

  const traces = page.locator('.vp-chart path.vp-trace')
  await expect(traces).toHaveCount(5, { timeout: 30_000 })

  // The recloser contributes two of the five.
  await page.locator('.tcc-legend-row', { hasText: 'rec1' }).click()
  await expect(traces).toHaveCount(3)
  await expect(page.locator('.vp-chart line.tcc-fault')).toHaveCount(2)
})

// The switch table and the Problems hand-off are rendering concerns, so they
// are driven from a canned study rather than a live engine run: deterministic,
// and it does not depend on which build of the server happens to be up.
const STUB = {
  converged: true,
  devices: [
    {
      nodeId: 'n_rly', name: 'rly1', kind: 'relay', switch: 'rly1', bus: 'bus_prot',
      faultA3ph: 3192.6, faultA1ph: 2484.7,
      traces: [{ label: 'rly1 phase', curve: 'very_inv', pickupA: 200,
                 points: [[220, 93.9], [20000, 0.49]] }],
    },
  ],
  switches: [
    { nodeId: 'n_brk', name: 'BRK1', kind: 'breaker', bus: 'tap1',
      faultA3ph: 3192.7, faultA1ph: 2484.8, interruptingKa: 12.5 },
    { nodeId: 'n_brk2', name: 'BRK2', kind: 'breaker', bus: 'tap2',
      faultA3ph: 18000, faultA1ph: 14000, interruptingKa: 12.5 },
  ],
  issues: [
    { severity: 'warning', code: 'interrupting-duty', nodeId: 'n_brk2',
      message: "Breaker 'BRK2' is rated to interrupt 12.5 kA, but a fault at tap2 draws 18.0 kA." },
  ],
}

test('a breaker has no curve, so it gets a row in the duty table instead', async ({ page }) => {
  await page.route('**/api/tcc', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUB) }))
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate(
    (c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c),
    fixture,
  )
  await page.getByRole('button', { name: 'Graph' }).click()
  await page.getByRole('button', { name: 'Protection' }).click()

  const table = page.locator('.tcc-switches')
  await expect(table).toBeVisible({ timeout: 30_000 })
  // The relay is plotted, so it is not in the table; the breakers are.
  await expect(table.locator('tbody tr')).toHaveCount(2)
  await expect(table).toContainText('BRK1')
  await expect(table).not.toContainText('rly1')
  // Over its rating reads as over.
  await expect(table.locator('td.over')).toHaveCount(1)
  await expect(table.locator('td.over')).toHaveText('18.0 kA')

  // Findings land in the Problems list, not only in this tab.
  await page.getByRole('button', { name: /Problems/ }).click()
  await expect(page.getByText(/rated to interrupt 12.5 kA/)).toBeVisible()
})
