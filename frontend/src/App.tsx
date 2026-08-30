import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useRef } from 'react'
import { api } from './lib/api'
import { toCircuitJSON, useCircuitStore } from './store/circuitStore'
import { useResultsStore } from './store/resultsStore'
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
      } catch {
        // backend unreachable; leave existing issues alone
      }
    }, 400)
    return () => window.clearTimeout(timer.current)
  }, [nodes, edges, setIssues])
}

export default function App() {
  useValidation()
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
