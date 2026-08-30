import type { CircuitJSON, Issue, SolveResult } from '../types/circuit'

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export const api = {
  solve: (circuit: CircuitJSON) => post<SolveResult>('/api/solve', circuit),

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

  importDss: (text: string) =>
    post<{ circuit: CircuitJSON; unsupported: string[] }>('/api/import/dss', { text }),
}
