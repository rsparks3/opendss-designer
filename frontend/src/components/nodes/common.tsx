import type { ReactNode } from 'react'
import { loadingColor } from '../../lib/colorScale'
import { useResultsStore } from '../../store/resultsStore'
import { LoadingPie } from '../LoadingPie'

export function useNodeIssueClass(id: string): string {
  const issues = useResultsStore((s) => s.issues)
  const mine = issues.filter((i) => i.nodeId === id)
  if (mine.some((i) => i.severity === 'error')) return ' issue-error'
  if (mine.length) return ' issue-warning'
  return ''
}

export function NodeLabel({ children }: { children: ReactNode }) {
  return <div className="node-label">{children}</div>
}

export function Badge({ color, children }: { color: string; children: ReactNode }) {
  const stale = useResultsStore((s) => s.stale)
  return (
    <div className="result-badge" style={{ background: color, opacity: stale ? 0.35 : 1 }}>
      {children}
    </div>
  )
}

/** Voltage badge for any node sitting on a bus, shown in 'voltage' overlay mode. */
export function VoltageBadge({ nodeId }: { nodeId: string }) {
  const overlay = useResultsStore((s) => s.overlay)
  const result = useResultsStore((s) => s.result)
  if (overlay !== 'voltage' || !result?.converged) return null
  const bus = result.nodeBuses[nodeId]?.[0]
  const data = bus ? result.buses[bus] : null
  if (!data || data.vminPu == null) return null
  return <VBadgeInner v={data.vminPu} />
}

function VBadgeInner({ v }: { v: number }) {
  // lazy import to avoid circular: color logic inline
  const color = v < 0.5 ? '#546e7a' : v < 0.95 ? '#0277bd' : v > 1.05 ? '#d32f2f' : '#2e7d32'
  return <Badge color={color}>{v.toFixed(3)} pu</Badge>
}

/** Loading pie in a light pill, dark text — shared by node badges. */
export function PieBadge({ pct }: { pct: number }) {
  const stale = useResultsStore((s) => s.stale)
  return (
    <div className="result-badge pie-badge" style={{ opacity: stale ? 0.35 : 1 }}>
      <LoadingPie pct={pct} />
      <span style={{ color: loadingColor(pct) }}>{pct.toFixed(0)}%</span>
    </div>
  )
}

/** Loading/power badge for series elements (transformer, breaker). */
export function ElementBadge({ nodeId }: { nodeId: string }) {
  const overlay = useResultsStore((s) => s.overlay)
  const result = useResultsStore((s) => s.result)
  if ((overlay !== 'loading' && overlay !== 'power') || !result?.converged) return null
  const el = Object.values(result.elements).find((e) => e.id === nodeId)
  if (!el) return null
  if (overlay === 'power') {
    return <Badge color="#455a64">{el.kw.toFixed(0)} kW</Badge>
  }
  if (el.loadingPct == null) return null
  return <PieBadge pct={el.loadingPct} />
}
