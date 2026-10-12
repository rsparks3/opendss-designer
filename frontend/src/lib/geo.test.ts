import { describe, expect, it } from 'vitest'
import { lonLatToWorld, projectionFor, tileUrl, worldToLonLat } from './geo'

describe('projectionFor', () => {
  it('reads an EPSG code from the bundled list and round-trips a point', async () => {
    // NAD83 / Arizona Central (ft): Tempe, about 111.94 W 33.42 N.
    const p = await projectionFor('EPSG:2223')
    expect(p?.label).toContain('Arizona Central')
    const [lon, lat] = p!.toLonLat(712000, 875000)
    expect(lon).toBeGreaterThan(-112.2)
    expect(lon).toBeLessThan(-111.6)
    expect(lat).toBeGreaterThan(33.2)
    expect(lat).toBeLessThan(33.7)
    const [x, y] = p!.fromLonLat(lon, lat)
    expect(x).toBeCloseTo(712000, 3)
    expect(y).toBeCloseTo(875000, 3)
  })

  it('accepts a bare code, a proj4 string and WKT, and refuses nonsense', async () => {
    expect(await projectionFor('26912')).not.toBeNull()
    expect(await projectionFor('+proj=utm +zone=12 +datum=NAD83 +units=m +no_defs')).not.toBeNull()
    const wkt =
      'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],' +
      'PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]'
    const geo = await projectionFor(wkt)
    expect(geo!.toLonLat(-111.9, 33.4)[0]).toBeCloseTo(-111.9, 6)
    expect(await projectionFor('EPSG:999999')).toBeNull()
    expect(await projectionFor('not a projection')).toBeNull()
    expect(await projectionFor('')).toBeNull()
  })
})

describe('Web Mercator', () => {
  it('maps the world to 0..256 at zoom 0 and back', () => {
    expect(lonLatToWorld(-180, 0)[0]).toBeCloseTo(0)
    expect(lonLatToWorld(0, 0)).toEqual([128, 128])
    const [x, y] = lonLatToWorld(-111.94, 33.42)
    const [lon, lat] = worldToLonLat(x, y)
    expect(lon).toBeCloseTo(-111.94, 9)
    expect(lat).toBeCloseTo(33.42, 9)
  })

  it('fills an XYZ template', () => {
    expect(tileUrl('https://t/{z}/{x}/{y}.png', 3, 1, 2)).toBe('https://t/3/1/2.png')
    expect(tileUrl('https://{s}.t/{z}/{x}/{y}.png', 3, 1, 1)).toBe('https://c.t/3/1/1.png')
  })
})
