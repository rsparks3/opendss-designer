import { describe, expect, it } from 'vitest'
import type { HealthInfo } from './api'
import { describeInstance } from './plan'

const base: HealthInfo = { version: '0.4.0', opendssVersion: 'x', mode: 'local' }

describe('describeInstance', () => {
  it('renders nothing for a local install', () => {
    expect(describeInstance(null)).toBeNull()
    expect(describeInstance(base)).toBeNull()
  })

  it('describes a plain demo instance with its element cap', () => {
    const text = describeInstance({
      ...base,
      mode: 'demo',
      limits: { maxNodes: 1200, maxEdges: null, maxShapes: null, maxShapePoints: null, maxBodyBytes: null },
    })
    expect(text?.title).toBe('Hosted instance.')
    expect(text?.body).toContain('1,200 elements')
    expect(text?.body).toContain('stays in this browser')
    expect(text?.links).toEqual([])
  })

  it('renders whatever plan strings the gateway supplies', () => {
    const text = describeInstance({
      ...base,
      mode: 'demo',
      limits: { maxNodes: 500, maxEdges: null, maxShapes: null, maxShapePoints: null, maxBodyBytes: null },
      plan: {
        name: 'Free',
        message: '12 of 20 min used this month.',
        links: [
          { label: 'Upgrade', url: '/account' },
          { label: 'Docs', url: 'https://example.test/docs' },
          { label: 'Nope', url: 'javascript:alert(1)' },
        ],
      },
    })
    expect(text?.title).toBe('Free plan.')
    expect(text?.body.startsWith('12 of 20 min used this month.')).toBe(true)
    expect(text?.body).toContain('500 elements')
    expect(text?.links.map((l) => l.label)).toEqual(['Upgrade', 'Docs'])
  })

  it('shows a plan even when the process is not in demo mode', () => {
    const text = describeInstance({ ...base, plan: { name: 'Pro' } })
    expect(text?.title).toBe('Pro plan.')
  })
})
