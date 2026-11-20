import { readFileSync } from 'node:fs'
import ExcelJS from 'exceljs'
import { expect, test } from '@playwright/test'
import { menu } from './menu'

// Milestone A of the facility plan, end to end on the installation sample:
// what feeds what, what happens when the utility goes, the configurations
// compared -- and all of it in the report.
test('installation: trace, loss of utility, scenario comparison and the report', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await menu(page, 'File', 'Samples', 'Installation campus')
  await expect(page.locator('.react-flow__node[data-id="brk_f1"]')).toBeVisible()

  // What a feeder breaker would drop, critical first.
  await page.locator('.react-flow__node[data-id="brk_f2"]').click({ button: 'right' })
  await page.getByRole('button', { name: 'Show downstream' }).click()
  const panel = page.getByRole('dialog', { name: 'Downstream' })
  await expect(panel).toContainText('OPS CENTER')
  await expect(panel.locator('.trace-group').first()).toContainText('Critical')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // Every scenario solved: the outage with the bus split leaves G2 over its rating.
  await page.getByText('Scenarios', { exact: true }).first().click()
  await page.getByRole('button', { name: '▶ Run all' }).click()
  await expect(page.getByText(/run \d/)).toBeVisible({ timeout: 30000 })
  await page.getByLabel('Batch view').selectOption('unserved')
  await expect(page.locator('.scenarios-compare-table td.worst').first()).toBeVisible()

  // Open the outage, look at the islands.
  await page.getByRole('button', { name: /Utility outage, bus split/ }).click()
  await menu(page, 'Analysis', 'Overlay', 'Islands')
  await page.getByRole('button', { name: /Solve/ }).first().click()
  const cards = page.getByRole('list', { name: 'Islands' })
  await expect(cards.locator('.island-card.alarm')).toContainText('G2 CENTRAL PLANT', { timeout: 15000 })
  await expect(cards.locator('.island-card.ok')).toContainText('G1')

  // The report: critical loads, loss of utility and the scenarios.
  await menu(page, 'File', 'Export', 'Study report…')
  const dialog = page.getByRole('dialog', { name: 'Study report' })
  await dialog.getByLabel('Excel workbook').check()
  for (const name of [/Critical loads/, /Loss of utility/, /^Scenarios Each/]) {
    await dialog.getByRole('checkbox', { name }).check()
  }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    dialog.getByRole('button', { name: 'Export' }).click(),
  ])
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync((await download.path())!) as unknown as ArrayBuffer)
  const names = wb.worksheets.map((w) => w.name)
  expect(names).toEqual(expect.arrayContaining(['Critical loads', 'Loss of utility', 'Scenarios']))
  const outage = wb.getWorksheet('Loss of utility')!
  const text: string[] = []
  outage.eachRow((row) => row.eachCell((c) => text.push(String(c.value ?? ''))))
  expect(text.join(' ')).toContain('G2 CENTRAL PLANT')
  expect(text.join(' ')).toMatch(/screening grade/i)
})
