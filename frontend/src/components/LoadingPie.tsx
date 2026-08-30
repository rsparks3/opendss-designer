import { loadingColor } from '../lib/colorScale'

/** Small pie chart showing loading as a filled fraction of the circle,
 *  in the tradition of power-flow packages. ≥100% renders a full pie
 *  (color already signals the overload). */
export function LoadingPie({ pct, size = 16 }: { pct: number; size?: number }) {
  const color = loadingColor(pct)
  const c = size / 2
  const r = c - 1.5
  const frac = Math.max(0, Math.min(pct, 100) / 100)
  const angle = frac * 2 * Math.PI
  const x = c + r * Math.sin(angle)
  const y = c - r * Math.cos(angle)
  const large = angle > Math.PI ? 1 : 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={c} cy={c} r={r} fill="white" stroke={color} strokeWidth="1.5" />
      {frac >= 1 ? (
        <circle cx={c} cy={c} r={r} fill={color} stroke={color} strokeWidth="1.5" />
      ) : frac > 0.005 ? (
        <path d={`M ${c},${c} L ${c},${c - r} A ${r} ${r} 0 ${large} 1 ${x},${y} Z`} fill={color} />
      ) : null}
    </svg>
  )
}
