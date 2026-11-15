import { expect, test, type Page } from '@playwright/test'

/**
 * Help hints (lib/struggles, store/hintStore): the card that appears when
 * the same thing keeps not working. The pan hint is the one that started
 * it all -- someone drawing selection box after selection box, trying to
 * move the view.
 */

async function openEditor(page: Page) {
  // A clean slate on the first load only: the init script runs on every
  // navigation, and a reload is meant to keep what the test just stored.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-cleared')) return
    localStorage.clear()
    sessionStorage.setItem('e2e-cleared', '1')
  })
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
}

/** A left-drag across the empty pane: a selection box. */
async function marquee(page: Page, from: [number, number], to: [number, number]) {
  const pane = page.locator('.react-flow__pane')
  const box = (await pane.boundingBox())!
  await page.mouse.move(box.x + from[0], box.y + from[1])
  await page.mouse.down()
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 6 })
  await page.mouse.up()
}

test('three selection boxes earn the pan hint; a right-drag retires it', async ({ page }) => {
  await openEditor(page)
  // Something on the drawing, so the selection boxes have something to miss.
  await page.keyboard.press('l')
  await page.locator('.react-flow__pane').click({ position: { x: 300, y: 200 } })
  await page.keyboard.press('Escape')

  const hint = page.locator('.struggle-hint')
  await marquee(page, [40, 40], [120, 120])
  await marquee(page, [400, 60], [480, 140])
  await expect(hint).toHaveCount(0)
  await marquee(page, [60, 300], [140, 360])
  await expect(hint).toHaveAttribute('data-hint', 'pan')
  await expect(hint).toContainText('right or middle mouse button')

  // Panning the way the card says is the lesson learned: it goes away and
  // does not come back for more selection boxes.
  const pane = page.locator('.react-flow__pane')
  const box = (await pane.boundingBox())!
  await page.mouse.move(box.x + 200, box.y + 200)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(box.x + 260, box.y + 240, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await page.keyboard.press('Escape') // close the context menu the release opens
  await expect(hint).toHaveCount(0)
  for (const i of [0, 1, 2, 3]) await marquee(page, [40 + i * 10, 40], [120, 120])
  await expect(hint).toHaveCount(0)
  const off = await page.evaluate(() => localStorage.getItem('opendss-designer.hintsOff'))
  expect(JSON.parse(off ?? '[]')).toContain('pan')
})

test('dragging a palette item onto the drawing earns the click-to-place hint', async ({ page }) => {
  await openEditor(page)
  const item = page.locator('.palette-item', { hasText: 'Source' }).first()
  await item.scrollIntoViewIfNeeded()
  const from = (await item.boundingBox())!
  const pane = (await page.locator('.react-flow__pane').boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(pane.x + 300, pane.y + 200, { steps: 8 })
  await page.mouse.up()
  const hint = page.locator('.struggle-hint')
  await expect(hint).toHaveAttribute('data-hint', 'palette-click')
  // Nothing was placed by the drag.
  await expect(page.locator('.react-flow__node')).toHaveCount(0)

  // "Got it" retires the hint across reloads.
  await hint.getByRole('button', { name: 'Got it' }).click()
  await expect(hint).toHaveCount(0)
  await page.reload()
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  const again = (await page.locator('.palette-item', { hasText: 'Source' }).first().boundingBox())!
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2)
  await page.mouse.down()
  await page.mouse.move(pane.x + 300, pane.y + 200, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.struggle-hint')).toHaveCount(0)
})

test('Preferences can turn hints off', async ({ page }) => {
  await openEditor(page)
  await page.evaluate(() => localStorage.setItem('opendss-designer.hintsEnabled', '0'))
  await page.reload()
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  const item = page.locator('.palette-item', { hasText: 'Source' }).first()
  await item.scrollIntoViewIfNeeded()
  const from = (await item.boundingBox())!
  const pane = (await page.locator('.react-flow__pane').boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(pane.x + 300, pane.y + 200, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.struggle-hint')).toHaveCount(0)
})
