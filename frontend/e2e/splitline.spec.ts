import { expect, test } from '@playwright/test'
import { menu } from './menu'

test('right-click a line, Split line here: a new bus, two halves, still solves', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
  await menu(page, 'File', 'Samples', 'Radial feeder with DER')
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  const before = await page.evaluate(() => {
    const s = (window as any).opendssDesigner.circuit.getState()
    const line = s.edges.find((e: any) => e.type === 'line')
    return { id: line.id, length: line.data.params.length, name: line.data.params.name, bars: s.nodes.filter((n: any) => n.type === 'busbar').length }
  })

  // A point on the line as drawn and not under its label, once the view
  // has settled with the line in sight.
  await menu(page, 'View', 'Bottom panel')
  const pointOnLine = () =>
    page.evaluate((id) => {
      const path = document.querySelector(`[data-id="${id}"] path.react-flow__edge-path`) as SVGPathElement
      const m = path.getScreenCTM()!
      for (const f of [0.2, 0.7, 0.4, 0.85]) {
        const p = path.getPointAtLength(path.getTotalLength() * f)
        const at = { x: p.x * m.a + m.e, y: p.y * m.d + m.f }
        const hit = document.elementFromPoint(at.x, at.y)?.closest('.react-flow__edge')
        if (hit?.getAttribute('data-id') === id) return at
      }
      return null
    }, before.id)
  await expect.poll(pointOnLine).not.toBeNull()
  const at = (await pointOnLine())!
  await page.mouse.click(at.x, at.y, { button: 'right' })
  await page.getByRole('button', { name: 'Split line here' }).click()

  const after = await page.evaluate((id) => {
    const s = (window as any).opendssDesigner.circuit.getState()
    const lines = s.edges.filter((e: any) => e.type === 'line')
    const first = lines.find((e: any) => e.id === id)
    const second = lines.find((e: any) => e.data.params.name.endsWith('_2'))
    return {
      bars: s.nodes.filter((n: any) => n.type === 'busbar').length,
      sum: first.data.params.length + second.data.params.length,
      first: first.data.params.length,
    }
  }, before.id)
  expect(after.bars).toBe(before.bars + 1)
  expect(after.sum).toBeCloseTo(before.length, 6)
  expect(after.first).toBeGreaterThan(0)
  expect(after.first).toBeLessThan(before.length)
  await page.screenshot({ path: 'C:/Users/ryan/AppData/Local/Temp/claude/C--Users-ryan-Documents-opendss-interface/6b550ce7-9f6d-45bf-9b0d-6e419c05f272/scratchpad/split.png' })

  await page.getByRole('button', { name: /Solve/ }).click()
  await expect(page.locator('.result-badge').filter({ hasText: 'pu' }).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.flash-toast.error')).toHaveCount(0)
})
