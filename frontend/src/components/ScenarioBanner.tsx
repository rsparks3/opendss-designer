import { isPreview } from '../lib/scenarios'
import { useCircuitStore } from '../store/circuitStore'

/** Across the top of the drawing while a scenario is open: every edit
 *  belongs to it, and the way back is one click. A preview (a study row
 *  shown on the drawing) says it is temporary and offers to keep it. */
export function ScenarioBanner() {
  const active = useCircuitStore((s) => s.activeScenario)
  const name = useCircuitStore((s) => s.scenarios.find((sc) => sc.id === s.activeScenario)?.name)
  const activate = useCircuitStore((s) => s.activateScenario)
  const keep = useCircuitStore((s) => s.keepPreview)
  if (!active) return null
  if (isPreview(active)) {
    return (
      <div className="scenario-banner preview" role="status">
        Previewing <b>{name ?? 'a study case'}</b> — not saved; edits made here are discarded when you return.
        <button type="button" onClick={() => keep()}>Save as scenario</button>
        <button type="button" onClick={() => activate(null)}>Return to base case</button>
      </div>
    )
  }
  return (
    <div className="scenario-banner" role="status">
      Editing scenario <b>{name ?? active}</b> — changes on the drawing belong to it
      (dashed outline: changed or added here).
      <button type="button" onClick={() => activate(null)}>Return to base case</button>
    </div>
  )
}
