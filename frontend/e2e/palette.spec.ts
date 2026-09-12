import { expect, test, type Page } from '@playwright/test'

const WIDTH_KEY = 'opendss-designer.palette2Width'

/** Open the editor with the components column at a given width. */
async function openAt(page: Page, width: number) {
  await page.addInitScript(
    ([key, w]) => {
      localStorage.clear()
      localStorage.setItem(key as string, String(w))
    },
    [WIDTH_KEY, width] as const,
  )
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
}

const iconWidth = (page: Page) =>
  page.locator('.palette-icon').first().evaluate((el) => el.getBoundingClientRect().width)

// Narrowing the column used to shrink the symbols and clip the names. The
// symbol is the part you recognise, so it keeps its size and the name is what
// gives way — all of it, rather than half a word.
test('a narrow components column shows symbols only, at full size', async ({ page }) => {
  await openAt(page, 130)

  await expect(page.locator('.palette-label').first()).toBeHidden()
  await expect(page.locator('.palette-kbd').first()).toBeHidden()
  await expect(page.locator('.palette-title').first()).toBeHidden()
  expect(await iconWidth(page)).toBe(28)

  // Still operable: the button is there, and its tooltip still names it.
  const relay = page.locator('.palette-item').nth(7)
  await expect(relay).toBeVisible()
  await expect(relay).toHaveAttribute('title', /place a relay/)
})

test('a wide components column shows the names in full', async ({ page }) => {
  await openAt(page, 210)

  await expect(page.getByText('Transformer', { exact: true })).toBeVisible()
  await expect(page.locator('.palette-kbd').first()).toBeVisible()
  expect(await iconWidth(page)).toBe(28)

  // No name is cut off: every label renders at its natural width.
  const clipped = await page.locator('.palette-label').evaluateAll((els) =>
    els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
  )
  expect(clipped).toEqual([])
})
