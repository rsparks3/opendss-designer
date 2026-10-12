import { useUiStore } from '../store/uiStore'

/** One-line | Map, in the canvas's top-right corner where map applications
 *  keep it (and where it costs the toolbar nothing). */
export function ViewToggle() {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  return (
    <div className="view-toggle" role="group" aria-label="View">
      <button
        type="button"
        className={view === 'schematic' ? 'active' : ''}
        aria-pressed={view === 'schematic'}
        onClick={() => setView('schematic')}
        title="The one-line diagram"
      >
        One-line
      </button>
      <button
        type="button"
        className={view === 'geographic' ? 'active' : ''}
        aria-pressed={view === 'geographic'}
        onClick={() => setView('geographic')}
        title="The circuit on a map, at its coordinates"
      >
        Map
      </button>
    </div>
  )
}
