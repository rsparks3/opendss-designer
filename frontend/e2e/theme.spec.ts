import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { menu } from './menu'

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url)), 'utf-8'),
)

async function openWithFixture(page: Page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.clear()
      sessionStorage.setItem('seeded', '1')
    }
  })
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate((c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c), fixture)
  await expect(page.locator('.react-flow__node')).toHaveCount(fixture.nodes.length)
}

const strokeOf = (page: Page, id: string) =>
  page.evaluate((id) => getComputedStyle(document.querySelector(`[data-id="${id}"] path`)!).stroke, id)

test('View → Theme → Dark darkens the page and the drawing, and is remembered', async ({ page }) => {
  await openWithFixture(page)
  const light = await strokeOf(page, 'e1')
  await menu(page, 'View', 'Theme', 'Dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // Wires draw in the light ink of the dark theme.
  await expect.poll(() => strokeOf(page, 'e1')).not.toBe(light)
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.app')!).backgroundColor)
  expect(bg).toBe('rgb(27, 30, 34)')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('an image exported in dark mode is still drawn on white in dark ink', async ({ page }) => {
  await openWithFixture(page)
  await menu(page, 'View', 'Theme', 'Dark')
  const [download] = await Promise.all([page.waitForEvent('download'), menu(page, 'File', 'Export', 'Image (SVG)')])
  const svg = readFileSync((await download.path())!, 'utf-8')
  expect(svg).toContain('fill="#ffffff"')
  // The light theme's ink, #263238, not the dark theme's.
  expect(svg).toContain('rgb(38, 50, 56)')
  expect(svg).not.toContain('rgb(221, 227, 232)')
  // And the screen went back to dark.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('a phase colour picked in Preferences recolours the Phases overlay', async ({ page }) => {
  await openWithFixture(page)
  await page.evaluate(() => {
    const store = (window as any).opendssDesigner.circuit.getState()
    store.updateEdgeParams('e4', { phases: 1, phasing: 'B' })
    store.updateEdgeParams('e4b', { phases: 1, phasing: 'B', linecode: '' })
  })
  await page.getByRole('button', { name: 'Phases', exact: true }).click()
  await expect.poll(() => strokeOf(page, 'e4')).toBe('rgb(21, 101, 192)')

  await menu(page, 'View', 'Preferences…')
  const prefs = page.getByRole('dialog', { name: 'Preferences' })
  await prefs.getByLabel('Phase B').fill('#ff8800')
  await expect.poll(() => strokeOf(page, 'e4')).toBe('rgb(255, 136, 0)')
  await prefs.getByRole('button', { name: 'Use the default colours' }).click()
  await expect.poll(() => strokeOf(page, 'e4')).toBe('rgb(21, 101, 192)')
})
