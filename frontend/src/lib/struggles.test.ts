import { describe, expect, it } from 'vitest'
import { COOLDOWN_MS, HINT_IDS, HINTS, MAX_SHOWS, RULES, StruggleTracker, type HintId } from './struggles'

/** A tracker on a clock the test advances. */
function tracker(off: HintId[] = []) {
  let t = 0
  const tr = new StruggleTracker(off, () => t)
  return { tr, tick: (ms: number) => (t += ms) }
}

describe('struggle catalogue', () => {
  it('has a rule for every hint and a hint for every rule', () => {
    const ruled = new Set(RULES.map((r) => r.hint))
    for (const id of HINT_IDS) expect(ruled.has(id), id).toBe(true)
    for (const r of RULES) expect(HINT_IDS.includes(r.hint), r.hint).toBe(true)
  })

  it('says something actionable in every hint', () => {
    for (const h of HINTS) {
      expect(h.title.length).toBeGreaterThan(5)
      expect(h.body.length).toBeGreaterThan(40)
      expect(h.body.length).toBeLessThan(260)
    }
  })
})

describe('StruggleTracker', () => {
  it('fires the pan hint on the third selection box inside the window', () => {
    const { tr, tick } = tracker()
    expect(tr.signal('marquee').show).toBeNull()
    tick(1000)
    expect(tr.signal('marquee').show).toBeNull()
    tick(1000)
    expect(tr.signal('marquee').show).toBe('pan')
  })

  it('forgets selection boxes older than the window', () => {
    const { tr, tick } = tracker()
    tr.signal('marquee')
    tick(31_000)
    tr.signal('marquee')
    tick(1000)
    expect(tr.signal('marquee').show).toBeNull()
    tick(1000)
    expect(tr.signal('marquee').show).toBe('pan')
  })

  it('retires the pan hint once the person pans, and reports it as learned', () => {
    const { tr } = tracker()
    tr.signal('marquee')
    tr.signal('marquee')
    expect(tr.signal('pan').learned).toEqual(['pan'])
    tr.signal('marquee')
    tr.signal('marquee')
    expect(tr.signal('marquee').show).toBeNull()
    expect(tr.retired()).toContain('pan')
  })

  it('a node drag after a selection box means the box was wanted', () => {
    const { tr } = tracker()
    tr.signal('marquee')
    tr.signal('marquee')
    tr.signal('node-drag')
    tr.signal('marquee')
    expect(tr.signal('marquee').show).toBeNull()
    expect(tr.signal('marquee').show).toBe('pan')
  })

  it('fires the palette hint at once, and never after a placement', () => {
    const { tr } = tracker()
    expect(tr.signal('palette-drag').show).toBe('palette-click')
    tr.hide('palette-click', false)
    tr.signal('placed')
    expect(tr.signal('palette-drag').show).toBeNull()
  })

  it('only offers the connection hint while nothing is connected', () => {
    const { tr } = tracker()
    const ctx = { elements: 3, connections: 0 }
    for (let i = 0; i < 3; i++) expect(tr.signal('node-drag', ctx).show).toBeNull()
    expect(tr.signal('node-drag', { elements: 3, connections: 1 }).show).toBeNull()
    expect(tr.signal('node-drag', ctx).show).toBe('connect-dots')
  })

  it('never shows a hint dismissed with "Got it"', () => {
    const { tr, tick } = tracker()
    expect(tr.signal('palette-drag').show).toBe('palette-click')
    tr.hide('palette-click', true)
    tick(COOLDOWN_MS + 1)
    expect(tr.signal('palette-drag').show).toBeNull()
  })

  it('waits out the cooldown before repeating a hint, then gives up after a few shows', () => {
    const { tr, tick } = tracker()
    for (let i = 0; i < MAX_SHOWS; i++) {
      expect(tr.signal('palette-drag').show).toBe('palette-click')
      tr.hide('palette-click', false)
      expect(tr.signal('palette-drag').show).toBeNull()
      tick(COOLDOWN_MS + 1)
    }
    expect(tr.signal('palette-drag').show).toBeNull()
    expect(tr.retired()).toContain('palette-click')
  })

  it('starts with the hints it is told are off', () => {
    const { tr } = tracker(['palette-click'])
    expect(tr.signal('palette-drag').show).toBeNull()
    tr.reset()
    expect(tr.signal('palette-drag').show).toBe('palette-click')
  })

  it('drops the properties hint once the panel has been opened', () => {
    const { tr } = tracker()
    expect(tr.signal('props-closed-dblclick').show).toBe('properties-panel')
    expect(tr.signal('props-opened').learned).toEqual(['properties-panel'])
    expect(tr.signal('props-closed-dblclick').show).toBeNull()
  })

  it('resets the lost-view count when something comes back into view', () => {
    const { tr } = tracker()
    tr.signal('empty-view')
    tr.signal('empty-view')
    tr.signal('view-ok')
    tr.signal('empty-view')
    tr.signal('empty-view')
    expect(tr.signal('empty-view').show).toBe('lost-view')
  })
})
