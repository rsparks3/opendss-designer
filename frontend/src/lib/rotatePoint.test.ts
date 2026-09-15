import { describe, expect, it } from 'vitest'
import { rotatePoint } from './rotatePoint'

// The three-winding transformer: a 60×80 symbol whose tertiary terminal
// leaves the right edge at (60, 40), off the centre line the other two use.
describe('rotatePoint', () => {
  it('leaves an unrotated point alone', () => {
    expect(rotatePoint(60, 40, 60, 80, 0)).toEqual({ x: 60, y: 40 })
  })
  it('turns the right edge into the bottom edge at 90°', () => {
    // Box is now 80 wide and 60 tall; the terminal sits on the bottom.
    expect(rotatePoint(60, 40, 60, 80, 90)).toEqual({ x: 40, y: 60 })
    // The primary's top-centre terminal moves to the right edge.
    expect(rotatePoint(20, 0, 60, 80, 90)).toEqual({ x: 80, y: 20 })
  })
  it('mirrors through the centre at 180°', () => {
    expect(rotatePoint(60, 40, 60, 80, 180)).toEqual({ x: 0, y: 40 })
    expect(rotatePoint(20, 0, 60, 80, 180)).toEqual({ x: 40, y: 80 })
  })
  it('turns the right edge into the top edge at 270°', () => {
    expect(rotatePoint(60, 40, 60, 80, 270)).toEqual({ x: 40, y: 0 })
  })
  it('treats negative and oversized angles as the same quarter turns', () => {
    expect(rotatePoint(60, 40, 60, 80, -90)).toEqual(rotatePoint(60, 40, 60, 80, 270))
    expect(rotatePoint(60, 40, 60, 80, 450)).toEqual(rotatePoint(60, 40, 60, 80, 90))
  })
  it('keeps a centred terminal centred, so two-winding symbols are unchanged', () => {
    expect(rotatePoint(20, 80, 40, 80, 90)).toEqual({ x: 0, y: 20 })
    expect(rotatePoint(20, 0, 40, 80, 270)).toEqual({ x: 0, y: 20 })
  })
})
