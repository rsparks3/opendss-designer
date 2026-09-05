import { useEffect, useState } from 'react'
import { api, type HealthInfo } from './api'

/**
 * One shared fetch of `/api/health` for every component that needs to know
 * what kind of instance this is (the banner, the toolbar corner). Best
 * effort: if health is unreachable the app still works, so a failure here
 * resolves to `null` and nothing renders.
 */
let cached: HealthInfo | null = null
let inflight: Promise<HealthInfo | null> | null = null
const listeners = new Set<(h: HealthInfo | null) => void>()

function load(): Promise<HealthInfo | null> {
  if (cached) return Promise.resolve(cached)
  if (!inflight) {
    inflight = api
      .health()
      .then((h) => {
        cached = h
        listeners.forEach((fn) => fn(h))
        return h
      })
      .catch(() => null)
  }
  return inflight
}

export function useInstanceHealth(): HealthInfo | null {
  const [health, setHealth] = useState<HealthInfo | null>(cached)
  useEffect(() => {
    if (cached) return
    listeners.add(setHealth)
    void load()
    return () => {
      listeners.delete(setHealth)
    }
  }, [])
  return health
}

/** Test seam: forget the cached answer. */
export function resetInstanceHealth(): void {
  cached = null
  inflight = null
}
