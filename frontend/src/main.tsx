import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App'
import { autoLayout } from './lib/layout'
import type { ReactFlowInstance } from '@xyflow/react'
import { redo, undo, useCircuitStore, type AppEdge, type AppNode } from './store/circuitStore'
import { useResultsStore } from './store/resultsStore'

// Scripting/debugging hook: drive the editor from the browser console.
declare global {
  interface Window {
    opendssDesigner: {
      circuit: typeof useCircuitStore
      results: typeof useResultsStore
      undo: typeof undo
      redo: typeof redo
      autoLayout: typeof autoLayout
      /** The canvas's React Flow instance (viewport, fitting), once drawn. */
      flow?: ReactFlowInstance<AppNode, AppEdge>
      /** The map (geographic view), while it is shown. */
      map?: { screenOf: (id: string) => { x: number; y: number } | null; fit: () => void }
    }
  }
}
window.opendssDesigner = { circuit: useCircuitStore, results: useResultsStore, undo, redo, autoLayout }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
