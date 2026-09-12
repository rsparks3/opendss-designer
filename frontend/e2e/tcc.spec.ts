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
