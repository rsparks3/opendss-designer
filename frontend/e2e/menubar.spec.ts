import { expect, test, type Page } from '@playwright/test'
import { menu, menuItem } from './menu'

async function openEditor(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
}

test('menus open on click, switch on hover, and close on Escape or outside', async ({ page }) => {
  await openEditor(page)
  const bar = page.getByRole('menubar')
  await bar.getByRole('button', { name: 'File', exact: true }).click()
  await expect(page.getByRole('menu', { name: 'File' })).toBeVisible()

  // While one is open, pointing at another title switches to it.
  await bar.getByRole('button', { name: 'View', exact: true }).hover()
  await expect(page.getByRole('menu', { name: 'View' })).toBeVisible()
  await expect(page.getByRole('menu', { name: 'File' })).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  await bar.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.react-flow__pane').click({ position: { x: 300, y: 300 } })
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('arrow keys walk the items and Enter runs one', async ({ page }) => {
  await openEditor(page)
  await page.getByRole('menubar').getByRole('button', { name: 'Help', exact: true }).click()
  // The first item has focus as the menu opens.
  await expect(page.locator('[aria-label="Keyboard shortcuts"]')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[aria-label="Documentation"]')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Place a transformer')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // ? opens the same list from the canvas.
  await page.keyboard.press('?')
  await expect(dialog).toBeVisible()
})

test('View toggles hide the grid and the panels, and remember it', async ({ page }) => {
  await openEditor(page)
  await expect(page.locator('.react-flow__background')).toHaveCount(1)
  const grid = await menuItem(page, 'View', 'Grid')
  await expect(grid).toHaveAttribute('aria-checked', 'true')
  await grid.click()
  await expect(page.locator('.react-flow__background')).toHaveCount(0)

  await menu(page, 'View', 'Properties')
  await expect(page.locator('.side-right')).toHaveClass(/collapsed/)
  await menu(page, 'View', 'Bottom panel')
  await expect(page.locator('.bp-content')).toHaveCount(0)

  // The choices persist for the next visit.
  const stored = await page.evaluate(() => [
    localStorage.getItem('opendss-designer.showGrid'),
    localStorage.getItem('opendss-designer.propertiesOpen'),
    localStorage.getItem('opendss-designer.bottomOpen'),
  ])
  expect(stored).toEqual(['0', '0', '0'])
})

test('Edit → Select all then Delete empties the drawing; Undo restores it', async ({ page }) => {
  await openEditor(page)
  await menu(page, 'File', 'Samples', 'Radial feeder with DER')
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  await menu(page, 'Edit', 'Select all')
  await menu(page, 'Edit', 'Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await menu(page, 'Edit', 'Undo')
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
})

test('Analysis menu mirrors the toolbar: overlay radio and F5 solves', async ({ page }) => {
  await openEditor(page)
  await menu(page, 'File', 'Samples', 'Radial feeder with DER')
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  await expect(page.getByRole('button', { name: /Solve/ })).toBeEnabled()
  await page.keyboard.press('F5')
  await expect(page.locator('.result-badge').filter({ hasText: 'pu' }).first()).toBeVisible({ timeout: 20_000 })
  await menu(page, 'Analysis', 'Overlay', 'Phases')
  await expect(page.getByRole('button', { name: 'Phases', exact: true })).toHaveClass(/active/)
  const voltages = await menuItem(page, 'Analysis', 'Overlay', 'Voltages')
  await expect(voltages).toHaveAttribute('aria-checked', 'false')
})
