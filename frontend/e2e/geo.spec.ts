import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url)), 'utf-8'),
)

// The map: a circuit at its coordinates. Run on a plain grid with no basemap,
// so nothing here reaches for a tile server.
async function openOnTheMap(page: Page, crs: string | null) {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('opendss-designer.basemap', 'none')
  })
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate(
    ([c, crs]) => (window as any).opendssDesigner.circuit.getState().loadCircuit({ ...(c as object), crs }),
    [fixture, crs] as const,
  )
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await page.waitForFunction(() => !!(window as any).opendssDesigner.map)
}

const busId = (name: string) => fixture.nodes.find((n: any) => n.params.name === name)!.id

async function at(page: Page, id: string) {
  const p = await page.evaluate((id) => (window as any).opendssDesigner.map.screenOf(id), id)
  expect(p).not.toBeNull()
  return p as { x: number; y: number }
}

test('places what has coordinates, and what connects to it, on the map', async ({ page }) => {
  await openOnTheMap(page, null)
  // Two buses carry coordinates; everything wired to them is placed from them.
  await expect(page.locator('.geo-status')).toContainText(/\d+ of \d+ on the map · plain grid/)
  await expect(page.locator('.geo-note')).toContainText('no coordinate system')
})

test('select a bus on the map, drag it, and undo the move', async ({ page }) => {
  await openOnTheMap(page, null)
  const id = busId('BUS-FDR')
  const p = await at(page, id)
  await page.mouse.click(p.x, p.y)
  await expect(page.locator('.properties .props-form input').first()).toHaveValue('BUS-FDR')

  const geo = () =>
    page.evaluate((id) => (window as any).opendssDesigner.circuit.getState().nodes.find((n: any) => n.id === id).data.geo, id)
  const before = await geo()
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 40, p.y + 20, { steps: 5 })
  await page.mouse.up()
  const after = await geo()
  expect(after.x).toBeGreaterThan(before.x)
  expect(after.y).toBeLessThan(before.y) // north is up: dragging down lowers y

  await page.keyboard.press('Control+z')
  expect(await geo()).toEqual(before)
})

test('a coordinate system the app knows names itself', async ({ page }) => {
  await openOnTheMap(page, 'EPSG:26912')
  await expect(page.locator('.geo-status')).toContainText('NAD83 / UTM zone 12N (EPSG:26912)')
  await expect(page.locator('.geo-note')).toHaveCount(0)
})
