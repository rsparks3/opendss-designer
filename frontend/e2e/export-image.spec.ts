import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const fixturePath = fileURLToPath(
  new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url),
)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

async function openWithFixture(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate(
    (c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c),
    fixture,
  )
  await expect(page.locator('.react-flow__node')).toHaveCount(fixture.nodes.length)
}

async function downloadFrom(page: Page, button: string) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: button, exact: true }).click(),
  ])
  const path = await download.path()
  if (!path) throw new Error('no download path')
  return { name: download.suggestedFilename(), bytes: readFileSync(path) }
}

// A drawing that only exists on screen cannot go into a report. The SVG has
// to be the real thing -- native paths and text, not a screenshot in a
// wrapper -- and it has to carry whatever overlay was on when it was made.
test('SVG export is a native vector drawing carrying the active overlay', async ({ page }) => {
  await openWithFixture(page)
  await page.evaluate(() => {
    const store = (window as any).opendssDesigner.circuit.getState()
    store.updateEdgeParams('e4', { phases: 1, phasing: 'B' })
    store.updateNodeParams('n_xfmr', { rotation: 90 })
    // Something selected: the export must not carry the editor's blue outline.
    store.selectOnly('edge', 'e1')
  })
  await page.getByRole('button', { name: 'Phases', exact: true }).click()
  await expect(page.locator('.phase-badge').first()).toBeVisible()
  // Zoomed and panned: the export must not depend on the view.
  await page.locator('.react-flow__controls-zoomout').click()
  await page.locator('.react-flow__controls-zoomout').click()

  const { name, bytes } = await downloadFrom(page, 'SVG')
  expect(name).toBe('schema-fixture-phases.svg')
  const svg = bytes.toString('utf-8')

  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  // Nothing is a screenshot, nothing leans on the app's stylesheet.
  expect(svg).not.toContain('foreignObject')
  expect(svg).not.toContain('class=')
  // One path per edge, with its colour: the B lateral in B blue.
  const paths = svg.match(/<path /g) ?? []
  expect(paths.length).toBeGreaterThanOrEqual(fixture.edges.length)
  expect(svg).toMatch(/<path d="[^"]*" fill="none" stroke="rgb\(21, 101, 192\)" stroke-width="2.5"/)
  // Symbols come through as SVG (the transformer's circles), rotated.
  expect(svg).toContain('<circle')
  expect(svg).toMatch(/<g transform="rotate\(90 /)
  // Labels and chips are text, not pixels.
  expect(svg).toContain('>LN1</text>')
  expect(svg).toContain('>B</text>')
  expect(svg).toContain('>T1</text>')
  // Legend and caption frame the drawing.
  expect(svg).toContain('>Two-phase</text>')
  expect(svg).toMatch(/schema-fixture · Phases overlay · \d{4}-\d{2}-\d{2}<\/text>/)
  // The selection was dropped before the drawing was read.
  expect(svg).not.toContain('rgb(25, 118, 210)')
  // Selection stays cleared in the editor too.
  expect(await page.locator('.react-flow__edge.selected').count()).toBe(0)
})

test('PNG export rasterises the same drawing at 2x', async ({ page }) => {
  await openWithFixture(page)
  const solve = page.getByRole('button', { name: /Solve/ })
  await solve.click()
  await expect(page.locator('.result-badge').first()).toBeVisible({ timeout: 20_000 })

  const { name, bytes } = await downloadFrom(page, 'PNG')
  expect(name).toBe('schema-fixture-voltage.png')
  // PNG signature, then IHDR width/height as big-endian 32-bit ints.
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  expect(width).toBeGreaterThan(800)
  expect(height).toBeGreaterThan(400)
  expect(bytes.length).toBeGreaterThan(20_000)

  const { bytes: svgBytes } = await downloadFrom(page, 'SVG')
  const svg = svgBytes.toString('utf-8')
  const [, w, h] = /<svg [^>]*width="([\d.]+)" height="([\d.]+)"/.exec(svg) ?? []
  expect(width).toBe(Math.ceil(Number(w) * 2))
  expect(height).toBe(Math.ceil(Number(h) * 2))
  // The voltage legend and badges made it in.
  expect(svg).toContain('>0.95–1.05 pu</text>')
  expect(svg).toMatch(/>1\.\d{3} pu</)
})
