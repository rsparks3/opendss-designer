import { create } from 'zustand'

/**
 * Editor chrome state that the menu bar, the toolbar and the panels all need
 * to reach: which dialog is up, which panels are showing, and the view
 * preferences. None of it is part of the circuit, so none of it is undoable
 * or saved with a project; the preferences persist per browser.
 */

export type Dialog = 'saveAs' | 'library' | 'shortcuts' | 'about' | 'find' | 'prefs' | null

/** Panels the View menu can show and hide. Keys match SidePanel storage keys. */
export type PanelKey = 'palette2' | 'properties' | 'bottom'

interface UiState {
  dialog: Dialog
  openDialog: (d: Dialog) => void
  closeDialog: () => void

  panelOpen: Record<PanelKey, boolean>
  setPanelOpen: (key: PanelKey, open: boolean) => void
  togglePanel: (key: PanelKey) => void

  showGrid: boolean
  snapToGrid: boolean
  setShowGrid: (v: boolean) => void
  setSnapToGrid: (v: boolean) => void
}

const PREFIX = 'opendss-designer.'

export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(PREFIX + key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value)
  } catch {
    // storage unavailable -- the change still applies for this session
  }
}

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

const openKey = (k: PanelKey) => `${k}Open`

export const useUiStore = create<UiState>()((set, get) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),

  panelOpen: {
    palette2: readFlag(openKey('palette2'), true),
    properties: readFlag(openKey('properties'), true),
    bottom: readFlag(openKey('bottom'), true),
  },
  setPanelOpen: (key, open) => {
    writePref(openKey(key), open ? '1' : '0')
    set({ panelOpen: { ...get().panelOpen, [key]: open } })
  },
  togglePanel: (key) => get().setPanelOpen(key, !get().panelOpen[key]),

  showGrid: readFlag('showGrid', true),
  snapToGrid: readFlag('snapToGrid', true),
  setShowGrid: (v) => {
    writePref('showGrid', v ? '1' : '0')
    set({ showGrid: v })
  },
  setSnapToGrid: (v) => {
    writePref('snapToGrid', v ? '1' : '0')
    set({ snapToGrid: v })
  },
}))
