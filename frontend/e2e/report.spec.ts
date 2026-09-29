import { readFileSync } from 'node:fs'
import ExcelJS from 'exceljs'
import { expect, test, type Page } from '@playwright/test'
import { menu } from './menu'

async function openSample(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await menu(page, 'File', 'Samples', 'IEEE 13-bus test feeder')
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
}

// A study report is the file an engineer hands on. Both formats come out of
// one dialog, solving and running the fault study on the way if needed.
test('exports a study report as PDF and Excel', async ({ page }) => {
  await openSample(page)
  await menu(page, 'File', 'Project properties…')
  const props = page.getByRole('dialog', { name: 'Project properties' })
  await props.getByLabel('Study title').fill('IEEE 13 peak study')
  await props.getByRole('button', { name: 'Close' }).click()

  await menu(page, 'File', 'Export', 'Study report…')
  const dialog = page.getByRole('dialog', { name: 'Study report' })
  await dialog.getByLabel('Both').check()
  // Time series has not been run, so it cannot be chosen.
  await expect(dialog.getByRole('checkbox', { name: /Time series/ })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: /Short circuit/ }).check()

  const downloads: { name: string; path: string }[] = []
  page.on('download', async (d) => downloads.push({ name: d.suggestedFilename(), path: (await d.path())! }))
  await dialog.getByRole('button', { name: 'Export' }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30000 })
  await expect.poll(() => downloads.length, { timeout: 15000 }).toBe(2)

  const pdf = downloads.find((d) => d.name.endsWith('.pdf'))!
  const xlsx = downloads.find((d) => d.name.endsWith('.xlsx'))!
  expect(pdf.name).toMatch(/-report\.pdf$/)
  const pdfBytes = readFileSync(pdf.path)
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect(pdfBytes.length).toBeGreaterThan(20000)

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(xlsx.path) as unknown as ArrayBuffer)
  const names = wb.worksheets.map((w) => w.name)
  expect(names).toEqual(expect.arrayContaining(['Study', 'Bus voltages', 'Branch flows', 'One-line diagram', 'Short circuit']))
  // The one-line went in as a picture.
  expect(wb.getWorksheet('One-line diagram')!.getImages()).toHaveLength(1)
  const study = wb.getWorksheet('Study')!
  expect(study.getCell(3, 2).value).toBe('IEEE 13 peak study')
  // The remembered choice comes back next time.
  await menu(page, 'File', 'Export', 'Study report…')
  await expect(page.getByRole('dialog', { name: 'Study report' }).getByLabel('Both')).toBeChecked()
})
