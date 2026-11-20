import { useCircuitStore } from '../store/circuitStore'

/** Across the top of the drawing while a scenario is open: every edit
 *  belongs to it, and the way back is one click. */
export function ScenarioBanner() {
  const active = useCircuitStore((s) => s.activeScenario)
  const name = useCircuitStore((s) => s.scenarios.find((sc) => sc.id === s.activeScenario)?.name)
  const activate = useCircuitStore((s) => s.activateScenario)
  if (!active) return null
  return (
    <div className="scenario-banner" role="status">
      Editing scenario <b>{name ?? active}</b> — changes on the drawing belong to it
      (dashed outline: changed or added here).
      <button type="button" onClick={() => activate(null)}>Return to base case</button>
    </div>
  )
}
