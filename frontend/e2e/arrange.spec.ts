import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { menu } from './menu'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url)), 'utf-8'),
)

async function openWithFixture(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate((c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c), fixture)
  await expect(page.locator('.react-flow__node')).toHaveCount(fixture.nodes.length)
}

const nodes = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      (window as any).opendssDesigner.circuit
        .getState()
        .nodes.map((n: any) => [n.id, { ...n.position, params: n.data.params }]),
    ),
  )

const select = (page: Page, ids: string[]) =>
  page.evaluate(
    (ids) => (window as any).opendssDesigner.circuit.getState().selectMany({ nodeIds: ids, edgeIds: [] }),
    ids,
  )

test('Align → Tops lines the selection up, and one Undo puts it back', async ({ page }) => {
  await openWithFixture(page)
  const before = await nodes(page)
  await select(page, ['n_load', 'n_load2'])
  await menu(page, 'Arrange', 'Align', 'Tops')
  const after = await nodes(page)
  expect(after.n_load.y).toBe(after.n_load2.y)
  expect(after.n_load.y).toBe(Math.min(before.n_load.y, before.n_load2.y))
  await menu(page, 'Edit', 'Undo')
  expect(await nodes(page)).toEqual(before)
})

test('Distribute needs three, and evens out the gaps', async ({ page }) => {
  await openWithFixture(page)
  await select(page, ['n_load', 'n_load2'])
  await page.getByRole('menubar').getByRole('button', { name: 'Arrange', exact: true }).click()
  await expect(page.locator('[aria-label="Distribute"]')).toBeDisabled()
  await page.keyboard.press('Escape')

  await select(page, ['n_gen', 'n_pv', 'n_stg'])
  await menu(page, 'Arrange', 'Distribute', 'Horizontally')
  const n = await nodes(page)
  const xs = [n.n_gen.x, n.n_pv.x, n.n_stg.x].sort((a, b) => a - b)
  // Same-width symbols, so equal gaps mean equal steps (within the 10 px grid).
  expect(Math.abs(xs[1] - xs[0] - (xs[2] - xs[1]))).toBeLessThanOrEqual(10)
})

test('flipping a three-winding transformer moves its tertiary to the other side', async ({ page }) => {
  await openWithFixture(page)
  await page.evaluate(() => {
    const s = (window as any).opendssDesigner.circuit.getState()
    s.setTransformerWindings('n_xfmr', [
      { kv: 115, kva: 10000, conn: 'delta' },
      { kv: 12.47, kva: 10000, conn: 'wye' },
      { kv: 4.16, kva: 5000, conn: 'wye' },
    ])
  })
  const t3 = page.locator('[data-id="n_xfmr"] [data-handleid="t3"]')
  const box = page.locator('[data-id="n_xfmr"]')
  await expect(t3).toHaveCount(1)
  const side = async () => {
    const [h, b] = [await t3.boundingBox(), await box.boundingBox()]
    return h!.x + h!.width / 2 > b!.x + b!.width / 2 ? 'right' : 'left'
  }
  expect(await side()).toBe('right')

  await select(page, ['n_xfmr'])
  await menu(page, 'Arrange', 'Flip horizontally')
  await expect.poll(side).toBe('left')
  expect((await nodes(page)).n_xfmr.params.flip).toBe(true)

  // Shift+H flips it back, and the params come back clean.
  await page.keyboard.press('Shift+H')
  await expect.poll(side).toBe('right')
  expect((await nodes(page)).n_xfmr.params.flip).toBeUndefined()
})

test('a flipped relay keeps its device number readable, on screen and in the SVG', async ({ page }) => {
  await openWithFixture(page)
  const relay = await page.evaluate(
    () => (window as any).opendssDesigner.circuit.getState().nodes.find((n: any) => n.type === 'relay').id,
  )
  await select(page, [relay])
  await menu(page, 'Arrange', 'Flip horizontally')
  const text = page.locator(`[data-id="${relay}"] svg text`)
  await expect(text).toHaveAttribute('transform', /scale\(-1 1\)/)
  const [download] = await Promise.all([page.waitForEvent('download'), menu(page, 'File', 'Export', 'Image (SVG)')])
  const svg = readFileSync((await download.path())!, 'utf-8')
  expect(svg).toMatch(/scale\(-1 1\) translate\(/)
})

test('Ctrl+F finds an element by part of its name and selects it', async ({ page }) => {
  await openWithFixture(page)
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+f')
  const find = page.getByRole('dialog', { name: 'Find' })
  await expect(find).toBeVisible()
  await find.getByLabel('Element name').fill('load2')
  await expect(find.getByRole('option').first()).toContainText('LOAD2')
  await page.keyboard.press('Enter')
  await expect(find).toHaveCount(0)
  await expect(page.locator('[data-id="n_load2"]')).toHaveClass(/selected/)
})
