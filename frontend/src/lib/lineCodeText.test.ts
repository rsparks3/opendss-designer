import { describe, expect, it } from 'vitest'
import { balancedMatrix, formatMatrix, parseMatrix } from './lineCodeText'

describe('parseMatrix', () => {
  it('reads the lower triangle as OpenDSS writes it and mirrors it', () => {
    const m = parseMatrix('0.3465 | 0.1560 0.3375 | 0.1580 0.1535 0.3414', 3)
    expect(m).toEqual([
      [0.3465, 0.156, 0.158],
      [0.156, 0.3375, 0.1535],
      [0.158, 0.1535, 0.3414],
    ])
  })

  it('accepts brackets, parentheses, commas and a full square', () => {
    expect(parseMatrix('[1.3238 | 0.2066 1.3294]', 2)).toEqual([[1.3238, 0.2066], [0.2066, 1.3294]])
    expect(parseMatrix('(1.3292)', 1)).toEqual([[1.3292]])
    expect(parseMatrix('1, 2 | 2, 3', 2)).toEqual([[1, 2], [2, 3]])
  })

  it('refuses the wrong number of rows or a ragged row', () => {
    expect(parseMatrix('0.3 | 0.1 0.3', 3)).toBeNull()
    expect(parseMatrix('0.3 | 0.1 0.3 0.2', 2)).toBeNull()
    expect(parseMatrix('0.3 | abc 0.3', 2)).toBeNull()
  })
})

describe('formatMatrix', () => {
  it('round-trips through parseMatrix', () => {
    const m = [[0.086666667, 0.029545455, 0.02907197], [0.029545455, 0.088371212, 0.029924242], [0.02907197, 0.029924242, 0.087405303]]
    const text = formatMatrix(m)
    expect(text).toBe('0.0866667 | 0.0295455 0.0883712 | 0.029072 0.0299242 0.0874053')
    const back = parseMatrix(text, 3)!
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(back[i][j]).toBeCloseTo(m[i][j], 6)
  })
})

describe('balancedMatrix', () => {
  it('matches what the engine builds from sequence values', () => {
    const m = balancedMatrix(0.1, 0.4, 3)
    expect(m[0][0]).toBeCloseTo(0.2, 12)
    expect(m[0][1]).toBeCloseTo(0.1, 12)
    expect(m[2][1]).toBeCloseTo(0.1, 12)
  })
})
