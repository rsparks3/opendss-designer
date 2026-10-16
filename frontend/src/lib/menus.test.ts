import { describe, expect, it } from 'vitest'
import { buildMenus, type MenuEntry } from './menus'
import { SHORTCUTS } from './shortcuts'
import { useResultsStore } from '../store/resultsStore'

const ops = { zoomIn: () => {}, zoomOut: () => {}, deleteSelection: () => {} }

function walk(entries: MenuEntry[], out: Extract<MenuEntry, { kind: 'item' }>[] = []) {
  for (const e of entries) {
    if (e.kind === 'item') out.push(e)
    else if (e.kind === 'sub') walk(e.items, out)
  }
  return out
}

describe('menus', () => {
  const menus = buildMenus(ops, [{ id: 's', name: 'Sample', description: '', nodes: 3 } as never])
  const items = menus.flatMap((m) => walk(m.items))

  it('are the six desktop-tool menus in order', () => {
    expect(menus.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Arrange', 'Analysis', 'Help'])
  })

  it('print only shortcuts that Help → Keyboard shortcuts lists', () => {
    const listed = new Set(SHORTCUTS.flatMap((g) => g.items.map((i) => i.keys)))
    for (const it of items) {
      if (it.keys) expect(listed, `${it.label} (${it.keys})`).toContain(it.keys)
    }
  })

  it('never bind one key to two items', () => {
    const keys = items.filter((i) => i.keys).map((i) => i.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('grey out what an empty drawing cannot do', () => {
    const byLabel = (l: string) => items.find((i) => i.label === l)
    expect(byLabel('Select all')?.disabled).toBe(true)
    expect(byLabel('Delete')?.disabled).toBe(true)
    expect(byLabel('Solve')?.disabled).toBe(true)
    expect(byLabel('Paste')?.disabled).toBeFalsy()
  })

  it('give every item a unique label within its menu', () => {
    const check = (entries: MenuEntry[]) => {
      const labels = entries.filter((e) => e.kind !== 'sep').map((e) => (e as { label: string }).label)
      expect(new Set(labels).size).toBe(labels.length)
      entries.forEach((e) => e.kind === 'sub' && check(e.items))
    }
    menus.forEach((m) => check(m.items))
  })

  it('list a withheld converter format but explain instead of opening a picker', () => {
    const fmt = { key: 'cyme', label: 'CYME', help: 'Network and equipment.', extensions: ['.txt'], maxFiles: 3 }
    const reason = 'CYME and Synergi import is part of the Pro plan.'
    const locked = buildMenus(ops, [], { available: true, formats: [fmt], locked: true, reason })
    const entry = walk(locked.flatMap((m) => m.items)).find((i) => i.label === 'CYME…')
    expect(entry?.hint).toBe('Locked')
    expect(entry?.title).toBe(reason)
    entry?.run()
    expect(useResultsStore.getState().flash).toBe(reason)

    const open = buildMenus(ops, [], { available: true, formats: [fmt] })
    const usable = walk(open.flatMap((m) => m.items)).find((i) => i.label === 'CYME…')
    expect(usable?.hint).toBeUndefined()
    expect(usable?.title).toBe(fmt.help)
  })
})
