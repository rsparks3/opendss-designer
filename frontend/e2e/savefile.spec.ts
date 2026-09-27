import { expect, test, type Page } from '@playwright/test'
import { menu } from './menu'

// The real pickers are native dialogs Playwright cannot drive, so these tests
// stand in for them with handles that record what was written. Everything
// between the menu and the handle is the app's own code.
async function openWithFakePickers(page: Page, existing?: string) {
  await page.addInitScript((existingText) => {
    localStorage.clear()
    const w = window as any
    w.__writes = [] as { name: string; text: string }[]
    w.__pickerCalls = 0
    const handle = (name: string, text: string) => ({
      name,
      getFile: async () => new File([text], name),
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      createWritable: async () => {
        let buf = ''
        return {
          write: async (d: string) => {
            buf += d
          },
          close: async () => {
            w.__writes.push({ name, text: buf })
          },
        }
      },
    })
    w.showSaveFilePicker = async (o: { suggestedName: string }) => {
      w.__pickerCalls++
      return handle(o.suggestedName, '')
    }
    w.showOpenFilePicker = async () => {
      w.__pickerCalls++
      return [handle('existing.oneline.json', existingText ?? '{}')]
    }
  }, existing)
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)
}

async function placeLoad(page: Page, x: number) {
  await page.evaluate((x) => (window as any).opendssDesigner.circuit.getState().addNodeAt('load', { x, y: 200 }), x)
}

test('Save to file asks once, then writes back over the same file', async ({ page }) => {
  await openWithFakePickers(page)
  await page.getByTitle('Circuit name').fill('feeder')
  await placeLoad(page, 300)

  await menu(page, 'File', 'Save to file')
  await expect(page.locator('.flash-toast')).toContainText('Saved to feeder.oneline.json')
  await expect(page.locator('.tb-file')).toHaveText('feeder.oneline.json')
  await expect(page.getByRole('button', { name: 'Unsaved changes' })).toHaveCount(0)

  // A second save, by keyboard, goes straight to the same file.
  await placeLoad(page, 400)
  await page.keyboard.press('Control+Alt+s')
  await expect.poll(() => page.evaluate(() => (window as any).__writes.length)).toBe(2)
  const [calls, writes] = await page.evaluate(() => [(window as any).__pickerCalls, (window as any).__writes])
  expect(calls).toBe(1)
  expect(writes[1].name).toBe('feeder.oneline.json')
  expect(JSON.parse(writes[1].text).nodes).toHaveLength(2)

  // Save to file as… picks again.
  await menu(page, 'File', 'Save to file as…')
  await expect.poll(() => page.evaluate(() => (window as any).__pickerCalls)).toBe(2)
})

test('a file opened from disk stays linked; New unlinks it', async ({ page }) => {
  const project = {
    version: 1,
    name: 'from-disk',
    nodes: [{ id: 'n1', type: 'load', position: { x: 0, y: 0 }, params: { name: 'L1', kv: 12.47, kw: 10 } }],
    edges: [],
  }
  await openWithFakePickers(page, JSON.stringify(project))
  await menu(page, 'File', 'Open file…')
  await expect(page.locator('.react-flow__node-load')).toHaveCount(1)
  await expect(page.getByTitle('Circuit name')).toHaveValue('from-disk')
  await expect(page.locator('.tb-file')).toHaveText('existing.oneline.json')

  await menu(page, 'File', 'Save to file')
  await expect.poll(() => page.evaluate(() => (window as any).__writes.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__writes[0].name)).toBe('existing.oneline.json')

  await menu(page, 'File', 'New')
  await expect(page.locator('.tb-file')).toHaveCount(0)
})
