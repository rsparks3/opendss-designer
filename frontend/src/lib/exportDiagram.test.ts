import { describe, expect, it } from 'vitest'
import { imageFileName, legendFor, OVERLAY_LABELS, rotationOf } from './exportDiagram'
import { PHASE_LEGEND } from './phasing'

describe('rotationOf', () => {
  it('reads the angle out of a CSS matrix', () => {
    expect(rotationOf('none')).toBe(0)
    expect(rotationOf('matrix(1, 0, 0, 1, 20, -20)')).toBe(0)
    expect(rotationOf('matrix(0, 1, -1, 0, 0, 0)')).toBeCloseTo(90)
    expect(rotationOf('matrix(-1, 0, 0, -1, 0, 0)')).toBeCloseTo(180)
    expect(rotationOf('matrix(0, -1, 1, 0, 0, 0)')).toBeCloseTo(-90)
  })
})

describe('imageFileName', () => {
  it('names the file after the circuit and the overlay', () => {
    expect(imageFileName('Feeder 12', 'phases', 'svg')).toBe('Feeder 12-phases.svg')
    expect(imageFileName('Feeder 12', 'off', 'png')).toBe('Feeder 12.png')
    expect(imageFileName('', 'voltage', 'png')).toBe('circuit-voltage.png')
  })
  it('strips what a file system refuses', () => {
    expect(imageFileName('a/b:c?', 'off', 'svg')).toBe('a-b-c-.svg')
  })
})

describe('legendFor', () => {
  it('explains every overlay that colours by value', () => {
    expect(legendFor('phases')).toBe(PHASE_LEGEND)
    expect(legendFor('voltage').map((e) => e.label)).toEqual([
      '< 0.95 pu',
      '0.95–1.05 pu',
      '> 1.05 pu',
      'de-energised',
    ])
    expect(legendFor('loading')).toHaveLength(3)
    // kA badges and kW labels say what they are; nothing to explain.
    expect(legendFor('fault')).toEqual([])
    expect(legendFor('power')).toEqual([])
    expect(legendFor('off')).toEqual([])
  })
  it('has a caption label for every overlay', () => {
    for (const mode of ['voltage', 'loading', 'power', 'fault', 'phases', 'off'] as const) {
      expect(typeof OVERLAY_LABELS[mode]).toBe('string')
    }
    expect(OVERLAY_LABELS.off).toBe('')
  })
})
