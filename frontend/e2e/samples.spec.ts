import { expect, test, type Page } from '@playwright/test'

async function openEditor(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
}

test('open a curated sample and solve it', async ({ page }) => {
  await openEditor(page)

  const picker = page.getByTitle('Open a ready-made example circuit')
  await expect(picker).toBeVisible()
  await picker.selectOption('radial-feeder-der')

  // The sample loads onto the canvas...
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  // ...and is immediately solvable, which is the point of shipping it.
  await page.getByRole('button', { name: /Solve/ }).click()
  await expect(
    page.locator('.result-badge').filter({ hasText: 'pu' }).first(),
  ).toBeVisible({ timeout: 15000 })
})

test('samples list is served and every entry is loadable', async ({ page }) => {
  await openEditor(page)
  const listed = await page.evaluate(async () => {
    const res = await fetch('/api/samples')
    return (await res.json()).samples as { id: string; nodes: number }[]
  })
  expect(listed.length).toBeGreaterThan(0)
  for (const meta of listed) {
    const ok = await page.evaluate(async (id) => {
      const res = await fetch(`/api/samples/${id}`)
      if (!res.ok) return false
      const circuit = await res.json()
      return Array.isArray(circuit.nodes) && circuit.nodes.length > 0
    }, meta.id)
    expect(ok, `sample ${meta.id} should load`).toBe(true)
  }
})
