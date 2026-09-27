import { describe, expect, it } from 'vitest'
import { align, distribute, flipOnScreen, type Box } from './arrange'

const boxes: Box[] = [
  { id: 'a', x: 0, y: 0, w: 40, h: 60 },
  { id: 'b', x: 100, y: 30, w: 40, h: 60 },
  { id: 'c', x: 300, y: 10, w: 80, h: 20 },
]

describe('align', () => {
  it('lines up left edges on the leftmost', () => {
    const out = align(boxes, 'left')
    expect(Object.values(out).map((p) => p.x)).toEqual([0, 0, 0])
    expect(out.b.y).toBe(30)
  })

  it('lines up right edges on the rightmost', () => {
    const out = align(boxes, 'right')
    expect(out.a.x).toBe(340)
    expect(out.c.x).toBe(300)
  })

  it('centres on the selection, snapped to the grid', () => {
    const out = align(boxes, 'center')
    // selection spans 0..380, centre 190
    expect(out.a.x).toBe(170)
    expect(out.c.x).toBe(150)
  })

  it('lines up tops, middles and bottoms', () => {
    expect(align(boxes, 'top').b.y).toBe(0)
    expect(align(boxes, 'bottom').c.y).toBe(70)
    expect(align(boxes, 'middle').a.y).toBe(20)
  })

  it('does nothing to one box', () => {
    expect(align([boxes[0]], 'left')).toEqual({})
  })
})

describe('distribute', () => {
  it('leaves equal gaps and keeps the ends', () => {
    const row: Box[] = [
      { id: 'a', x: 0, y: 0, w: 40, h: 10 },
      { id: 'b', x: 50, y: 0, w: 40, h: 10 },
      { id: 'c', x: 200, y: 0, w: 40, h: 10 },
    ]
    const out = distribute(row, 'horizontal')
    expect(out.a.x).toBe(0)
    expect(out.c.x).toBe(200)
    // span 240, used 120, gap 60 -> b at 100
    expect(out.b.x).toBe(100)
  })

  it('works vertically and needs three', () => {
    const col: Box[] = [
      { id: 'a', x: 0, y: 0, w: 10, h: 20 },
      { id: 'b', x: 0, y: 25, w: 10, h: 20 },
      { id: 'c', x: 0, y: 100, w: 10, h: 20 },
    ]
    expect(distribute(col, 'vertical').b.y).toBe(50)
    expect(distribute(col.slice(0, 2), 'vertical')).toEqual({})
  })
})

describe('flipOnScreen', () => {
  it('mirrors an upright symbol by flipping it', () => {
    expect(flipOnScreen({}, 'horizontal')).toEqual({ rotation: 0, flip: true })
    expect(flipOnScreen({ flip: true }, 'horizontal')).toEqual({ rotation: 0, flip: false })
  })

  it('turns an upright symbol upside down for a vertical flip', () => {
    expect(flipOnScreen({}, 'vertical')).toEqual({ rotation: 180, flip: true })
  })

  it('folds the rotation in for a turned symbol', () => {
    expect(flipOnScreen({ rotation: 90 }, 'horizontal')).toEqual({ rotation: 270, flip: true })
    expect(flipOnScreen({ rotation: 90 }, 'vertical')).toEqual({ rotation: 90, flip: true })
  })

  it('twice is where it started', () => {
    for (const axis of ['horizontal', 'vertical'] as const) {
      for (const rotation of [0, 90, 180, 270]) {
        const once = flipOnScreen({ rotation }, axis)
        expect(flipOnScreen(once, axis)).toEqual({ rotation, flip: false })
      }
    }
  })
})
