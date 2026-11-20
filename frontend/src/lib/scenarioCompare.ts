// The per-element compare table of a batch run: one column per scenario at
// one load level, one row per bus (lowest voltage), series element (loading)
// or priority (unserved kW), the worst value of each row picked out.

import type { BatchCell, BatchResult } from '../types/circuit'
import { PRIORITIES, PRIORITY_LABELS } from './trace'

export type CompareMetric = 'unserved' | 'voltage' | 'loading'

export interface CompareRow {
  key: string
  /** A bus name, a diagram id (loading), or a priority label. */
  label: string
  /** Diagram id to locate, for loading rows. */
  elementId?: string
  values: (number | null)[]
  /** Index of the worst value; null when every value is the same. */
  worst: number | null
}

export interface CompareTable {
  columns: { id: string | null; name: string }[]
  rows: CompareRow[]
}

const ROW_CAP = 300

/** The cells of one level, in scenario order. */
function cellsAt(result: BatchResult, level: string | null): BatchCell[] {
  return result.scenarios
    .map((sc) => result.cells.find((c) => c.scenario === sc.id && c.level === level))
    .filter((c): c is BatchCell => !!c)
}

export function compareTable(result: BatchResult, level: string | null, metric: CompareMetric,
  nameOf: (id: string) => string = (id) => id): CompareTable {
  const cells = cellsAt(result, level)
  const columns = cells.map((c) => ({ id: c.scenario, name: c.scenarioName }))
  const lowerIsWorse = metric === 'voltage'
  const rows: CompareRow[] = []
  const pushRow = (key: string, label: string, values: (number | null)[], elementId?: string) => {
    const real = values.map((v, i) => [v, i] as const).filter(([v]) => v != null) as [number, number][]
    let worst: number | null = null
    if (real.length > 1 && real.some(([v]) => Math.abs(v - real[0][0]) > 1e-9)) {
      worst = real.reduce((a, b) => (lowerIsWorse ? (b[0] < a[0] ? b : a) : (b[0] > a[0] ? b : a)))[1]
    }
    rows.push({ key, label, values, worst, elementId })
  }
  if (metric === 'unserved') {
    for (const p of PRIORITIES) {
      pushRow(p, PRIORITY_LABELS[p], cells.map((c) => c.detail?.unservedKw[p] ?? null))
    }
    pushRow('total', 'Total', cells.map((c) =>
      c.detail ? PRIORITIES.reduce((s, p) => s + (c.detail!.unservedKw[p] ?? 0), 0) : null))
    return { columns, rows }
  }
  const keys = new Set<string>()
  for (const c of cells) for (const k of Object.keys((metric === 'voltage' ? c.detail?.busVmin : c.detail?.loading) ?? {})) keys.add(k)
  for (const k of keys) {
    const values = cells.map((c) => {
      const v = metric === 'voltage' ? c.detail?.busVmin[k] : c.detail?.loading[k]
      return v == null ? null : v
    })
    pushRow(k, metric === 'voltage' ? k : nameOf(k), values, metric === 'loading' ? k : undefined)
  }
  // The rows that differ most first: what a planner is looking for.
  const spread = (r: CompareRow) => {
    const v = r.values.filter((x): x is number => x != null)
    return v.length ? Math.max(...v) - Math.min(...v) : 0
  }
  rows.sort((a, b) => spread(b) - spread(a) || a.label.localeCompare(b.label))
  return { columns, rows: rows.slice(0, ROW_CAP) }
}
