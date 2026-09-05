import { expect, test, type Page } from '@playwright/test'

// The browser-local project library: Save asks for a name once, Open lists
// what is saved, and a reopened circuit comes back intact. IndexedDB is
// per-origin, so the cleanup in openEditor keeps runs independent.

async function openEditor(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    indexedDB.deleteDatabase('opendss-designer')
  })
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
}

async function placeLoads(page: Page, n: number, total = n) {
  await page.keyboard.press('l')
  for (let i = 0; i < n; i++) {
    await page.locator('.react-flow__pane').click({ position: { x: 200 + i * 120, y: 250 } })
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('.react-flow__node-load')).toHaveCount(total)
}

test('save asks for a name once, then saves silently', async ({ page }) => {
  await openEditor(page)
  await placeLoads(page, 2)

  await page.getByRole('button', { name: /^Save( •)?$/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Save circuit' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name').fill('Feeder one')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.flash-toast')).toContainText('Saved "Feeder one"')

  // The toolbar name box follows the saved name and the dirty dot is gone.
  await expect(page.getByTitle('Circuit name')).toHaveValue('Feeder one')
  await expect(page.getByRole('button', { name: /^Save( •)?$/ })).toHaveText('Save')

  // A further edit then Ctrl+S: no dialog this time.
  await placeLoads(page, 1, 3)
  await expect(page.getByRole('button', { name: /^Save( •)?$/ })).toHaveText('Save •')
  await page.keyboard.press('Control+s')
  await expect(page.getByRole('dialog', { name: 'Save circuit' })).toHaveCount(0)
  await expect(page.locator('.flash-toast')).toContainText('Saved "Feeder one"')
  await expect(page.getByRole('button', { name: /^Save( •)?$/ })).toHaveText('Save')
})

test('open lists saved circuits and restores one after New', async ({ page }) => {
  await openEditor(page)
  await placeLoads(page, 3)
  await page.keyboard.press('Control+s')
  const dialog = page.getByRole('dialog', { name: 'Save circuit' })
  await dialog.getByLabel('Name').fill('Reopen me')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)

  await page.getByRole('button', { name: 'Open…' }).click()
  const library = page.getByRole('dialog', { name: 'Open circuit' })
  await expect(library).toBeVisible()
  const row = library.locator('tr', { hasText: 'Reopen me' })
  await expect(row).toContainText('3 elements')
  await row.getByRole('button', { name: 'Reopen me' }).click()
  await expect(library).toBeHidden()
  await expect(page.locator('.react-flow__node-load')).toHaveCount(3)
  await expect(page.getByTitle('Circuit name')).toHaveValue('Reopen me')

  // Rename from the dialog, then delete, and the list empties.
  await page.getByRole('button', { name: 'Open…' }).click()
  await library.getByRole('button', { name: 'Rename' }).click()
  await library.locator('input').fill('Renamed')
  await library.locator('input').press('Enter')
  await expect(library.getByRole('button', { name: 'Renamed' })).toBeVisible()
  page.once('dialog', (d) => d.accept())
  await library.getByRole('button', { name: 'Delete' }).click()
  await expect(library.locator('.library-empty')).toBeVisible()
})
