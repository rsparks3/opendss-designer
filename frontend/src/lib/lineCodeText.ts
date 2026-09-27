import type { AppEdge } from '../store/circuitStore'
import type { LineCodeJSON } from '../types/circuit'

/** OpenDSS's own matrix spelling, so a code can be pasted straight out of a
 *  .dss file or a Kersting table: rows separated by `|`, lower triangle only
 *  (the matrix is symmetric), brackets and parentheses optional.
 *
 *      0.3465 | 0.1560 0.3375 | 0.1580 0.1535 0.3414
 *
 *  A full square matrix is accepted too. */
export function parseMatrix(text: string, n: number): number[][] | null {
  const rows = text
    .replace(/[[\]()]/g, ' ')
    .split('|')
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => r.split(/[\s,]+/).map(Number))
  if (rows.length !== n || rows.some((r) => r.some((v) => !Number.isFinite(v)))) return null
  const full: number[][] = rows.map(() => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    const row = rows[i]
    if (row.length === i + 1) {
      // Lower triangle: mirror across the diagonal.
      for (let j = 0; j <= i; j++) {
        full[i][j] = row[j]
        full[j][i] = row[j]
      }
    } else if (row.length === n) {
      for (let j = 0; j < n; j++) full[i][j] = row[j]
    } else {
      return null
    }
  }
  return full
}

/** The lower triangle, one row per `|`, the way OpenDSS writes it. */
export function formatMatrix(m: number[][] | null | undefined): string {
  if (!m) return ''
  return m.map((row, i) => row.slice(0, i + 1).map(fmt).join(' ')).join(' | ')
}

const fmt = (v: number) => {
  const s = Number(v.toPrecision(6)).toString()
  return s
}

/** A balanced matrix from sequence values: Zs = (2 Z1 + Z0) / 3 on the
 *  diagonal, Zm = (Z0 - Z1) / 3 off it. What the engine builds from
 *  r1/x1/r0/x0, useful for showing a sequence code the same way. */
export function balancedMatrix(z1: number, z0: number, n: number): number[][] {
  const zs = (2 * z1 + z0) / 3
  const zm = (z0 - z1) / 3
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? zs : zm)),
  )
}

export function isMatrixCode(spec: LineCodeJSON): boolean {
  return Array.isArray(spec.rmatrix) && Array.isArray(spec.xmatrix)
}

/** Names of the lines on a code, for "used by" and delete warnings. */
export function linesOnCode(edges: AppEdge[], name: string): string[] {
  return edges
    .filter((e) => e.type === 'line' && e.data?.params.linecode === name)
    .map((e) => String(e.data?.params.name ?? e.id))
}

/** A code every conductor can start from: the IEEE 13-bus mtx601 (336 ACSR,
 *  configuration 601), in ohms per mile. Users replace the numbers. */
export const STARTER: LineCodeJSON = {
  nphases: 3,
  units: 'mi',
  rmatrix: [
    [0.3465, 0.156, 0.158],
    [0.156, 0.3375, 0.1535],
    [0.158, 0.1535, 0.3414],
  ],
  xmatrix: [
    [1.0179, 0.5017, 0.4236],
    [0.5017, 1.0478, 0.3849],
    [0.4236, 0.3849, 1.0348],
  ],
  cmatrix: null,
  normamps: 530,
  source: 'typed in',
}
