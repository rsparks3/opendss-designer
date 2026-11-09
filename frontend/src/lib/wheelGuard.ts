// Browsers turn the mouse wheel into a value change on a focused number box
// or dropdown, so scrolling a long panel (Shapes, properties, a study form)
// silently edits whichever control the pointer happens to pass over. The
// guard drops focus from such a control the moment a wheel event reaches it:
// the panel keeps scrolling and the value stays put. Focus moves back on the
// next click or Tab, so keyboard editing is unaffected.

const SPINNABLE = 'input[type="number"], select'

/** True when a wheel event over `target` would change `active`'s value. */
export function wheelWouldEdit(target: EventTarget | null, active: Element | null): boolean {
  if (!active || !(target instanceof Element)) return false
  const control = target.closest(SPINNABLE)
  return control !== null && control === active
}

/** Install the guard once on the document; returns an uninstaller. */
export function installWheelGuard(doc: Document = document): () => void {
  const onWheel = (e: WheelEvent) => {
    const active = doc.activeElement
    if (wheelWouldEdit(e.target, active)) (active as HTMLElement).blur()
  }
  // Capture + passive: runs before the control's own handling, never blocks scrolling.
  doc.addEventListener('wheel', onWheel, { capture: true, passive: true })
  return () => doc.removeEventListener('wheel', onWheel, { capture: true })
}
