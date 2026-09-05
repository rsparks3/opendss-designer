// The project library: named circuits saved in this browser.
//
// Two object stores in the app's IndexedDB database. `projects` holds small
// metadata rows (name, counts, timestamps) so the Open dialog can list a
// hundred circuits without touching a single load-shape array; `projectBodies`
// holds the CircuitJSON under the same key. Both are written in one
// transaction so a row never points at a missing body.
//
// What this deliberately is not: sync. The library is per browser, per
// device, per origin, and clearing site data deletes it. Export .json remains
// the way to move a circuit anywhere else.

import type { CircuitJSON } from '../types/circuit'
import { request, withTx } from './localStore'

export const PROJECTS = 'projects'
export const BODIES = 'projectBodies'

export interface ProjectMeta {
  id: string
  name: string
  nodes: number
  edges: number
  shapes: number
  savedAt: number
  createdAt: number
}

export function newProjectId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const rows = await withTx([PROJECTS], 'readonly', (tx) =>
    request<ProjectMeta[]>(tx.objectStore(PROJECTS).getAll()),
  )
  return rows.sort((a, b) => b.savedAt - a.savedAt)
}

export async function saveProject(
  id: string,
  name: string,
  circuit: CircuitJSON,
  now: number = Date.now(),
): Promise<ProjectMeta> {
  const body: CircuitJSON = { ...circuit, name }
  return withTx([PROJECTS, BODIES], 'readwrite', async (tx) => {
    const existing = await request<ProjectMeta | undefined>(tx.objectStore(PROJECTS).get(id))
    const meta: ProjectMeta = {
      id,
      name,
      nodes: body.nodes.length,
      edges: body.edges.length,
      shapes: Object.keys(body.loadShapes ?? {}).length,
      savedAt: now,
      createdAt: existing?.createdAt ?? now,
    }
    await request(tx.objectStore(BODIES).put(body, id))
    await request(tx.objectStore(PROJECTS).put(meta, id))
    return meta
  })
}

export async function loadProject(
  id: string,
): Promise<{ meta: ProjectMeta; circuit: CircuitJSON } | null> {
  return withTx([PROJECTS, BODIES], 'readonly', async (tx) => {
    const meta = await request<ProjectMeta | undefined>(tx.objectStore(PROJECTS).get(id))
    const circuit = await request<CircuitJSON | undefined>(tx.objectStore(BODIES).get(id))
    if (!meta || !circuit) return null
    return { meta, circuit }
  })
}

export async function renameProject(id: string, name: string): Promise<void> {
  await withTx([PROJECTS, BODIES], 'readwrite', async (tx) => {
    const meta = await request<ProjectMeta | undefined>(tx.objectStore(PROJECTS).get(id))
    const body = await request<CircuitJSON | undefined>(tx.objectStore(BODIES).get(id))
    if (!meta || !body) return
    await request(tx.objectStore(PROJECTS).put({ ...meta, name }, id))
    await request(tx.objectStore(BODIES).put({ ...body, name }, id))
  })
}

export async function deleteProject(id: string): Promise<void> {
  await withTx([PROJECTS, BODIES], 'readwrite', async (tx) => {
    await request(tx.objectStore(PROJECTS).delete(id))
    await request(tx.objectStore(BODIES).delete(id))
  })
}

/** Shown in the Open dialog: "3 elements, 2 connections, 1 shape". */
export function describeProject(m: ProjectMeta): string {
  const parts = [
    `${m.nodes} element${m.nodes === 1 ? '' : 's'}`,
    `${m.edges} connection${m.edges === 1 ? '' : 's'}`,
  ]
  if (m.shapes) parts.push(`${m.shapes} shape${m.shapes === 1 ? '' : 's'}`)
  return parts.join(', ')
}
