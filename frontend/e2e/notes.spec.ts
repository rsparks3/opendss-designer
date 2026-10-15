import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { menu } from './menu'

const fixturePath = fileURLToPath(new URL('../../tests/fixtures/full-circuit.oneline.json', import.meta.url))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

async function open(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await page.evaluate((c) => (window as any).opendssDesigner.circuit.getState().loadCircuit(c), fixture)
  await expect(page.locator('.react-flow__node')).toHaveCount(fixture.nodes.length)
}

const notes = (page: Page) =>
  page.evaluate(() =>
    (window as any).opendssDesigner.circuit
      .getState()
      .nodes.filter((n: any) => n.type === 'note')
      .map((n: any) => ({ id: n.id, params: n.data.params })),
  )

test('N places a note that is typed into straight away', async ({ page }) => {
  await open(page)
  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } })
  await page.keyboard.press('n')
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 150 } })
  const editor = page.getByRole('textbox', { name: 'Note text' })
  await expect(editor).toBeFocused()
  await editor.fill('Replace recloser\nin 2027')
  await page.keyboard.press('Control+Enter')
  await expect(editor).toHaveCount(0)
  const added = (await notes(page)).find((n) => n.params.text === 'Replace recloser\nin 2027')
  expect(added).toBeTruthy()
  // Two lines on the canvas, as typed.
  const node = page.locator(`.react-flow__node[data-id="${added!.id}"]`)
  await expect(node.locator('.note-line')).toHaveCount(2)
  // Placement ended with the note: another click places nothing. Click up
  // and away from the canvas controls, which sit lower on a short pane.
  await page.locator('.react-flow__pane').click({ position: { x: 400, y: 40 } })
  expect(await notes(page)).toHaveLength(2)
})

test('a note pointed at an element draws an arrow, and exports with it', async ({ page }) => {
  await open(page)
  // The fixture's note points at the source.
  const fixtureNote = page.locator('.react-flow__node[data-id="n_note"]')
  await expect(fixtureNote.locator('svg.note-leader line')).toHaveCount(1)

  // Right-click a load: Add note pointing here.
  await page.locator('.react-flow__node[data-id="n_load"]').click({ button: 'right' })
  await page.getByRole('button', { name: 'Add note pointing here' }).click()
  const editor = page.getByRole('textbox', { name: 'Note text' })
  await editor.fill('Overloaded at peak')
  await editor.blur()
  const added = (await notes(page)).find((n) => n.params.text === 'Overloaded at peak')!
  expect(added.params.target).toBe('n_load')
  await expect(page.locator(`.react-flow__node[data-id="${added.id}"] svg.note-leader`)).toHaveCount(1)

  // The properties panel can re-point it at nothing.
  await page.getByLabel('Points at').selectOption('')
  await expect(page.locator(`.react-flow__node[data-id="${added.id}"] svg.note-leader`)).toHaveCount(0)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    menu(page, 'File', 'Export', 'Image (SVG)'),
  ])
  const svg = readFileSync((await download.path())!, 'utf-8')
  for (const word of ['Utility', 'source', 'Fault', 'Overloaded', 'peak']) {
    expect(svg).toContain(`>${word}</text>`)
  }
  expect(svg).not.toContain('Double-click to type')
})
