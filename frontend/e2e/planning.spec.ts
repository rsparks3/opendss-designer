import { readFileSync } from 'node:fs'
import ExcelJS from 'exceljs'
import { expect, test, type Page } from '@playwright/test'
import { menu } from './menu'

async function studies(page: Page, name: string) {
  // The tab toggles the panel, so only press it when the panel is not showing.
  if (!(await page.locator('.studies-side').isVisible())) {
    await page.getByText('Studies', { exact: true }).first().click()
  }
  await page.locator('.studies-side').getByRole('button', { name, exact: true }).click()
}

async function sheetText(wb: ExcelJS.Workbook, name: string): Promise<string> {
  const ws = wb.getWorksheet(name)
  expect(ws, `sheet ${name}`).toBeTruthy()
  const text: string[] = []
  ws!.eachRow((row) => row.eachCell((c) => text.push(String(c.value ?? ''))))
  return text.join(' ')
}

// Milestone B of the facility plan, end to end on the installation sample:
// rank contingencies with the standby generators, size a new load with the
// probe, screen equipment duty, read a coordination chain off the TCC plot
// -- and all of it in the report.
test('installation: N-1, headroom and probe, duty, TCC chain, backup sizing and the report', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await menu(page, 'File', 'Samples', 'Installation campus')
  await expect(page.locator('.react-flow__node[data-id="brk_f1"]')).toBeVisible()

  // --- 2.1 N-1 with standby generators -----------------------------------------------
  await studies(page, 'Contingency')
  await expect(page.getByText(/≈ \d+ solves/)).toBeVisible()
  await page.getByLabel('start standby generators').check()
  await page.getByRole('button', { name: /Run n-1 contingency/i }).click()
  const n1 = page.locator('.study table.bp-table').first()
  const f1 = n1.locator('tr', { hasText: '52-F1' })
  await expect(f1).toContainText('G1', { timeout: 30000 })
  // Shown on the drawing, unsaved; then kept as a scenario.
  await f1.getByRole('button', { name: 'Show' }).click()
  await expect(page.locator('.scenario-banner.preview')).toContainText('N-1: 52-F1 out')
  await page.locator('.scenario-banner').getByRole('button', { name: 'Return to base case' }).click()
  await expect(page.locator('.scenario-banner')).toHaveCount(0)
  await f1.getByRole('button', { name: 'Save as scenario' }).click()
  await expect(page.locator('.scenario-banner')).toContainText('Editing scenario N-1: 52-F1 out')
  await page.locator('.scenario-banner').getByRole('button', { name: 'Return to base case' }).click()

  // --- 2.2 headroom and the probe ------------------------------------------------------
  await studies(page, 'Headroom')
  await page.getByRole('button', { name: /Run capacity headroom/i }).click()
  await expect(page.locator('.study table.bp-table').first()).toContainText(/thermal|voltage/, { timeout: 30000 })
  await page.locator('.react-flow__node[data-id="bus_hosp"]').click({ button: 'right' })
  await page.getByRole('button', { name: 'Find maximum load here' }).click()
  await expect(page.locator('.study').getByText('HOSPITAL MV')).toBeVisible({ timeout: 30000 })

  // --- 2.4 equipment duty ----------------------------------------------------------------
  await menu(page, 'Analysis', 'Overlay', 'Duty')
  await expect(page.getByRole('list', { name: 'Equipment duty' })).toContainText('screening only', { timeout: 15000 })
  await expect(page.locator('.react-flow__node[data-id="brk_f1"] .result-badge')).toContainText('/ 25 kA')
  await studies(page, 'Equipment duty')
  await expect(page.locator('.study table.bp-table').first()).toContainText('unrated')

  // --- 2.5 the TCC chain ---------------------------------------------------------------
  await page.locator('.react-flow__node[data-id="fu_clinic"]').click({ button: 'right' })
  await page.getByRole('button', { name: 'Plot TCC' }).click()
  await expect(page.getByLabel('Devices plotted')).toHaveValue('chain', { timeout: 15000 })
  const chain = page.locator('.tcc-switches', { hasText: 'Coordination along the chain' })
  await expect(chain).toContainText('F-CLINIC → 52-F1', { timeout: 15000 })
  await expect(chain.locator('tr', { hasText: '3φ' })).toContainText('graded')
  await expect(page.locator('g.tcc-margin.ok')).toHaveCount(1)
  await page.getByRole('button', { name: 'Save set…' }).click()
  await page.getByLabel('Set name').fill('Clinic chain')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByLabel('Devices plotted')).toHaveValue('tcc1')

  // --- 2.3 backup sizing ---------------------------------------------------------------
  await page.locator('.react-flow__node[data-id="brk_f1"]').click({ button: 'right' })
  await page.getByRole('button', { name: 'Size backup for downstream…' }).click()
  const sizing = page.getByRole('dialog', { name: 'Size backup' })
  await sizing.getByLabel('Generator kW').fill('900')
  await sizing.getByRole('button', { name: 'Size', exact: true }).click()
  await expect(sizing).toContainText('Verification:', { timeout: 30000 })
  await expect(sizing.locator('.sizing-chart svg')).toBeVisible()
  await sizing.getByRole('button', { name: 'Insert in a new scenario' }).click()
  await expect(page.locator('.scenario-banner')).toContainText('Backup for 52-F1')
  await page.locator('.scenario-banner').getByRole('button', { name: 'Return to base case' }).click()

  // --- the report -------------------------------------------------------------------------
  await menu(page, 'File', 'Export', 'Study report…')
  const dialog = page.getByRole('dialog', { name: 'Study report' })
  await dialog.getByLabel('Excel workbook').check()
  for (const name of [/^Protection/, /^Equipment duty screening/, /^Planning studies/]) {
    await dialog.getByRole('checkbox', { name }).check()
  }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    dialog.getByRole('button', { name: 'Export' }).click(),
  ])
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync((await download.path())!) as unknown as ArrayBuffer)
  const duty = await sheetText(wb, 'Equipment duty screening')
  expect(duty).toContain('52-F1')
  expect(duty).toMatch(/not an ANSI C37/)
  const planning = await sheetText(wb, 'Planning studies')
  expect(planning).toContain('Contingency ranking')
  expect(planning).toContain('Capacity headroom')
  expect(planning).toContain('HOSPITAL MV')
  expect(planning).toMatch(/Standby generators/)
  expect(planning).toContain('Backup sizing')
})
