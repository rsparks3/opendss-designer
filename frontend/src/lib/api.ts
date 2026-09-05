import type { CircuitJSON, FaultResult, Issue, SolveResult } from '../types/circuit'

export interface NrelMeta {
  products: Record<string, { label: string; zones: string[]; buildingTypes: string[] }>
}

export interface NrelFetchRequest {
  product: 'resstock' | 'comstock'
  climateZone: string
  buildingType: string
  stepMin: 60 | 15
  normalize: 'peak' | 'average'
}

export interface NrelProfile {
  name: string
  intervalMin: number
  points: number[]
  source: string
  stats: { peakKw: number; avgKw: number; annualKwh: number; points: number }
}

export interface GeocodeHit {
  name: string
  region: string
  lat: number
  lon: number
}

export interface IrradianceFetchRequest {
  lat: number
  lon: number
  apiKey: string
  email: string
  scaling: 'kwm2' | 'peak'
  label?: string
}

export interface IrradianceProfile {
  name: string
  kind: 'irradiance'
  intervalMin: number
  points: number[]
  source: string
  stats: {
    peakWm2: number
    annualKwhM2: number
    resolvedLat: number
    resolvedLon: number
    points: number
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    let detail = text
    try {
      detail = JSON.parse(text).detail ?? text
    } catch {
      // not JSON — use raw text
    }
    throw new Error(detail || `${url} failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text()
    let detail = text
    try {
      detail = JSON.parse(text).detail ?? text
    } catch {
      // not JSON — use raw text
    }
    throw new Error(detail || `${url} failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

export interface SampleMeta {
  id: string
  name: string
  description: string
  nodes: number
  edges: number
}

export interface PlanInfo {
  name: string
  message?: string | null
  links?: { label: string; url: string }[]
}

export interface HealthInfo {
  version: string
  opendssVersion: string
  mode: 'local' | 'demo'
  limits?: {
    maxNodes: number | null
    maxEdges: number | null
    maxShapes: number | null
    maxShapePoints: number | null
    maxBodyBytes: number | null
    maxTimeseriesCost?: number | null
  }
  /** Present only behind a gateway that describes the caller's plan. */
  plan?: PlanInfo
  idleSeconds?: number
}

export const api = {
  health: () => get<HealthInfo>('/api/health'),

  samples: () => get<{ samples: SampleMeta[] }>('/api/samples'),

  sample: (id: string) => get<CircuitJSON>(`/api/samples/${encodeURIComponent(id)}`),

  solve: (circuit: CircuitJSON) => post<SolveResult>('/api/solve', circuit),

  faultStudy: (circuit: CircuitJSON) => post<FaultResult>('/api/faultstudy', circuit),

  validate: (circuit: CircuitJSON) =>
    post<{ issues: Issue[] }>('/api/validate', circuit),

  exportDss: async (circuit: CircuitJSON): Promise<string> => {
    const res = await fetch('/api/export/dss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(circuit),
    })
    if (!res.ok) throw new Error(`export failed: ${res.status}`)
    return res.text()
  },

  importDss: (files: { name: string; text: string }[]) =>
    post<{ circuit: CircuitJSON; unsupported: string[]; warnings: string[] }>(
      '/api/import/dss', { files }),

  nrelMeta: async (): Promise<NrelMeta> => {
    const res = await fetch('/api/nrel/meta')
    if (!res.ok) throw new Error(`nrel/meta failed: ${res.status}`)
    return res.json()
  },

  nrelFetch: (req: NrelFetchRequest) => post<NrelProfile>('/api/nrel/fetch', req),

  irradianceGeocode: async (q: string): Promise<GeocodeHit[]> => {
    const res = await fetch(`/api/irradiance/geocode?q=${encodeURIComponent(q)}`)
    if (!res.ok) throw new Error(`geocode failed: ${res.status}`)
    return (await res.json()).results
  },

  irradianceFetch: (req: IrradianceFetchRequest) =>
    post<IrradianceProfile>('/api/irradiance/fetch', req),
}
