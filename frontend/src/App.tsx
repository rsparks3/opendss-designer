import { useUiStore } from './store/uiStore'
import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import { api } from './lib/api'
import { hasElements } from './lib/defaults'
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
import { SidePanel } from './components/SidePanel'
import { Toolbar } from './components/Toolbar'
import { MenuBar } from './components/MenuBar'
import { Dialogs } from './components/Dialogs'
import { GeoCanvas } from './components/GeoCanvas'

/** A number that changes when the circuit changes electrically: an element
 *  added, removed, re-wired or given new parameters. Moving or selecting
 *  something does not change it -- and on a 10,000-element feeder every
 *  click used to post the whole 5 MB circuit for validation. The check is a
 *  reference comparison per element: the store replaces an element's `data`
 *  whenever its parameters change, and keeps it when only the position or
 *  selection does. */
function useElectricalRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let lastNodes: unknown[] = []
    let lastEdges: unknown[] = []
    const changed = (s: ReturnType<typeof useCircuitStore.getState>) => {
      const { nodes, edges } = s
      if (nodes.length !== lastNodes.length / 3 || edges.length !== lastEdges.length / 6) return true
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        if (lastNodes[3 * i] !== n.id || lastNodes[3 * i + 1] !== n.data || lastNodes[3 * i + 2] !== n.width) return true
      }
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i]
        const k = 6 * i
        if (lastEdges[k] !== e.id || lastEdges[k + 1] !== e.data?.params || lastEdges[k + 2] !== e.source ||
          lastEdges[k + 3] !== e.target || lastEdges[k + 4] !== e.sourceHandle || lastEdges[k + 5] !== e.targetHandle) return true
      }
      return false
    }
    const remember = (s: ReturnType<typeof useCircuitStore.getState>) => {
      lastNodes = s.nodes.flatMap((n) => [n.id, n.data, n.width])
      lastEdges = s.edges.flatMap((e) => [e.id, e.data?.params, e.source, e.target, e.sourceHandle, e.targetHandle])
    }
    const check = (s: ReturnType<typeof useCircuitStore.getState>) => {
      if (!changed(s)) return
      remember(s)
      setRevision((r) => r + 1)
    }
    check(useCircuitStore.getState())
    return useCircuitStore.subscribe((s, prev) => {
      if (s.nodes !== prev.nodes || s.edges !== prev.edges) check(s)
    })
  }, [])
  return revision
}

/** Re-validate the circuit (debounced) whenever it changes electrically. */
function useValidation() {
  const revision = useElectricalRevision()
  // Limits change what a solve flags, so they re-run it like an edit does.
  const limits = useCircuitStore((s) => s.limits)
  const setIssues = useResultsStore((s) => s.setIssues)
  const setPhases = useResultsStore((s) => s.setPhases)
  const timer = useRef<number>(undefined)

  useEffect(() => {
    window.clearTimeout(timer.current)
    if (!hasElements(useCircuitStore.getState().nodes)) {
      setIssues([])
      setPhases(null)
      return
    }
    timer.current = window.setTimeout(async () => {
      try {
        const { issues, phases } = await api.validate(toCircuitJSON(useCircuitStore.getState()))
        setIssues(issues)
        setPhases(phases ?? null)
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
  }, [revision, limits, setIssues, setPhases])
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
        const slices = [s.nodes, s.edges, s.busNames, s.loadShapes, s.name, s.limits, s.study]
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
  const view = useUiStore((s) => s.view)
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
        <MenuBar />
        <Toolbar />
        <TimeBar />
        <div className="main-row">
          {/* storageKey bumped with the icon-collapse change: a width saved
              against the old 170px default now reads as "icons only", which
              is not what anyone who dragged it there asked for. */}
          <SidePanel side="left" storageKey="palette2" defaultWidth={210} minWidth={72} maxWidth={360} title="components">
            <Palette />
          </SidePanel>
          {view === 'geographic' ? <GeoCanvas /> : <EditorCanvas />}
          <SidePanel side="right" storageKey="properties" defaultWidth={250} minWidth={180} maxWidth={560} title="properties">
            <PropertiesPanel />
          </SidePanel>
        </div>
        <BottomPanel />
        <Dialogs />
      </div>
    </ReactFlowProvider>
  )
}
