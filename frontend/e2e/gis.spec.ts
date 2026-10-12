import { expect, test } from '@playwright/test'
import { menu } from './menu'

// A small feeder as GIS exports it: GeoJSON layers in longitude/latitude, no
// bus columns anywhere, so the topology has to come from the geometry. A
// substation, a primary running east with a lateral, two single-phase
// pole-top transformers on the lateral and a meter beside each.
const lon = (m: number) => -111.94 + m / 92_900 // metres east, near Tempe
const lat = (m: number) => 33.42 + m / 110_900 // metres north
const pt = (e: number, n: number) => [lon(e), lat(n)]

const fc = (features: object[]) => JSON.stringify({ type: 'FeatureCollection', features })
const feature = (properties: object, geometry: object) => ({ type: 'Feature', properties, geometry })

const layers = {
  'Substation.geojson': fc([feature({ NAME: 'Sub1', KV: 12.47 }, { type: 'Point', coordinates: pt(0, 0) })]),
  'Primary.geojson': fc([
    feature({ FACILITYID: 'P1', PHASE: 'ABC' }, { type: 'LineString', coordinates: [pt(0, 0), pt(300, 0), pt(600, 0)] }),
    feature({ FACILITYID: 'P2', PHASE: 'ABC' }, { type: 'LineString', coordinates: [pt(600, 0), pt(1200, 0)] }),
    feature({ FACILITYID: 'LAT1', PHASE: 'B' }, { type: 'LineString', coordinates: [pt(600, 0), pt(600, 250), pt(600, 400)] }),
  ]),
  'Transformers.geojson': fc([
    feature({ FACILITYID: 'T1', KVA: 25, PHASE: 'B' }, { type: 'Point', coordinates: pt(600, 400) }),
    feature({ FACILITYID: 'T2', KVA: 50, PHASE: 'ABC' }, { type: 'Point', coordinates: pt(1200, 0) }),
  ]),
  'Meters.geojson': fc([
    feature({ FACILITYID: 'M1', KW: 4 }, { type: 'Point', coordinates: pt(610, 405) }),
    feature({ FACILITYID: 'M2', KW: 30, PHASE: 'ABC' }, { type: 'Point', coordinates: pt(1205, 8) }),
  ]),
}

test('GeoJSON layers become a connected, solvable circuit on the map', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('opendss-designer.basemap', 'none')
  })
  await page.goto('/')
  await page.waitForFunction(() => !!(window as any).opendssDesigner)

  await menu(page, 'File', 'Import from', 'GIS layers or CSV tables…')
  const dialog = page.getByRole('dialog', { name: 'Import GIS layers or CSV tables' })
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Choose files…' }).click()
  await (await chooser).setFiles(
    Object.entries(layers).map(([name, text]) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) })),
  )
  // Classes guessed from the layer names, columns matched by name.
  await expect(dialog.getByLabel('Primary class')).toHaveValue('line')
  await expect(dialog.getByLabel('Substation class')).toHaveValue('source')
  await expect(dialog.getByLabel('Transformers class')).toHaveValue('transformer')
  await expect(dialog.getByLabel('Meters class')).toHaveValue('load')
  await dialog.getByRole('button', { name: /Primary/ }).first().click()
  await dialog.getByRole('button', { name: /Primary/ }).first().click()
  await dialog.getByRole('button', { name: 'Import' }).click()
  await expect(dialog).toHaveCount(0)

  const summary = await page.evaluate(() => {
    const s = (window as any).opendssDesigner.circuit.getState()
    const count = (t: string) => s.nodes.filter((n: any) => n.type === t).length
    const lat1 = s.edges.find((e: any) => e.data?.params?.name?.toLowerCase() === 'lat1')
    return { crs: s.crs, loads: count('load'), xfmrs: count('transformer'), route: lat1?.data?.geometry?.length ?? 0 }
  })
  expect(summary).toEqual({ crs: 'EPSG:4326', loads: 2, xfmrs: 2, route: 1 })
  await expect(page.locator('.problems-list li')).toHaveCount(0)

  await page.getByRole('button', { name: /Solve/ }).click()
  await page.waitForFunction(() => (window as any).opendssDesigner.results.getState().result?.converged, null, {
    timeout: 20_000,
  })

  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await expect(page.locator('.geo-status')).toContainText(/(\d+) of \1 on the map · WGS 84 \(EPSG:4326\)/)
})
