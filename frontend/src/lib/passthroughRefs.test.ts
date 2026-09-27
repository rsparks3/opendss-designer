import { describe, expect, it } from 'vitest'
import { passthroughName, renameComments, renameInPassthrough, renameInText } from './passthroughRefs'

describe('renameInText', () => {
  it('rewrites a qualified reference, any case, and not a longer name', () => {
    const t = 'new energymeter.m1 element=Line.L1 terminal=1\nnew monitor.m2 element=line.l10'
    expect(renameInText(t, 'line', 'l1', 'trunk')).toBe(
      'new energymeter.m1 element=Line.trunk terminal=1\nnew monitor.m2 element=line.l10',
    )
  })

  it('follows a protective device as its switch line and its control', () => {
    const t = 'new monitor.m element=line.f1\nnew monitor.n element=fuse.f1'
    expect(renameInText(t, 'fuse', 'f1', 'f9')).toBe('new monitor.m element=line.f9\nnew monitor.n element=fuse.f9')
  })

  it('rewrites the bare names capcontrol and regcontrol use', () => {
    expect(renameInText('new capcontrol.cc element=line.l1 capacitor=C1 on=118', 'capacitor', 'c1', 'cap2')).toBe(
      'new capcontrol.cc element=line.l1 capacitor=cap2 on=118',
    )
  })

  it('renames a bus, keeping node suffixes', () => {
    expect(renameInText('new reactor.r bus1=b2.1.2.3 bus2=b20', 'busbar', 'b2', 'mid')).toBe(
      'new reactor.r bus1=mid.1.2.3 bus2=b20',
    )
  })
})

describe('renameInPassthrough and renameComments', () => {
  it('leave untouched collections as the same object', () => {
    const entries = [{ name: 'Monitor.m', text: 'new monitor.m element=line.x' }]
    expect(renameInPassthrough(entries, 'line', 'y', 'z')).toBe(entries)
    const comments = { 'line.x': '! note' }
    expect(renameComments(comments, 'line', 'y', 'z')).toBe(comments)
  })

  it('move a comment to the new name', () => {
    expect(renameComments({ 'line.l1': '! the trunk' }, 'line', 'L1', 'Trunk')).toEqual({ 'line.trunk': '! the trunk' })
  })
})

describe('passthroughName', () => {
  it('reads the class.name a New line defines', () => {
    expect(passthroughName('New Monitor.m1 element=line.l1')).toBe('Monitor.m1')
    expect(passthroughName('new object=reactor.r bus1=a')).toBe('reactor.r')
    expect(passthroughName('set mode=daily')).toBeNull()
  })
})
