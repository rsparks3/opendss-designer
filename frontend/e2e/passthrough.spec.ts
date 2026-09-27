import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { menu } from './menu'

const FEEDER = [
  '! Feeder header comment',
  'new circuit.pt basekv=12.47 pu=1.0 phases=3 bus1=srcbus mvasc3=2000',
  '! The trunk',
  'new line.l1 bus1=srcbus bus2=b2 r1=0.1 x1=0.3 r0=0.3 x0=0.9 length=1 units=km',
  'new load.ld1 bus1=b2 phases=3 kv=12.47 kw=500 pf=0.95',
  'new energymeter.m1 element=line.l1 terminal=1',
  'new monitor.mon1 element=line.l1 terminal=2',
  'set voltagebases=[12.47]',
  'calcvoltagebases',
].join('\n')

test('an imported meter and monitor are kept, solved, exported, and follow a rename', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)

  const chooser = page.waitForEvent('filechooser')
  await menu(page, 'File', 'Import .dss…')
  await (await chooser).setFiles({ name: 'pt.dss', mimeType: 'text/plain', buffer: Buffer.from(FEEDER) })
  await expect(page.locator('.flash-toast')).toContainText('Kept 2 elements the drawing does not show')

  await page.getByRole('button', { name: /^Passthrough/ }).click()
  await expect(page.locator('.curves-item')).toHaveCount(2)
  await expect(page.locator('.curves-item').first()).toContainText('in solve')
  await expect(page.locator('.curves-list .curves-used')).toContainText('2 comments from the imported file')

  await page.getByRole('button', { name: /Solve/ }).click()
  await expect(page.locator('.result-badge').filter({ hasText: 'pu' }).first()).toBeVisible({ timeout: 20_000 })

  // The export carries both, and the comments, back out.
  const [download] = await Promise.all([page.waitForEvent('download'), menu(page, 'File', 'Export', 'OpenDSS (.dss)')])
  const dss = readFileSync((await download.path())!, 'utf-8')
  expect(dss).toContain('! Feeder header comment')
  expect(dss).toContain('! The trunk\nnew line.l1')
  expect(dss).toContain('new energymeter.m1 element=line.l1')

  // Rename the line in the editor: the meter follows it.
  await page.evaluate(() => {
    const s = (window as any).opendssDesigner.circuit.getState()
    const line = s.edges.find((e: any) => e.type === 'line')
    s.updateEdgeParams(line.id, { name: 'trunk' })
  })
  await expect(page.locator('.pt-text')).toHaveValue(/element=line\.trunk/)
})
