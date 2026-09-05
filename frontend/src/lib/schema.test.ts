import { describe, expect, it } from 'vitest'
import { DocumentError, SCHEMA_VERSION, migrateCircuit } from './schema'

const minimal = { version: 1, name: 'c', nodes: [{ id: 'n1', type: 'load' }], edges: [] }

describe('migrateCircuit', () => {
  it('accepts a current document unchanged', () => {
    const { circuit, warning } = migrateCircuit(minimal)
    expect(warning).toBeUndefined()
    expect(circuit.version).toBe(SCHEMA_VERSION)
    expect(circuit.nodes).toHaveLength(1)
  })

  it('treats a missing version as the original format', () => {
    const { version, ...noVersion } = minimal
    void version
    expect(() => migrateCircuit(noVersion)).not.toThrow()
  })

  it('warns rather than silently truncating a document from the future', () => {
    // The old code dropped unknown top-level keys with no signal at all, which
    // is data loss the moment two client versions share one document.
    const { circuit, warning } = migrateCircuit({
      ...minimal,
      version: SCHEMA_VERSION + 1,
      somethingNew: { a: 1 },
    })
    expect(warning).toMatch(/newer version/i)
    expect(circuit.nodes).toHaveLength(1)
  })

  it.each([
    [null, 'not an OpenDSS Designer project'],
    ['a string', 'not an OpenDSS Designer project'],
    [{ version: 1, name: 'x' }, 'missing its nodes or edges'],
    [{ version: 1, nodes: 'oops', edges: [] }, 'missing its nodes or edges'],
  ])('rejects malformed input with a readable message: %s', (bad, msg) => {
    expect(() => migrateCircuit(bad)).toThrow(DocumentError)
    expect(() => migrateCircuit(bad)).toThrow(new RegExp(msg, 'i'))
  })
})
