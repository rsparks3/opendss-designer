import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useRef } from 'react'
import { api } from './lib/api'
import { loadLineCodes } from './lib/lineCodes'
import { runSolve } from './lib/solve'
import { toCircuitJSON, useCircuitStore } from './store/circuitStore'
import { useResultsStore } from './store/resultsStore'
import type { CircuitJSON } from './types/circuit'
import { BottomPanel } from './components/BottomPanel'
import { EditorCanvas } from './components/EditorCanvas'
import { Palette } from './components/Palette'
import { PropertiesPanel } from './components/PropertiesPanel'
import { Toolbar } from './components/Toolbar'

/** Re-validate the circuit (debounced) whenever it changes. */
function useValidation() {
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const setIssues = useResultsStore((s) => s.setIssues)
  const timer = useRef<number>(undefined)

  useEffect(() => {
    window.clearTimeout(timer.current)
    if (nodes.length === 0) {
      setIssues([])
      return
    }
    timer.current = window.setTimeout(async () => {
      try {
        const { issues } = await api.validate(toCircuitJSON(useCircuitStore.getState()))
        setIssues(issues)
        // Auto-solve rides on the validation debounce: once the circuit
        // settles and has no errors, re-run the power flow.
        if (
          useResultsStore.getState().autoSolve &&
          !issues.some((i) => i.severity === 'error')
        ) {
          void runSolve()
        }
      } catch {
        // backend unreachable; leave existing issues alone
      }
    }, 400)
    return () => window.clearTimeout(timer.current)
  }, [nodes, edges, setIssues])
}

const AUTOSAVE_KEY = 'opendss-designer.autosave'

/** Warn before leaving with unsaved changes, and continuously autosave the
 *  circuit to browser storage so an accidental refresh restores it. */
function useUnsavedWorkProtection() {
  // Restore an autosaved circuit once, on first mount of an empty editor.
  useEffect(() => {
    const s = useCircuitStore.getState()
    if (s.nodes.length > 0) return
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as CircuitJSON
      if (!saved.nodes?.length) return
      s.loadCircuit(saved)
      // Restored work still isn't in a project file.
      useCircuitStore.setState({ dirty: true })
      useResultsStore.getState().setFlash(
        `Restored unsaved work ("${saved.name}") from your last session`, 'info')
    } catch {
      // corrupt autosave — ignore it
    }
  }, [])

  // Debounced autosave on every circuit change.
  useEffect(() => {
    let timer: number | undefined
    const unsub = useCircuitStore.subscribe((s) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        try {
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(toCircuitJSON(s)))
        } catch {
          // storage full/unavailable — the beforeunload warning still protects
        }
      }, 800)
    })
    return () => {
      window.clearTimeout(timer)
      unsub()
    }
  }, [])

  // Browser-native "leave site?" prompt while there are unsaved changes.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useCircuitStore.getState().dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
}

export default function App() {
  useValidation()
  useUnsavedWorkProtection()
  // Conductor preset library (config/linecodes.csv via the backend).
  useEffect(() => {
    void loadLineCodes()
  }, [])
  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
        <div className="main-row">
          <Palette />
          <EditorCanvas />
          <PropertiesPanel />
        </div>
        <BottomPanel />
      </div>
    </ReactFlowProvider>
  )
}
