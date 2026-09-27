/**
 * Light and dark, and the colours the Phases overlay draws with.
 *
 * The colours themselves are CSS variables (index.css); this module only
 * decides which set is live, by putting data-theme on <html>, and lays any
 * phase colours the user picked over the defaults as inline variables, so
 * they win in either theme.
 */

export type ThemePref = 'light' | 'dark' | 'system'
export type Theme = 'light' | 'dark'

/** The phase colours a user can choose. Keys are the CSS variable names
 *  without the leading dashes. */
export const PHASE_KEYS = ['phase-a', 'phase-b', 'phase-c', 'phase-2'] as const
export type PhaseKey = (typeof PHASE_KEYS)[number]
export type PhasePalette = Partial<Record<PhaseKey, string>>

export const PHASE_KEY_LABELS: Record<PhaseKey, string> = {
  'phase-a': 'Phase A',
  'phase-b': 'Phase B',
  'phase-c': 'Phase C',
  'phase-2': 'Two-phase',
}

/** The defaults in index.css, repeated for the colour pickers (an
 *  <input type=color> needs a hex value to start from). */
export const DEFAULT_PHASES: Record<Theme, Record<PhaseKey, string>> = {
  light: { 'phase-a': '#c62828', 'phase-b': '#1565c0', 'phase-c': '#2e7d32', 'phase-2': '#6a1b9a' },
  dark: { 'phase-a': '#ef5350', 'phase-b': '#64b5f6', 'phase-c': '#66bb6a', 'phase-2': '#ce93d8' },
}

const media = () =>
  typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

export function resolveTheme(pref: ThemePref, systemDark = media()?.matches ?? false): Theme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

/** Put a theme on the page. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
}

/** Follow the operating system's light/dark switch while the preference is
 *  'system'. Returns the unsubscribe. */
export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  const m = media()
  if (!m) return () => {}
  const fn = (e: MediaQueryListEvent) => onChange(e.matches)
  m.addEventListener('change', fn)
  return () => m.removeEventListener('change', fn)
}

export function applyPhasePalette(palette: PhasePalette): void {
  if (typeof document === 'undefined') return
  const style = document.documentElement.style
  for (const key of PHASE_KEYS) {
    const v = palette[key]
    if (v && /^#[0-9a-f]{6}$/i.test(v)) style.setProperty(`--${key}`, v)
    else style.removeProperty(`--${key}`)
  }
}

/** A colour as the browser would paint it: "var(--phase-a)" becomes the hex
 *  or rgb it currently stands for. Anything that leaves the page -- an SVG
 *  file, a canvas -- needs the value, not the variable. */
export function resolveColor(color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color.trim())
  if (!m || typeof document === 'undefined') return color
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || color
}

/** Run something with the page drawn in the light theme -- image exports,
 *  which go on white paper whatever the screen shows -- and put the theme
 *  back afterwards. Waits two frames so the change is painted first. */
export async function inLightTheme<T>(fn: () => T | Promise<T>): Promise<T> {
  const root = typeof document !== 'undefined' ? document.documentElement : null
  const was = root?.dataset.theme
  if (!root || was !== 'dark') return fn()
  root.dataset.theme = 'light'
  try {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return await fn()
  } finally {
    root.dataset.theme = was
  }
}
