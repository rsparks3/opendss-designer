import { create } from 'zustand'
import type { Issue, SolveResult } from '../types/circuit'

export type OverlayMode = 'voltage' | 'loading' | 'power' | 'off'

interface ResultsState {
  result: SolveResult | null
  stale: boolean
  solving: boolean
  overlay: OverlayMode
  issues: Issue[]
  flash: string | null
  flashKind: 'error' | 'info'
  /** When on, a solve runs automatically after every circuit change. */
  autoSolve: boolean
  setAutoSolve: (b: boolean) => void

  setResult: (r: SolveResult) => void
  markStale: () => void
  setSolving: (b: boolean) => void
  setOverlay: (m: OverlayMode) => void
  setIssues: (issues: Issue[]) => void
  setFlash: (msg: string, kind?: 'error' | 'info') => void
}

let flashTimer: ReturnType<typeof setTimeout> | undefined

export const useResultsStore = create<ResultsState>((set) => ({
  result: null,
  stale: false,
  solving: false,
  overlay: 'voltage',
  issues: [],
  flash: null,
  flashKind: 'error',
  autoSolve: false,
  setAutoSolve: (autoSolve) => set({ autoSolve }),

  setResult: (result) => set({ result, stale: false }),
  markStale: () => set({ stale: true }),
  setSolving: (solving) => set({ solving }),
  setOverlay: (overlay) => set({ overlay }),
  setIssues: (issues) => set({ issues }),
  setFlash: (msg, kind = 'error') => {
    clearTimeout(flashTimer)
    set({ flash: msg, flashKind: kind })
    flashTimer = setTimeout(() => set({ flash: null }), 4000)
  },
}))

/** Bus result for a node (its first terminal), respecting staleness. */
export function busForNode(state: ResultsState, nodeId: string) {
  const r = state.result
  if (!r || !r.converged) return null
  const bus = r.nodeBuses[nodeId]?.[0]
  return bus ? { bus, data: r.buses[bus] } : null
}

export function elementForId(state: ResultsState, diagramId: string) {
  const r = state.result
  if (!r || !r.converged) return null
  for (const [name, el] of Object.entries(r.elements)) {
    if (el.id === diagramId) return { name, data: el }
  }
  return null
}
