import { useStore } from '@xyflow/react'
import { useEffect, useMemo, useRef } from 'react'
import { loadingColor, voltageColor } from '../lib/colorScale'
import { NODE_SIZE } from '../lib/defaults'
import { resultById } from '../lib/indexes'
import { phaseColor } from '../lib/phasing'
import { useCircuitStore, useLimits } from '../store/circuitStore'
import { activeResult, activeStale, useResultsStore } from '../store/resultsStore'
import type { NodeType } from '../types/circuit'

/** Below this zoom a large circuit is drawn as an overview instead of as
 *  symbols: at 0.15 a symbol is six pixels across, too small to read or to
 *  grab, and mounting ten thousand of them costs minutes. */
export const OVERVIEW_ZOOM = 0.15

interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
  edgeId: string | null
  /** The node whose bus colours a wire in the voltage overlay. */
  nodeId: string
}

interface Bar {
  id: string
  x: number
  y: number
  w: number
  h: number
  bus: boolean
}

/** The whole drawing on one canvas, for a large circuit seen from far away:
 *  every wire and line as a stroke, every bar and symbol as a mark, coloured
 *  by the overlay that is on (voltage at the buses, loading on the lines,
 *  phases). Pointer events pass through to the pane, so panning and
 *  zooming work as ever; zooming in past OVERVIEW_ZOOM brings the symbols
 *  back. */
export function OverviewLayer() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const nodes = useCircuitStore((s) => s.nodes)
  const edges = useCircuitStore((s) => s.edges)
  const transform = useStore((s) => s.transform)
  const width = useStore((s) => s.width)
  const height = useStore((s) => s.height)
  const overlay = useResultsStore((s) => s.overlay)
  const result = useResultsStore(activeResult)
  const stale = useResultsStore(activeStale)
  const phases = useResultsStore((s) => s.phases)
  const limits = useLimits()

  const geometry = useMemo(() => {
    const centre = new Map<string, { x: number; y: number }>()
    const bars: Bar[] = []
    for (const n of nodes) {
      if (n.type === 'note' || n.type === 'zone') continue
      const size = NODE_SIZE[(n.type as NodeType) ?? 'load'] ?? NODE_SIZE.load
      const bus = n.type === 'busbar'
      const w = bus ? (n.width ?? size.w) : (n.measured?.width ?? size.w)
      const h = bus ? size.h : (n.measured?.height ?? size.h)
      bars.push({ id: n.id, x: n.position.x, y: n.position.y, w, h, bus })
      centre.set(n.id, { x: n.position.x + w / 2, y: n.position.y + h / 2 })
    }
    const segments: Segment[] = []
    for (const e of edges) {
      const a = centre.get(e.source)
      const b = centre.get(e.target)
      if (!a || !b) continue
      // Routed like the editor draws them: down, across, down -- a straight
      // stroke from a bus to a far child reads as a stray horizontal line.
      const wps = e.data?.waypoints
      const midY = (a.y + b.y) / 2
      const pts = wps?.length
        ? [a, ...wps, b]
        : a.x === b.x || a.y === b.y
          ? [a, b]
          : [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b]
      for (let i = 1; i < pts.length; i++) {
        segments.push({
          x1: pts[i - 1].x, y1: pts[i - 1].y, x2: pts[i].x, y2: pts[i].y,
          edgeId: e.type === 'line' ? e.id : null,
          nodeId: e.source,
        })
      }
    }
    return { bars, segments }
  }, [nodes, edges])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const dpr = window.devicePixelRatio || 1
    el.width = Math.round(width * dpr)
    el.height = Math.round(height * dpr)
    const ctx = el.getContext('2d')
    if (!ctx) return
    const [tx, ty, k] = transform
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const style = getComputedStyle(el)
    const ink = style.getPropertyValue('--ink').trim() || '#333'

    const solved = result?.converged && !stale ? result : null
    const elements = solved ? resultById(solved) : null
    const busColour = (nodeId: string): string => {
      if (overlay === 'voltage' && solved) {
        const bus = solved.nodeBuses[nodeId]?.[0]
        const v = bus ? solved.buses[bus]?.vminPu : null
        if (v != null) return voltageColor(v, limits)
      }
      if (overlay === 'phases') {
        const letters = phases?.nodes[nodeId]?.[0]
        if (letters !== undefined) return phaseColor(letters)
      }
      return ink
    }
    const lineColour = (s: Segment): string => {
      if (s.edgeId && overlay === 'loading' && elements) {
        const pct = elements.get(s.edgeId)?.loadingPct
        if (pct != null) return loadingColor(pct, limits)
      }
      return busColour(s.nodeId)
    }

    // Strokes batched by colour: one path per colour, not one per segment.
    const byColour = new Map<string, Path2D>()
    const pathFor = (c: string) => {
      let p = byColour.get(c)
      if (!p) byColour.set(c, (p = new Path2D()))
      return p
    }
    const sx = (x: number) => x * k + tx
    const sy = (y: number) => y * k + ty
    for (const s of geometry.segments) {
      const p = pathFor(lineColour(s))
      p.moveTo(sx(s.x1), sy(s.y1))
      p.lineTo(sx(s.x2), sy(s.y2))
    }
    ctx.lineWidth = 1
    for (const [c, p] of byColour) {
      ctx.strokeStyle = c
      ctx.stroke(p)
    }
    // Bars and symbols, at least a pixel or two so a bus stays visible.
    for (const b of geometry.bars) {
      ctx.fillStyle = b.bus ? busColour(b.id) : ink
      const w = Math.max(b.bus ? 2 : 1.5, b.w * k)
      const h = Math.max(b.bus ? 2 : 1.5, b.h * k)
      ctx.fillRect(sx(b.x), sy(b.y), w, h)
    }
  }, [geometry, transform, width, height, overlay, result, stale, phases, limits])

  return <canvas ref={canvas} className="overview-layer" />
}
