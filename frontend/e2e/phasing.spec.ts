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

const phasePicker = (page: Page) =>
  page.locator('.prop-row', { hasText: 'Phase(s)' }).locator('select')

// A feeder is mostly single-phase laterals, so which phase a line is on has to
// be visible on the drawing, not only in the inspector.
test('pinning a line to one phase labels it on the one-line', async ({ page }) => {
  await openWithFixture(page)

  // A 3-phase trunk says nothing by carrying all three.
  await expect(page.locator('.edge-phase')).toHaveCount(0)

  await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState().selectOnly('edge', 'e4'),
  )
  await expect(phasePicker(page)).toBeVisible()
  await phasePicker(page).selectOption('B')

  const chip = page.locator('.edge-phase')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveText('B')

  // Back to all three and the chip goes away again.
  await phasePicker(page).selectOption('ABC')
  await expect(page.locator('.edge-phase')).toHaveCount(0)
})

test('a pin the feeder cannot supply is reported', async ({ page }) => {
  await openWithFixture(page)

  // The panel starts collapsed; Graph opens it, then Problems is a tab in it.
  await page.getByRole('button', { name: 'Graph' }).click()
  await page.getByRole('button', { name: /Problems/ }).click()
  // Every element hangs off a 3-phase feeder, so nothing is short of a phase.
  await expect(page.locator('.bp-empty')).toContainText('No problems')

  // Put the lateral on B and the load on C: the load is now asking for a
  // phase that never reaches its bus.
  await page.evaluate(() => {
    const store = (window as any).opendssDesigner.circuit.getState()
    const line = store.edges.find((e: any) => e.data?.params?.name === 'LN1')
    const load = store.nodes.find((n: any) => n.data?.params?.name === 'LOAD1')
    store.updateEdgeParams(line.id, { phases: 1, phasing: 'B' })
    store.updateNodeParams(load.id, { phases: 1, phasing: 'C' })
  })

  // The chip proves the edit landed before the Problems list is judged.
  await expect(page.locator('.edge-phase')).toHaveText('B')
  await expect(
    page.locator('.problems-list li', { hasText: "'LOAD1' connects to phase C" }).first(),
  ).toBeVisible()
})

// Once a lateral is on B, the results have to say so too: a badge reading
// "0.98 pu" on a single-phase bus is ambiguous until it names the phase.
test('results name the phase a lateral is on', async ({ page }) => {
  await openWithFixture(page)

  await page.evaluate(() => {
    const store = (window as any).opendssDesigner.circuit.getState()
    const line = store.edges.find((e: any) => e.data?.params?.name === 'LN1')
    const load = store.nodes.find((n: any) => n.data?.params?.name === 'LOAD1')
    store.updateEdgeParams(line.id, { phases: 1, phasing: 'B' })
    store.updateNodeParams(load.id, { phases: 1, phasing: 'B', kv: 7.2 })
  })
  await expect(page.locator('.edge-phase')).toHaveText('B')

  const solve = page.getByRole('button', { name: /Solve/ })
  await expect(solve).toBeEnabled()
  await solve.click()
  const badge = page.locator('.result-badge .badge-phase')
  await expect(badge.first()).toBeVisible({ timeout: 20_000 })
  // The lateral's buses are on B; the balanced three-phase trunk says nothing.
  await expect(badge.first()).toHaveText('B')

  const load = page.locator('.react-flow__node', { hasText: 'LOAD1' })
  await load.hover()
  const tooltip = page.locator('.result-tooltip')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('ph B')
  await expect(tooltip).toContainText('I ph B')
  await expect(tooltip).not.toContainText('ph 1')
})

// Letters on a chip tell you a lateral's phase once you look at it; colour
// lets you see a whole feeder's phasing at a glance, which is how the
// commercial planning tools show it. Nothing here needs a solve.
test('the Phases overlay colours lines by their phase and buses by what reaches them', async ({ page }) => {
  await openWithFixture(page)
  await page.getByRole('button', { name: 'Phases', exact: true }).click()
  await expect(page.locator('.phase-legend')).toBeVisible()

  const rgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
  }
  const strokeOf = (edgeId: string) =>
    page
      .locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`)
      .evaluate((el) => getComputedStyle(el).stroke)

  // Everything is three-phase to begin with: plain ink, no badges.
  expect(await strokeOf('e4')).toBe(rgb('#263238'))
  await expect(page.locator('.phase-badge')).toHaveCount(0)

  // Put the lateral on B: the line turns B, and every bus past it does too.
  await page.evaluate(() => {
    const store = (window as any).opendssDesigner.circuit.getState()
    store.updateEdgeParams('e4', { phases: 1, phasing: 'B' })
  })
  await expect.poll(() => strokeOf('e4')).toBe(rgb('#1565c0'))
  // Five busbars hang off the far end of LN1 (feeder, regulator, protection,
  // lateral, tap); the regulator and the switches carry the pin through.
  const downstream = page.locator('.phase-badge')
  await expect(downstream).toHaveCount(5)
  await expect(downstream.first()).toHaveText('B')
  const tapBar = page.locator('.react-flow__node', { hasText: 'BUS-TAP' }).locator('.busbar-bar')
  expect(await tapBar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(rgb('#1565c0'))
  // The trunk upstream of the tap is untouched.
  const trunkBar = page.locator('.react-flow__node', { hasText: 'BUS-MV' }).locator('.busbar-bar')
  expect(await trunkBar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(rgb('#263238'))

  // Any other overlay puts the drawing back in ink.
  await page.getByRole('button', { name: 'Off', exact: true }).click()
  await expect(page.locator('.phase-legend')).toHaveCount(0)
  expect(await strokeOf('e4')).toBe(rgb('#263238'))
})
