/**
 * Struggle detection: the editor notices when someone keeps doing something
 * that is not getting them anywhere -- drawing selection boxes when they
 * mean to pan, dragging palette items onto the drawing, dropping wires on
 * nothing -- and offers the one thing they need to know, once.
 *
 * This module is the pure part: the catalogue of hints, the rules that fire
 * them, and the tracker that counts signals against those rules. Nothing
 * here touches the DOM or a store; components report signals through
 * `store/hintStore`, which owns the tracker and the card on screen.
 *
 * A rule fires when its signal arrives `threshold` times inside `windowMs`.
 * Its `resetOn` signals wipe the count (the person did something that shows
 * the hint is not needed right now); its `learnOn` signals retire the hint
 * for good (they used the very thing it teaches). A hint retires too when
 * it is dismissed with "Got it", and after it has been shown a few times.
 */

export type HintId =
  | 'pan'
  | 'palette-click'
  | 'sticky-placement'
  | 'connect-dots'
  | 'drop-on-dot'
  | 'alt-wire'
  | 'solve-errors'
  | 'stale-results'
  | 'lost-view'
  | 'properties-panel'
  | 'wire-vs-line'

export type Signal =
  /** A left-drag on the empty pane ended: a selection box was drawn. */
  | 'marquee'
  /** The view was panned by a right or middle drag, or Space and drag. */
  | 'pan'
  /** A palette item was pressed and dragged off the palette. */
  | 'palette-drag'
  /** An element was placed by clicking the drawing. */
  | 'placed'
  /** An element placed in sticky placement mode was removed within seconds. */
  | 'placement-regret'
  /** Escape ended a placement mode. */
  | 'placement-escaped'
  /** A node was moved (dragged). */
  | 'node-drag'
  /** A connection was drawn between two elements. */
  | 'connected'
  /** A connection drag ended on nothing. */
  | 'drop-missed'
  /** An existing wire's end was picked up and put back where it was. */
  | 'grab-abandoned'
  /** Alt-drag started a second wire from an occupied dot. */
  | 'alt-wire'
  /** Solve was asked for while the Problems list has errors. */
  | 'solve-blocked'
  /** A solve completed. */
  | 'solved'
  /** An overlay button was pressed while results were stale. */
  | 'overlay-stale'
  /** The viewport settled with no element in view. */
  | 'empty-view'
  /** The viewport settled with elements in view. */
  | 'view-ok'
  /** A node was double-clicked while the properties panel was collapsed. */
  | 'props-closed-dblclick'
  /** The properties panel was opened. */
  | 'props-opened'
  /** A connection was deleted within seconds of being drawn. */
  | 'connection-regret'
  /** A circuit was cleared, loaded or replaced. */
  | 'circuit-reset'

/** Facts a rule may ask about when its signal arrives. */
export interface SignalContext {
  /** Elements on the drawing (notes and zones excluded). */
  elements?: number
  /** Connections on the drawing. */
  connections?: number
}

export interface HintDef {
  id: HintId
  title: string
  body: string
}

/** What to say, in the order the rules are checked. */
export const HINTS: readonly HintDef[] = [
  {
    id: 'pan',
    title: 'Looking to move around?',
    body:
      'Drag with the right or middle mouse button to pan, or hold Space and drag. ' +
      'Scroll to zoom. Dragging with the left button draws a selection box.',
  },
  {
    id: 'palette-click',
    title: 'Click, then click',
    body:
      'Click a palette item, then click on the drawing where it goes; nothing needs dragging. ' +
      'Placement stays on, so keep clicking to drop several. Esc stops.',
  },
  {
    id: 'sticky-placement',
    title: 'Still placing',
    body:
      'Placement stays on until you press Esc or click the palette item again, ' +
      'so every click on the drawing drops another one.',
  },
  {
    id: 'connect-dots',
    title: 'Connecting elements',
    body:
      'Hover an element to show its connection dots, then drag from a dot to a dot on ' +
      'another element. W makes the next connection a wire, E an OpenDSS line.',
  },
  {
    id: 'drop-on-dot',
    title: 'Drop on a dot',
    body:
      "A connection has to end on another element's dot. The dots appear as you hover the " +
      'element, and the end snaps on from about 30 px away.',
  },
  {
    id: 'alt-wire',
    title: 'That dot already has a wire',
    body:
      'Dragging a dot that holds a wire moves the wire. To draw a second wire from the ' +
      'same dot, hold Alt while you drag.',
  },
  {
    id: 'solve-errors',
    title: 'Solve is waiting on errors',
    body:
      'The Problems tab in the bottom panel lists them; click one to jump to the element. ' +
      'Solve turns back on as soon as the errors are gone.',
  },
  {
    id: 'stale-results',
    title: 'Results are out of date',
    body:
      'The overlay shows the last solve, from before your edits. Press Solve (F5) to ' +
      'refresh, or turn on Auto to re-solve after every change.',
  },
  {
    id: 'lost-view',
    title: 'Nothing in view',
    body:
      'The circuit is off screen. View → Fit (Ctrl+Shift+H), or the fit button in the ' +
      'bottom-left corner, brings all of it back.',
  },
  {
    id: 'properties-panel',
    title: 'Properties are in the right panel',
    body:
      'That panel is collapsed. Click the chevron on the right edge, or View → Properties, ' +
      'to edit the selected element.',
  },
  {
    id: 'wire-vs-line',
    title: 'Wire or line?',
    body:
      'W makes new connections ideal wires: the two ends become one bus. E makes them ' +
      'OpenDSS lines with impedance and length. Choose before you draw; a drawn connection ' +
      'keeps its kind.',
  },
]

export const HINT_BY_ID: Readonly<Record<HintId, HintDef>> = Object.fromEntries(
  HINTS.map((h) => [h.id, h]),
) as Record<HintId, HintDef>

export const HINT_IDS: readonly HintId[] = HINTS.map((h) => h.id)

export const isHintId = (v: unknown): v is HintId => HINT_IDS.includes(v as HintId)

interface Rule {
  hint: HintId
  on: Signal
  /** Signals inside the window needed to fire. */
  threshold: number
  /** How far back signals count, in ms; 0 means only the latest one counts. */
  windowMs: number
  resetOn?: readonly Signal[]
  learnOn?: readonly Signal[]
  when?: (ctx: SignalContext) => boolean
}

const S = 1000

export const RULES: readonly Rule[] = [
  // Three selection boxes in half a minute with no pan in between: the
  // person is trying to drag the view. The first pan retires the hint.
  { hint: 'pan', on: 'marquee', threshold: 3, windowMs: 30 * S, resetOn: ['node-drag'], learnOn: ['pan'] },
  // Dragging a palette item off the palette is unambiguous on its own.
  { hint: 'palette-click', on: 'palette-drag', threshold: 1, windowMs: 0, learnOn: ['placed'] },
  // Placing something and at once removing it, twice: the clicks that
  // dropped them were meant to select or pan. Using Esc shows they know.
  { hint: 'sticky-placement', on: 'placement-regret', threshold: 2, windowMs: 30 * S, learnOn: ['placement-escaped'] },
  // Several elements, none connected, and the person keeps shuffling them.
  {
    hint: 'connect-dots',
    on: 'node-drag',
    threshold: 4,
    windowMs: 120 * S,
    learnOn: ['connected'],
    resetOn: ['circuit-reset'],
    when: (c) => (c.elements ?? 0) >= 2 && (c.connections ?? 0) === 0,
  },
  { hint: 'drop-on-dot', on: 'drop-missed', threshold: 2, windowMs: 30 * S, resetOn: ['connected'] },
  { hint: 'alt-wire', on: 'grab-abandoned', threshold: 2, windowMs: 30 * S, learnOn: ['alt-wire'] },
  { hint: 'solve-errors', on: 'solve-blocked', threshold: 2, windowMs: 20 * S, resetOn: ['solved'] },
  { hint: 'stale-results', on: 'overlay-stale', threshold: 2, windowMs: 20 * S, resetOn: ['solved'] },
  { hint: 'lost-view', on: 'empty-view', threshold: 3, windowMs: 20 * S, resetOn: ['view-ok', 'circuit-reset'] },
  { hint: 'properties-panel', on: 'props-closed-dblclick', threshold: 1, windowMs: 0, learnOn: ['props-opened'] },
  { hint: 'wire-vs-line', on: 'connection-regret', threshold: 2, windowMs: 30 * S },
]

/** Shows of one hint before it is treated as dismissed. */
export const MAX_SHOWS = 3
/** Quiet time after a hint hides before the same hint may fire again. */
export const COOLDOWN_MS = 90 * S

export interface SignalOutcome {
  /** A hint to show now, if a rule fired. */
  show: HintId | null
  /** Hints retired by this signal, to hide if one is up. */
  learned: HintId[]
}

export class StruggleTracker {
  private readonly now: () => number
  /** Hints that are never shown again, whether dismissed or learned. */
  private readonly off: Set<HintId>
  private readonly hits = new Map<HintId, number[]>()
  private readonly shows = new Map<HintId, number>()
  private readonly hiddenAt = new Map<HintId, number>()

  constructor(off: Iterable<HintId> = [], now: () => number = Date.now) {
    this.off = new Set(off)
    this.now = now
  }

  /** Report something the person did; learn what to show, if anything. */
  signal(kind: Signal, ctx: SignalContext = {}): SignalOutcome {
    const t = this.now()
    const learned: HintId[] = []
    let show: HintId | null = null
    for (const rule of RULES) {
      if (rule.learnOn?.includes(kind) && !this.off.has(rule.hint)) {
        this.off.add(rule.hint)
        this.hits.delete(rule.hint)
        learned.push(rule.hint)
        continue
      }
      if (rule.resetOn?.includes(kind)) this.hits.delete(rule.hint)
      if (rule.on !== kind || this.off.has(rule.hint)) continue
      if (rule.when && !rule.when(ctx)) continue
      const recent = (this.hits.get(rule.hint) ?? []).filter((at) => t - at <= rule.windowMs)
      recent.push(t)
      if (recent.length < rule.threshold) {
        this.hits.set(rule.hint, recent)
        continue
      }
      this.hits.delete(rule.hint)
      const hidden = this.hiddenAt.get(rule.hint)
      if (hidden !== undefined && t - hidden < COOLDOWN_MS) continue
      if (show === null) show = rule.hint
    }
    if (show) this.shows.set(show, (this.shows.get(show) ?? 0) + 1)
    return { show, learned }
  }

  /** The hint left the screen: for good ("Got it"), or for now. */
  hide(id: HintId, forever: boolean): void {
    this.hiddenAt.set(id, this.now())
    if (forever || (this.shows.get(id) ?? 0) >= MAX_SHOWS) this.off.add(id)
  }

  /** Hints that will not be shown again. */
  retired(): HintId[] {
    return HINT_IDS.filter((id) => this.off.has(id))
  }

  /** Forget every dismissal and lesson. */
  reset(): void {
    this.off.clear()
    this.hits.clear()
    this.shows.clear()
    this.hiddenAt.clear()
  }
}
