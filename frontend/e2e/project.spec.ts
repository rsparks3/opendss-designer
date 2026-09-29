import { expect, test } from '@playwright/test'
import { menu } from './menu'

// The limits are a project setting: set once, they recolour the drawing,
// save with the file and come back with it.
test('Project properties sets the study block and the limits', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)

  await menu(page, 'File', 'Project properties…')
  const dialog = page.getByRole('dialog', { name: 'Project properties' })
  await dialog.getByLabel('Study title').fill('Feeder 12 peak')
  await dialog.getByLabel('Engineer').fill('R. Engineer')

  await dialog.getByLabel('Undervoltage below').fill('1.2')
  await expect(dialog.locator('.modal-error')).toContainText('below the overvoltage')
  await expect(dialog.getByRole('button', { name: 'Apply limits' })).toBeDisabled()
  await dialog.getByLabel('Undervoltage below').fill('0.97')
  await dialog.getByLabel('Overload at').fill('90')
  await dialog.getByRole('button', { name: 'Apply limits' }).click()

  const saved = await page.evaluate(() => {
    const s = (window as any).opendssDesigner.circuit.getState()
    return { limits: s.limits, study: s.study }
  })
  expect(saved.limits).toEqual({ vminPu: 0.97, vmaxPu: 1.05, overloadPct: 90, warnPct: 80 })
  expect(saved.study.title).toBe('Feeder 12 peak')
  expect(saved.study.engineer).toBe('R. Engineer')

  await dialog.getByRole('button', { name: 'Use the defaults' }).click()
  expect(await page.evaluate(() => (window as any).opendssDesigner.circuit.getState().limits)).toBeNull()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
})
