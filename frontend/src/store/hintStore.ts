import { create } from 'zustand'
import { isHintId, StruggleTracker, type HintId, type Signal, type SignalContext } from '../lib/struggles'
import { useCircuitStore } from './circuitStore'
import { useResultsStore } from './resultsStore'

// The same per-browser preference slots uiStore uses, read here directly:
// uiStore paints the theme on import, which the store tests (node) cannot.
const PREFIX = 'opendss-designer.'
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value)
  } catch {
    // storage unavailable -- the change still applies for this session
  }
}
const readFlag = (key: string, fallback: boolean) => {
  const v = readPref(key)
  return v === null ? fallback : v === '1'
}

/**
 * Help hints: the card that appears when the editor notices someone is
 * stuck (lib/struggles decides when). Components report what the person
 * did through `signalStruggle`; this store owns the one tracker, the card
 * on screen, and the two things that persist per browser: whether hints
 * are on at all, and which ones are retired (dismissed or learned).
 */

const OFF_KEY = 'hintsOff'
const ENABLED_KEY = 'hintsEnabled'
/** How long a card stays up when nobody touches it. */
const SHOW_MS = 20_000

function readOff(): HintId[] {
  try {
    const v = JSON.parse(readPref(OFF_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter(isHintId) : []
  } catch {
    return []
  }
}

const tracker = new StruggleTracker(readOff())
let hideTimer: ReturnType<typeof setTimeout> | undefined

interface HintState {
  /** The hint on screen, if any. */
  active: HintId | null
  /** Hints show at all (Preferences). */
  enabled: boolean
  /** Hints that will not show again, for Preferences to count. */
  off: HintId[]
  setEnabled: (v: boolean) => void
  /** The card was closed: for good with "Got it", or just for now. */
  dismiss: (forever: boolean) => void
  /** Forget every dismissal and lesson: every hint can show again. */
  resetAll: () => void
}

export const useHintStore = create<HintState>()((set, get) => ({
  active: null,
  enabled: readFlag(ENABLED_KEY, true),
  off: tracker.retired(),
  setEnabled: (enabled) => {
    writePref(ENABLED_KEY, enabled ? '1' : '0')
    clearTimeout(hideTimer)
    set({ enabled, active: enabled ? get().active : null })
  },
  dismiss: (forever) => {
    const { active } = get()
    clearTimeout(hideTimer)
    if (!active) return
    tracker.hide(active, forever)
    persistOff()
    set({ active: null, off: tracker.retired() })
  },
  resetAll: () => {
    tracker.reset()
    persistOff()
    set({ off: [] })
  },
}))

function persistOff(): void {
  writePref(OFF_KEY, JSON.stringify(tracker.retired()))
}

/** Report something the person did. Cheap when hints are off or one is up. */
export function signalStruggle(kind: Signal, ctx?: SignalContext): void {
  const st = useHintStore.getState()
  if (!st.enabled) return
  const { show, learned } = tracker.signal(kind, ctx)
  if (learned.length) {
    persistOff()
    // The person just did the thing the card was teaching: it is done.
    if (st.active && learned.includes(st.active)) {
      clearTimeout(hideTimer)
      useHintStore.setState({ active: null, off: tracker.retired() })
    } else useHintStore.setState({ off: tracker.retired() })
  }
  if (!show || useHintStore.getState().active) return
  useHintStore.setState({ active: show })
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => useHintStore.getState().dismiss(false), SHOW_MS)
}

/** Counts a rule may ask about: elements (not annotations) and connections. */
export function circuitCounts(): SignalContext {
  const s = useCircuitStore.getState()
  let elements = 0
  for (const n of s.nodes) if (n.type !== 'note' && n.type !== 'zone') elements++
  return { elements, connections: s.edges.length }
}

// Regret is read off the circuit itself: an element dropped while placement
// was on and gone again within seconds, or a connection drawn and at once
// deleted. Both are the clicks of someone who meant something else. Only a
// change of exactly one is looked at, so loading a circuit costs nothing.
const REGRET_MS = 8_000
let placed: { id: string; at: number } | null = null
let drawn: { id: string; at: number } | null = null

useCircuitStore.subscribe((s, prev) => {
  if (!useHintStore.getState().enabled) return
  const now = Date.now()
  if (s.nodes !== prev.nodes) {
    const d = s.nodes.length - prev.nodes.length
    if (d === 1 && s.placementType) {
      placed = { id: s.nodes[s.nodes.length - 1].id, at: now }
      signalStruggle('placed')
    } else if (d === -1 && placed && now - placed.at < REGRET_MS) {
      const id = placed.id
      placed = null
      if (!s.nodes.some((n) => n.id === id)) signalStruggle('placement-regret')
    } else if (Math.abs(d) > 1) {
      placed = null
      drawn = null
      signalStruggle('circuit-reset')
    }
  }
  if (s.edges !== prev.edges) {
    const d = s.edges.length - prev.edges.length
    if (d === 1) {
      drawn = { id: s.edges[s.edges.length - 1].id, at: now }
      signalStruggle('connected', circuitCounts())
    } else if (d === -1 && drawn && now - drawn.at < REGRET_MS) {
      const id = drawn.id
      drawn = null
      if (!s.edges.some((e) => e.id === id)) signalStruggle('connection-regret')
    }
  }
})

// A fresh solve answers both the "Solve is blocked" and "results are stale"
// hints, whichever way it was started.
useResultsStore.subscribe((s, prev) => {
  if (s.result && s.result !== prev.result) signalStruggle('solved')
})
