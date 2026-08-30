import type { CircuitJSON, Issue, SolveResult } from '../types/circuit'

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

  importDss: (files: { name: string; text: string }[]) =>
    post<{ circuit: CircuitJSON; unsupported: string[]; warnings: string[] }>(
      '/api/import/dss', { files }),
}
