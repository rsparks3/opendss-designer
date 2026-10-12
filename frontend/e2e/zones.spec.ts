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

const zones = (page: Page) =>
  page.evaluate(() =>
    (window as any).opendssDesigner.circuit
      .getState()
      .nodes.filter((n: any) => n.type === 'zone')
      .map((n: any) => ({ id: n.id, width: n.width, height: n.height, params: n.data.params, selected: n.selected })),
  )

test('Z drags out a zone that sits behind the drawing and exports with it', async ({ page }) => {
  await open(page)
  // The fixture's own zone is there, labelled, under the substation.
  const fixtureZone = page.locator('.react-flow__node[data-id="n_zone"]')
  await expect(fixtureZone.locator('.zone-label')).toHaveText('Substation')

  // Draw one: Z, then drag on empty canvas.
  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } })
  await page.keyboard.press('z')
  const overlay = page.locator('.placement-overlay')
  await expect(overlay).toBeVisible()
  const box = (await overlay.boundingBox())!
  await page.mouse.move(box.x + 600, box.y + 400)
  await page.mouse.down()
  await page.mouse.move(box.x + 700, box.y + 460, { steps: 5 })
  await page.mouse.move(box.x + 800, box.y + 520, { steps: 5 })
  await page.mouse.up()
  const drawn = (await zones(page)).find((z) => z.id !== 'n_zone')!
  expect(drawn).toBeTruthy()
  expect(drawn.width).toBeGreaterThanOrEqual(60)
  expect(drawn.height).toBeGreaterThanOrEqual(40)
  expect(drawn.selected).toBe(true)
  // Placement ended with the zone.
  await expect(overlay).toHaveCount(0)

  // Label and colour it from the properties panel.
  const label = page.getByLabel('Label')
  await label.fill('Feeder 12')
  await label.press('Enter')
  await page.getByLabel('Colour').selectOption('green')
  const node = page.locator(`.react-flow__node[data-id="${drawn.id}"]`)
  await expect(node.locator('.zone-label')).toHaveText('Feeder 12')
  await expect(node.locator('.zone-node')).toHaveClass(/zone-green/)

  // It is under everything and lets the pointer through: a click inside
  // the fixture's zone on empty canvas selects nothing, not the zone.
  await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().clearSelection())
  const zb = (await fixtureZone.boundingBox())!
  await page.mouse.click(zb.x + zb.width - 30, zb.y + zb.height - 30)
  expect((await zones(page)).every((z) => !z.selected)).toBe(true)
  const zIndex = await fixtureZone.evaluate((el) => getComputedStyle(el).zIndex)
  expect(Number(zIndex)).toBeLessThan(0)
  // Its label does pick it up.
  await fixtureZone.locator('.zone-label').click()
  expect((await zones(page)).find((z) => z.id === 'n_zone')!.selected).toBe(true)

  // The export carries both zones as dashed rectangles with their labels.
  const [download] = await Promise.all([page.waitForEvent('download'), menu(page, 'File', 'Export', 'Image (SVG)')])
  const svg = readFileSync((await download.path())!, 'utf-8')
  expect(svg).toContain('>Substation</text>')
  expect(svg).toContain('>Feeder 12</text>')
  expect((svg.match(/<rect [^>]*stroke-dasharray=/g) ?? []).length).toBeGreaterThanOrEqual(2)
  // Zones are drawn before the wires, so they sit underneath.
  expect(svg.indexOf('stroke-dasharray=')).toBeLessThan(svg.indexOf('<path d='))
})

test('Clean up redraws a zone around what it held', async ({ page }) => {
  await open(page)
  const before = await page.evaluate(() => {
    const s = (window as any).opendssDesigner.circuit.getState()
    const z = s.nodes.find((n: any) => n.id === 'n_zone')
    const inside = s.nodes.filter(
      (n: any) =>
        n.type !== 'zone' &&
        n.type !== 'note' &&
        n.position.x + 20 >= z.position.x &&
        n.position.x + 20 <= z.position.x + z.width &&
        n.position.y + 30 >= z.position.y &&
        n.position.y + 30 <= z.position.y + z.height,
    )
    return inside.map((n: any) => n.id)
  })
  expect(before.length).toBeGreaterThan(0)
  await menu(page, 'Arrange', 'Clean up layout')
  const after = await page.evaluate((ids) => {
    const s = (window as any).opendssDesigner.circuit.getState()
    const z = s.nodes.find((n: any) => n.id === 'n_zone')
    return ids.map((id: string) => {
      const n = s.nodes.find((x: any) => x.id === id)
      return (
        n.position.x >= z.position.x &&
        n.position.x <= z.position.x + z.width &&
        n.position.y >= z.position.y &&
        n.position.y <= z.position.y + z.height
      )
    })
  }, before)
  expect(after.every(Boolean)).toBe(true)
})
