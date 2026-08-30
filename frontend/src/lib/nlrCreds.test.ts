import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNlrCreds, loadNlrCreds, maskKey, saveNlrCreds } from './nlrCreds'

// vitest runs in a node environment: provide a minimal localStorage.
const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
})
afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage
})

describe('nlrCreds', () => {
  it('round-trips save/load and clears', () => {
    expect(loadNlrCreds()).toBeNull()
    saveNlrCreds({ apiKey: 'abc123', email: 'ryan@example.com' })
    expect(loadNlrCreds()).toEqual({ apiKey: 'abc123', email: 'ryan@example.com' })
    clearNlrCreds()
    expect(loadNlrCreds()).toBeNull()
  })

  it('treats corrupt or empty-key entries as absent', () => {
    store.set('opendss-designer.nlrApiCred', 'not json {')
    expect(loadNlrCreds()).toBeNull()
    store.set('opendss-designer.nlrApiCred', JSON.stringify({ apiKey: '  ', email: 'a@b.c' }))
    expect(loadNlrCreds()).toBeNull()
  })

  it('survives a missing localStorage entirely', () => {
    delete (globalThis as Record<string, unknown>).localStorage
    expect(loadNlrCreds()).toBeNull()
    expect(() => saveNlrCreds({ apiKey: 'k', email: 'e' })).not.toThrow()
    expect(() => clearNlrCreds()).not.toThrow()
  })

  it('masks keys for display', () => {
    expect(maskKey('abcd1234efgh')).toBe('••••efgh')
  })
})
