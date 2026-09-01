import { useSyncExternalStore } from 'react'

// Alt is the escape hatch for the connection-grab gesture: while it is held,
// terminals go back to starting a brand-new connection (see nodes/common.tsx).
// The decision is made when React renders the handle, not when the mouse goes
// down, so the key state has to be observable.

let held = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (next === held) return
  held = next
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  if (!listeners.size) {
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    // Alt-tabbing away swallows the keyup, which would leave Alt stuck on.
    window.addEventListener('blur', onBlur)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }
}

const onKey = (e: KeyboardEvent) => set(e.altKey)
const onBlur = () => set(false)

const getSnapshot = () => held

/** True while the Alt key is down. */
export function useAltHeld(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
