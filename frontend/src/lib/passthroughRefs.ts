import type { PassthroughJSON } from '../types/circuit'

/**
 * Keeping passthrough elements pointed at the right things. An imported
 * monitor says `element=line.l1`; rename that line in the editor and the
 * monitor would be left pointing at nothing (the backend then leaves it out
 * of solves with a warning). So a rename rewrites the references too, and
 * moves the element's comments to its new name.
 */

/** The OpenDSS classes an editor element compiles to (core/compiler.py).
 *  A regulator is a transformer plus a regcontrol of the same name; the
 *  protective devices are a switch line plus their control. */
const DSS_CLASSES: Record<string, string[]> = {
  vsource: ['vsource'],
  transformer: ['transformer'],
  regulator: ['transformer', 'regcontrol'],
  load: ['load'],
  capacitor: ['capacitor'],
  generator: ['generator'],
  pvsystem: ['pvsystem'],
  storage: ['storage'],
  breaker: ['line'],
  fuse: ['line', 'fuse'],
  recloser: ['line', 'recloser'],
  relay: ['line', 'relay'],
  line: ['line'],
}

/** Controls that name their target without a class: `capacitor=c1` on a
 *  capcontrol, `transformer=t1` on a regcontrol. */
const BARE_KEYS: Record<string, string> = { capacitor: 'capacitor', transformer: 'transformer' }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// What may follow a name: a node suffix, space, a closing bracket or quote.
const END = `(?=[.\\s\\]"',)]|$)`

export function renameInText(text: string, type: string, oldName: string, newName: string): string {
  if (!oldName || oldName === newName) return text
  const o = esc(oldName)
  if (type === 'busbar') {
    return text.replace(new RegExp(`(\\bbus[12]?\\s*=\\s*"?)${o}${END}`, 'gi'), `$1${newName}`)
  }
  let out = text
  for (const cls of DSS_CLASSES[type] ?? []) {
    out = out.replace(new RegExp(`\\b(${cls})\\.${o}${END}`, 'gi'), `$1.${newName}`)
    if (BARE_KEYS[cls]) {
      out = out.replace(new RegExp(`(\\b${BARE_KEYS[cls]}\\s*=\\s*"?)${o}${END}`, 'gi'), `$1${newName}`)
    }
  }
  return out
}

/** Every passthrough entry with the rename applied (the same array when
 *  nothing mentioned the old name). */
export function renameInPassthrough(
  entries: PassthroughJSON[],
  type: string,
  oldName: string,
  newName: string,
): PassthroughJSON[] {
  let changed = false
  const out = entries.map((e) => {
    const text = renameInText(e.text, type, oldName, newName)
    if (text === e.text) return e
    changed = true
    return { ...e, text }
  })
  return changed ? out : entries
}

/** Comments follow the element they sit above. */
export function renameComments(
  comments: Record<string, string>,
  type: string,
  oldName: string,
  newName: string,
): Record<string, string> {
  if (!oldName || oldName === newName) return comments
  let changed = false
  const out = { ...comments }
  for (const cls of DSS_CLASSES[type] ?? []) {
    const from = `${cls}.${oldName.toLowerCase()}`
    if (from in out) {
      out[`${cls}.${newName.toLowerCase()}`] = out[from]
      delete out[from]
      changed = true
    }
  }
  return changed ? out : comments
}

/** "Monitor.m1" from an entry's first line, for naming a hand-typed one. */
export function passthroughName(text: string): string | null {
  const m = /^\s*new\s+(?:object\s*=\s*)?"?([A-Za-z_]\w*\.[^\s"=]+)/i.exec(text)
  return m ? m[1] : null
}
