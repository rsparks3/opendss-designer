/**
 * Every keyboard binding, in one table: the menus print their hints from it
 * and Help → Keyboard shortcuts lists it. The key handlers themselves live
 * with what they drive (EditorCanvas for the drawing, useMenuShortcuts for
 * the menu commands); `shortcuts.test.ts` keeps the table and the handlers
 * from drifting apart where it can.
 */

export interface Shortcut {
  keys: string
  action: string
}

export interface ShortcutGroup {
  title: string
  items: Shortcut[]
}

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/** Spell a binding for this platform: "Mod+S" becomes "Ctrl+S" or "⌘+S". */
export const keyLabel = (keys: string) => keys.replace(/Mod/g, mod)

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'File',
    items: [
      { keys: 'Mod+O', action: 'Open from this browser' },
      { keys: 'Mod+Shift+O', action: 'Open a project file' },
      { keys: 'Mod+S', action: 'Save to this browser' },
      { keys: 'Mod+Shift+S', action: 'Save as' },
      { keys: 'Mod+Alt+S', action: 'Save to file' },
    ],
  },
  {
    title: 'Edit',
    items: [
      { keys: 'Mod+Z', action: 'Undo' },
      { keys: 'Mod+Y', action: 'Redo (also Mod+Shift+Z)' },
      { keys: 'Mod+X', action: 'Cut' },
      { keys: 'Mod+C', action: 'Copy' },
      { keys: 'Mod+V', action: 'Paste' },
      { keys: 'Mod+D', action: 'Duplicate' },
      { keys: 'Delete', action: 'Delete the selection (also Backspace)' },
      { keys: 'Mod+A', action: 'Select everything' },
      { keys: 'Mod+Shift+A', action: 'Select nothing' },
      { keys: 'Mod+F', action: 'Find an element by name' },
    ],
  },
  {
    title: 'View',
    items: [
      { keys: 'Mod+=', action: 'Zoom in' },
      { keys: 'Mod+-', action: 'Zoom out' },
      { keys: 'Mod+Shift+H', action: 'Fit the whole circuit' },
    ],
  },
  {
    title: 'Arrange',
    items: [
      { keys: 'R', action: 'Rotate the selection 90°' },
      { keys: 'Shift+H', action: 'Flip the selection left to right' },
      { keys: 'Shift+V', action: 'Flip the selection upside down' },
      { keys: 'Mod+Shift+L', action: 'Clean up the layout' },
    ],
  },
  {
    title: 'Analysis',
    items: [{ keys: 'F5', action: 'Solve' }],
  },
  {
    title: 'Drawing',
    items: [
      { keys: 'S', action: 'Place a source' },
      { keys: 'B', action: 'Place a busbar (drag to size)' },
      { keys: 'T', action: 'Place a transformer' },
      { keys: 'V', action: 'Place a regulator' },
      { keys: 'K', action: 'Place a breaker' },
      { keys: 'F', action: 'Place a fuse' },
      { keys: 'O', action: 'Place a recloser' },
      { keys: 'Y', action: 'Place a relay' },
      { keys: 'L', action: 'Place a load' },
      { keys: 'C', action: 'Place a capacitor' },
      { keys: 'G', action: 'Place a generator' },
      { keys: 'P', action: 'Place a PV system' },
      { keys: 'A', action: 'Place storage' },
      { keys: 'W', action: 'Connect with wires' },
      { keys: 'E', action: 'Connect with lines' },
      { keys: 'Esc', action: 'Stop placing / close a menu' },
      { keys: 'Alt+drag', action: 'Draw a new wire from an occupied terminal' },
      { keys: 'Double-click', action: 'Add a routing point to a wire or line' },
    ],
  },
  {
    title: 'Help',
    items: [{ keys: '?', action: 'This list' }],
  },
]
