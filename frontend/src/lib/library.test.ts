import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CircuitJSON } from '../types/circuit'
import {
  deleteProject,
  describeProject,
  listProjects,
  loadProject,
  renameProject,
  saveProject,
} from './library'
import { loadDoc, saveDoc } from './localStore'

function circuit(name: string, nodes = 2): CircuitJSON {
  return {
    version: 2,
    name,
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: `n${i}`,
      type: 'load',
      position: { x: i * 100, y: 0 },
      params: { name: `L${i}` },
    })) as CircuitJSON['nodes'],
    edges: [],
    busNames: {},
    loadShapes: name === 'shaped' ? { s1: { kind: 'load', intervalMin: 60, points: [1, 1] } } : {},
  }
}

beforeEach(async () => {
  for (const m of await listProjects()) await deleteProject(m.id)
})

describe('project library', () => {
  it('round-trips a circuit and lists it newest first', async () => {
    await saveProject('a', 'Feeder A', circuit('Feeder A'), 1000)
    await saveProject('b', 'Feeder B', circuit('Feeder B', 3), 2000)
    const list = await listProjects()
    expect(list.map((m) => m.name)).toEqual(['Feeder B', 'Feeder A'])
    expect(list[0]).toMatchObject({ id: 'b', nodes: 3, edges: 0, shapes: 0, savedAt: 2000 })
    const loaded = await loadProject('a')
    expect(loaded?.circuit.nodes).toHaveLength(2)
    expect(loaded?.circuit.name).toBe('Feeder A')
  })

  it('keeps createdAt across re-saves and writes the name into the body', async () => {
    await saveProject('a', 'First', circuit('other-name'), 1000)
    const again = await saveProject('a', 'Renamed on save', circuit('other-name', 5), 5000)
    expect(again.createdAt).toBe(1000)
    expect(again.savedAt).toBe(5000)
    expect((await loadProject('a'))?.circuit.name).toBe('Renamed on save')
    expect(await listProjects()).toHaveLength(1)
  })

  it('renames and deletes', async () => {
    await saveProject('a', 'Old', circuit('Old'))
    await renameProject('a', 'New')
    expect((await listProjects())[0].name).toBe('New')
    expect((await loadProject('a'))?.circuit.name).toBe('New')
    await deleteProject('a')
    expect(await listProjects()).toEqual([])
    expect(await loadProject('a')).toBeNull()
  })

  it('describes counts readably', () => {
    expect(describeProject({ id: 'x', name: 'x', nodes: 1, edges: 0, shapes: 0, savedAt: 0, createdAt: 0 }))
      .toBe('1 element, 0 connections')
    expect(describeProject({ id: 'x', name: 'x', nodes: 12, edges: 11, shapes: 2, savedAt: 0, createdAt: 0 }))
      .toBe('12 elements, 11 connections, 2 shapes')
  })

  it('leaves the autosave recovery slot untouched', async () => {
    await saveDoc('autosave', { marker: 1 })
    await saveProject('a', 'A', circuit('A'))
    await deleteProject('a')
    expect(await loadDoc<{ marker: number }>('autosave')).toEqual({ marker: 1 })
  })
})
