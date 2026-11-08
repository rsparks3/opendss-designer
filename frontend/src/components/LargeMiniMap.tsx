import { Panel, useReactFlow, useStore } from '@xyflow/react'
import { useEffect, useMemo, useRef } from 'react'
import { boxOf, nodeBounds } from '../lib/viewBudget'
import { useCircuitStore } from '../store/circuitStore'
import { useUiStore } from '../store/uiStore'

const W = 200
const H = 130
const PAD = 6

/**
 * A minimap for a large circuit: the whole drawing as marks on a canvas,
 * the viewport as a rectangle over it. React Flow's own minimap draws a
 * node for every node it has been given, and on a large circuit it is
 * given none in the overview and only those in view otherwise, so it is
 * off above LARGE_CIRCUIT; this one reads the store. Click or drag to
 * move the view there at the current zoom.
 */
export function LargeMiniMap() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const nodes = useCircuitStore((s) => s.nodes)
  const transform = useStore((s) => s.transform)
  const width = useStore((s) => s.width)
  const height = useStore((s) => s.height)
  const theme = useUiStore((s) => s.theme)
  const { setViewport } = useReactFlow()

  // The drawing's marks, rendered once per circuit onto an offscreen
  // canvas and blitted under the viewport rectangle on every pan.
  const layer = useMemo(() => {
    const bounds = nodeBounds(nodes.filter((n) => n.type !== 'note' && n.type !== 'zone'))
    const scale = bounds.width && bounds.height
      ? Math.min((W - 2 * PAD) / bounds.width, (H - 2 * PAD) / bounds.height)
      : 1
    const ox = PAD + ((W - 2 * PAD) - bounds.width * scale) / 2
    const oy = PAD + ((H - 2 * PAD) - bounds.height * scale) / 2
    const toMap = (x: number, y: number) => ({ x: ox + (x - bounds.x) * scale, y: oy + (y - bounds.y) * scale })
    const fromMap = (px: number, py: number) => ({ x: bounds.x + (px - ox) / scale, y: bounds.y + (py - oy) / scale })
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    const off = document.createElement('canvas')
    off.width = Math.round(W * dpr)
    off.height = Math.round(H * dpr)
    let drawnInk: string | null = null
    const draw = (ink: string) => {
      if (drawnInk === ink) return
      drawnInk = ink
      const ctx = off.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = ink
      ctx.globalAlpha = 0.7
      for (const n of nodes) {
        if (n.type === 'note' || n.type === 'zone') continue
        const b = boxOf(n)
        const p = toMap(b.x, b.y)
        ctx.fillRect(p.x, p.y, Math.max(1, b.w * scale), Math.max(1, b.h * scale))
      }
      ctx.globalAlpha = 1
    }
    return { off, draw, toMap, fromMap, bounds }
  }, [nodes])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const dpr = window.devicePixelRatio || 1
    if (el.width !== Math.round(W * dpr)) {
      el.width = Math.round(W * dpr)
      el.height = Math.round(H * dpr)
    }
    const ctx = el.getContext('2d')
    if (!ctx) return
    const style = getComputedStyle(el)
    const ink = style.getPropertyValue('--ink').trim() || '#333'
    const accent = style.getPropertyValue('--accent').trim() || '#1976d2'
    layer.draw(ink)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(layer.off, 0, 0, W, H)
    // The viewport, in drawing units, onto the map.
    const [tx, ty, k] = transform
    if (k > 0 && width > 0 && height > 0) {
      const a = layer.toMap(-tx / k, -ty / k)
      const b = layer.toMap((width - tx) / k, (height - ty) / k)
      const rw = Math.max(2, b.x - a.x)
      const rh = Math.max(2, b.y - a.y)
      ctx.fillStyle = accent
      ctx.globalAlpha = 0.12
      ctx.fillRect(a.x, a.y, rw, rh)
      ctx.globalAlpha = 1
      ctx.strokeStyle = accent
      ctx.lineWidth = 1.5
      ctx.strokeRect(a.x, a.y, rw, rh)
    }
  }, [layer, transform, width, height, theme])

  const moveTo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const p = layer.fromMap(e.clientX - r.left, e.clientY - r.top)
    const k = transform[2]
    void setViewport({ x: width / 2 - p.x * k, y: height / 2 - p.y * k, zoom: k })
  }

  return (
    <Panel position="bottom-right" className="large-minimap-panel">
      <canvas
        ref={canvas}
        className="large-minimap"
        style={{ width: W, height: H }}
        title="Click or drag to move the view"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          moveTo(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) moveTo(e)
        }}
      />
    </Panel>
  )
}
