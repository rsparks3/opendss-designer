import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useRef } from 'react'
import { api } from './lib/api'
import { loadLineCodes } from './lib/lineCodes'
import { runSolve } from './lib/solve'
import { toCircuitJSON, useCircuitStore } from './store/circuitStore'
import { loadDoc, saveDoc } from './lib/localStore'
import { migrateCircuit } from './lib/schema'
import { useResultsStore } from './store/resultsStore'
import { BottomPanel } from './components/BottomPanel'
import { DemoBanner } from './components/DemoBanner'
import { EditorCanvas } from './components/EditorCanvas'
import { Palette } from './components/Palette'
import { PropertiesPanel } from './components/PropertiesPanel'
import { TimeBar } from './components/TimeBar'
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
        // settles and has no errors, re-run the power flow. Suppressed in
        // time-series mode, where snapshot runs are disabled.
        const rs = useResultsStore.getState()
        if (
          rs.autoSolve &&
          rs.analysisMode !== 'timeseries' &&
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

const AUTOSAVE_KEY = 'autosave'

/** Warn before leaving with unsaved changes, and continuously autosave the
 *  circuit to browser storage so an accidental refresh restores it. */
function useUnsavedWorkProtection() {
  // Restore an autosaved circuit once, on first mount of an empty editor.
  useEffect(() => {
    void (async () => {
      const s = useCircuitStore.getState()
      if (s.nodes.length > 0) return
      try {
        const saved = await loadDoc<unknown>(AUTOSAVE_KEY)
        if (!saved) return
        const { circuit, warning } = migrateCircuit(saved)
        if (!circuit.nodes?.length) return
        s.loadCircuit(circuit)
        // Restored work still isn't in a project file.
        useCircuitStore.setState({ dirty: true })
        useResultsStore.getState().setFlash(
          warning ??
            `Restored unsaved work ("${circuit.name}") from your last session`,
          'info')
      } catch {
        // corrupt autosave — ignore it
      }
    })()
  }, [])

  // Debounced autosave on every circuit change.
  useEffect(() => {
    let timer: number | undefined
    // The document slices as of the last write. The subscription fires on
    // every store change including selection and placement mode, so without
    // this the whole document (loadshape point arrays included) is
    // re-serialized on every click.
    let last: unknown[] = []
    const unsub = useCircuitStore.subscribe((s) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const slices = [s.nodes, s.edges, s.busNames, s.loadShapes, s.name]
        if (slices.every((v, i) => v === last[i])) return
        // Never overwrite the recovery copy with an empty document. `New`,
        // `Open` and `Import` all clear the store, and the debounce used to
        // then write that empty circuit over the previous session's only
        // copy — destroying exactly the work this hook exists to protect.
        if (s.nodes.length === 0) return
        last = slices
        void saveDoc(AUTOSAVE_KEY, toCircuitJSON(s))
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
        <DemoBanner />
        <Toolbar />
        <TimeBar />
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
