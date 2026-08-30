import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './index.css'
import App from './App'
import { redo, undo, useCircuitStore } from './store/circuitStore'
import { useResultsStore } from './store/resultsStore'

// Scripting/debugging hook: drive the editor from the browser console.
declare global {
  interface Window {
    opendssDesigner: {
      circuit: typeof useCircuitStore
      results: typeof useResultsStore
      undo: typeof undo
      redo: typeof redo
    }
  }
}
window.opendssDesigner = { circuit: useCircuitStore, results: useResultsStore, undo, redo }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
