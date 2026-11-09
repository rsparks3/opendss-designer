import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wheelWouldEdit } from './wheelGuard'

// vitest runs in node: stand in for Element with a tiny tree that answers
// closest() the way a number box, its spin button and a plain div would.
class FakeElement {
  constructor(
    public selectorMatch: boolean,
    public parent: FakeElement | null = null,
  ) {}
  closest(): FakeElement | null {
    let n: FakeElement | null = this
    while (n && !n.selectorMatch) n = n.parent
    return n
  }
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).Element = FakeElement
})
afterEach(() => {
  delete (globalThis as Record<string, unknown>).Element
})

describe('wheelGuard', () => {
  const numberBox = new FakeElement(true)
  const spinButton = new FakeElement(false, numberBox)
  const panel = new FakeElement(false)
  const otherBox = new FakeElement(true)

  it('edits when the wheel is over the focused control or a child of it', () => {
    expect(wheelWouldEdit(numberBox as unknown as Element, numberBox as unknown as Element)).toBe(true)
    expect(wheelWouldEdit(spinButton as unknown as Element, numberBox as unknown as Element)).toBe(true)
  })

  it('does nothing over plain panel content or an unfocused control', () => {
    expect(wheelWouldEdit(panel as unknown as Element, numberBox as unknown as Element)).toBe(false)
    expect(wheelWouldEdit(otherBox as unknown as Element, numberBox as unknown as Element)).toBe(false)
    expect(wheelWouldEdit(numberBox as unknown as Element, null)).toBe(false)
    expect(wheelWouldEdit(null, numberBox as unknown as Element)).toBe(false)
  })
})
