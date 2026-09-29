import { NodeResizeControl, ResizeControlVariant, useInternalNode, type InternalNode, type NodeProps } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import { arrowHead, leaderLine, lineAnchor, type Box, type XY } from '../../lib/noteLeader'
import { beginGesture, endGesture, useCircuitStore, type AppNode } from '../../store/circuitStore'
import { useUiStore } from '../../store/uiStore'

export const NOTE_FONT: Record<string, number> = { small: 11, normal: 13, large: 17 }

/** A text annotation on the drawing. The width is the user's (drag either
 *  side); the height follows the text. Double-click to type. An optional
 *  arrow points at the element the note is about and follows it around.
 *
 *  Every word is its own span so the image export, which writes one <text>
 *  per run of text at the box the browser laid it out in, keeps the note's
 *  line breaks and wrapping exactly as drawn. */
export function NoteNode({ id, data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<AppNode>) {
  const params = data.params
  const text = typeof params.text === 'string' ? params.text : ''
  const editing = useUiStore((s) => s.editingNote === id)
  const setEditing = useUiStore((s) => s.setEditingNote)
  const updateNodeParams = useCircuitStore((s) => s.updateNodeParams)
  const setNoteWidth = useCircuitStore((s) => s.setNoteWidth)
  const self = useInternalNode(id)
  const target = useLeaderTarget(typeof params.target === 'string' ? params.target : '')
  const fontSize = NOTE_FONT[String(params.size)] ?? NOTE_FONT.normal
  const framed = params.frame !== false

  const w = self?.measured.width ?? 0
  const h = self?.measured.height ?? 0
  const leader =
    target && w && h ? leaderLine({ x: positionAbsoluteX, y: positionAbsoluteY, w, h }, target) : null

  return (
    <div
      className={`note-node${framed ? ' framed' : ''}${selected ? ' selected' : ''}`}
      style={{ fontSize }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditing(id)
      }}
    >
      {selected && !editing && (
        <>
          <NodeResizeControl
            position="left"
            variant={ResizeControlVariant.Line}
            minWidth={60}
            className="note-resize"
            onResizeStart={beginGesture}
            onResizeEnd={(_e, p) => {
              setNoteWidth(id, p.width)
              endGesture()
            }}
          />
          <NodeResizeControl
            position="right"
            variant={ResizeControlVariant.Line}
            minWidth={60}
            className="note-resize"
            onResizeStart={beginGesture}
            onResizeEnd={(_e, p) => {
              setNoteWidth(id, p.width)
              endGesture()
            }}
          />
        </>
      )}
      {editing ? (
        <NoteEditor
          initial={text}
          onDone={(value) => {
            setEditing(null)
            if (value !== text) updateNodeParams(id, { text: value })
          }}
        />
      ) : text.trim() ? (
        text.split('\n').map((line, i) => (
          <div key={i} className="note-line">
            {line.trim()
              ? line.split(/(\s+)/).map((word, j) => (word.trim() ? <span key={j}>{word}</span> : word))
              : ' '}
          </div>
        ))
      ) : (
        <div className="note-placeholder">Double-click to type</div>
      )}
      {leader && <Leader from={leader.from} to={leader.to} origin={{ x: positionAbsoluteX, y: positionAbsoluteY }} />}
    </div>
  )
}

function NoteEditor({ initial, onDone }: { initial: string; onDone: (value: string) => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    // React Flow keeps a new node hidden until it has measured it, and a
    // hidden element cannot take focus, so keep trying for a few frames.
    let raf = 0
    let tries = 0
    const tryFocus = () => {
      const el = ref.current
      if (!el) return
      el.focus()
      if (document.activeElement === el) {
        el.setSelectionRange(el.value.length, el.value.length)
      } else if (++tries < 30) {
        raf = requestAnimationFrame(tryFocus)
      }
    }
    raf = requestAnimationFrame(tryFocus)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <textarea
      ref={ref}
      aria-label="Note text"
      className="note-editor nodrag nowheel nopan"
      value={value}
      rows={Math.max(2, value.split('\n').length)}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) ref.current?.blur()
      }}
    />
  )
}

/** The arrow, as an SVG sized to just enclose it so the image export copies
 *  it like any symbol. Coordinates are flow units; `origin` is the note's
 *  corner, which the SVG is positioned from. */
function Leader({ from, to, origin }: { from: XY; to: XY; origin: XY }) {
  const head = arrowHead(from, to)
  const pts = [from, ...head]
  const pad = 2
  const minX = Math.min(...pts.map((p) => p.x)) - pad
  const minY = Math.min(...pts.map((p) => p.y)) - pad
  const maxX = Math.max(...pts.map((p) => p.x)) + pad
  const maxY = Math.max(...pts.map((p) => p.y)) + pad
  const w = maxX - minX
  const h = maxY - minY
  const f = (n: number) => n.toFixed(1)
  return (
    <svg
      className="note-leader"
      width={f(w)}
      height={f(h)}
      viewBox={`${f(minX)} ${f(minY)} ${f(w)} ${f(h)}`}
      style={{ left: minX - origin.x, top: minY - origin.y }}
    >
      <line x1={f(from.x)} y1={f(from.y)} x2={f(to.x)} y2={f(to.y)} />
      <polygon points={head.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')} />
    </svg>
  )
}

/** Where a note's arrow should land, in flow units: the box of the symbol it
 *  names, or the middle of the line. Null when there is nothing to point at
 *  (no target, or the element was deleted). */
function useLeaderTarget(target: string): Box | XY | null {
  const node = useInternalNode(target)
  const edge = useCircuitStore((s) => (target ? s.edges.find((e) => e.id === target) : undefined))
  const src = useInternalNode(edge?.source ?? '')
  const tgt = useInternalNode(edge?.target ?? '')
  if (!target) return null
  if (node && node.type !== 'note') {
    const { x, y } = node.internals.positionAbsolute
    return { x, y, w: node.measured.width ?? 0, h: node.measured.height ?? 0 }
  }
  if (edge && src && tgt) {
    const a = handleCenter(src, edge.sourceHandle)
    const b = handleCenter(tgt, edge.targetHandle)
    return lineAnchor([a, b], edge.data?.waypoints)
  }
  return null
}

function handleCenter(n: InternalNode, handleId: string | null | undefined): XY {
  const { x, y } = n.internals.positionAbsolute
  const bounds = [...(n.internals.handleBounds?.source ?? []), ...(n.internals.handleBounds?.target ?? [])]
  const hb = bounds.find((b) => b.id === handleId) ?? bounds[0]
  if (!hb) return { x: x + (n.measured.width ?? 0) / 2, y: y + (n.measured.height ?? 0) / 2 }
  return { x: x + hb.x + hb.width / 2, y: y + hb.y + hb.height / 2 }
}
