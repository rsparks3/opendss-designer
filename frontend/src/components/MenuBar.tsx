import { useReactFlow } from '@xyflow/react'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api, type SampleMeta } from '../lib/api'
import { cleanUp, fitView, openProjectFile, save, saveToFile } from '../lib/fileActions'
import {
  buildMenus,
  cutSelection,
  selectAll,
  solveNow,
  type CanvasOps,
  type MenuEntry,
} from '../lib/menus'
import { keyLabel } from '../lib/shortcuts'
import { useCircuitStore } from '../store/circuitStore'
import { useResultsStore } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import { PlanCorner } from './PlanCorner'

const inField = (t: EventTarget | null) =>
  ['INPUT', 'TEXTAREA', 'SELECT'].includes((t as HTMLElement | null)?.tagName ?? '') ||
  (t as HTMLElement | null)?.isContentEditable === true

/** The operations that need React Flow's instance. */
function useCanvasOps(): CanvasOps {
  const { zoomIn, zoomOut, deleteElements } = useReactFlow()
  return useMemo(
    () => ({
      zoomIn: () => void zoomIn({ duration: 150 }),
      zoomOut: () => void zoomOut({ duration: 150 }),
      deleteSelection: () => {
        const s = useCircuitStore.getState()
        void deleteElements({
          nodes: s.nodes.filter((n) => n.selected).map((n) => ({ id: n.id })),
          edges: s.edges.filter((e) => e.selected).map((e) => ({ id: e.id })),
        })
      },
    }),
    [zoomIn, zoomOut, deleteElements],
  )
}

/** Keyboard bindings for menu commands. The drawing's own keys (undo,
 *  copy, paste, placement letters) stay in EditorCanvas. */
function useMenuShortcuts(ops: CanvasOps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUiStore.getState()
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      // Save and open work from anywhere, a text field included.
      // e.code, because Alt changes e.key on some layouts.
      if (mod && e.code === 'KeyS') {
        e.preventDefault()
        if (e.altKey) void saveToFile()
        else if (e.shiftKey) ui.openDialog('saveAs')
        else save()
        return
      }
      if (mod && k === 'o') {
        e.preventDefault()
        if (e.shiftKey) void openProjectFile()
        else ui.openDialog('library')
        return
      }
      if (e.key === 'F5') {
        // Never let F5 reload the page and lose the drawing.
        e.preventDefault()
        solveNow()
        return
      }
      if (inField(e.target) || ui.dialog) return
      if (mod && !e.shiftKey && k === 'a') {
        e.preventDefault()
        selectAll()
      } else if (mod && e.shiftKey && k === 'a') {
        e.preventDefault()
        useCircuitStore.getState().clearSelection()
      } else if (mod && k === 'x') {
        e.preventDefault()
        cutSelection(ops)
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        ops.zoomIn()
      } else if (mod && e.key === '-') {
        e.preventDefault()
        ops.zoomOut()
      } else if (mod && e.shiftKey && k === 'h') {
        e.preventDefault()
        fitView()
      } else if (mod && e.shiftKey && k === 'l') {
        e.preventDefault()
        cleanUp()
      } else if (!mod && e.key === '?') {
        ui.openDialog('shortcuts')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ops])
}

/**
 * File / Edit / View / Arrange / Analysis / Help, the way desktop drawing
 * tools lay them out. Click a title to open its menu; while one is open,
 * hovering another title switches to it. Arrow keys move through items,
 * Enter runs one, Escape closes.
 */
export function MenuBar() {
  const ops = useCanvasOps()
  useMenuShortcuts(ops)
  const [open, setOpen] = useState<number | null>(null)
  const [samples, setSamples] = useState<SampleMeta[]>([])
  const barRef = useRef<HTMLDivElement>(null)
  // Menus read the stores when drawn; while one is open, redraw on changes.
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    // Best effort: a missing sample list just greys out the submenu.
    api.samples().then((r) => setSamples(r.samples)).catch(() => {})
  }, [])

  useEffect(() => {
    if (open === null) return
    const unsubs = [
      useCircuitStore.subscribe(redraw),
      useResultsStore.subscribe(redraw),
      useUiStore.subscribe(redraw),
      useCircuitStore.temporal.subscribe(redraw),
    ]
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      unsubs.forEach((u) => u())
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const menus = open === null ? null : buildMenus(ops, samples)
  const titles = ['File', 'Edit', 'View', 'Arrange', 'Analysis', 'Help']

  const onBarKey = (e: React.KeyboardEvent) => {
    if (open === null) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(null)
    } else if (e.key === 'ArrowRight' && !(e.target as HTMLElement).closest('.mb-sub')) {
      e.preventDefault()
      setOpen((open + 1) % titles.length)
    } else if (e.key === 'ArrowLeft' && !(e.target as HTMLElement).closest('.mb-sub')) {
      e.preventDefault()
      setOpen((open + titles.length - 1) % titles.length)
    }
  }

  return (
    <div className="menubar" role="menubar" ref={barRef} onKeyDown={onBarKey}>
      <span className="app-title">OpenDSS Designer</span>
      {titles.map((title, i) => (
        <div key={title} className="mb-menu">
          <button
            type="button"
            className={`mb-title${open === i ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === i}
            onMouseDown={(e) => {
              e.preventDefault()
              setOpen(open === i ? null : i)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault()
                setOpen(i)
              }
            }}
            onMouseEnter={() => open !== null && open !== i && setOpen(i)}
          >
            {title}
          </button>
          {menus && open === i && (
            <MenuList items={menus[i].items} label={title} onDone={() => setOpen(null)} autoFocus />
          )}
        </div>
      ))}
      <span className="tb-spacer" />
      <PlanCorner />
    </div>
  )
}

function MenuList({
  items,
  label,
  onDone,
  autoFocus,
  onBack,
}: {
  items: MenuEntry[]
  label: string
  onDone: () => void
  autoFocus?: boolean
  /** Set on a submenu: Left arrow hands focus back to the row that opened it. */
  onBack?: () => void
}) {
  const sub = onBack !== undefined
  const ref = useRef<HTMLDivElement>(null)
  const [subOpen, setSubOpen] = useState<number | null>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus()
  }, [autoFocus])

  const move = (e: React.KeyboardEvent, delta: number) => {
    e.preventDefault()
    e.stopPropagation()
    const all = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(':scope > .mb-row > [role^="menuitem"]:not([disabled])') ?? [],
    )
    const at = all.indexOf(document.activeElement as HTMLElement)
    all[(at + delta + all.length) % all.length]?.focus()
  }

  return (
    <div
      className={`mb-dropdown${sub ? ' mb-sub' : ''}`}
      role="menu"
      aria-label={label}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') move(e, 1)
        else if (e.key === 'ArrowUp') move(e, -1)
        else if (e.key === 'ArrowLeft' && onBack) {
          e.preventDefault()
          e.stopPropagation()
          onBack()
        }
      }}
    >
      {items.map((entry, i) => {
        if (entry.kind === 'sep') return <div key={`sep${i}`} className="mb-sep" role="separator" />
        if (entry.kind === 'sub') {
          return (
            <div
              key={entry.label}
              className="mb-row"
              onMouseEnter={() => !entry.disabled && setSubOpen(i)}
              onMouseLeave={() => setSubOpen(null)}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={subOpen === i}
                aria-label={entry.label}
                disabled={entry.disabled}
                className="mb-item"
                onClick={() => setSubOpen(subOpen === i ? null : i)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'Enter') {
                    e.preventDefault()
                    e.stopPropagation()
                    setSubOpen(i)
                  }
                }}
              >
                <span className="mb-check" />
                <span className="mb-label">{entry.label}</span>
                <span className="mb-arrow">▸</span>
              </button>
              {subOpen === i && (
                <MenuList
                  items={entry.items}
                  label={entry.label}
                  onDone={onDone}
                  autoFocus
                  onBack={() => {
                    setSubOpen(null)
                    ref.current?.querySelectorAll<HTMLElement>(':scope > .mb-row > .mb-item')[
                      items.slice(0, i).filter((x) => x.kind !== 'sep').length
                    ]?.focus()
                  }}
                />
              )}
            </div>
          )
        }
        const role = entry.checked === undefined ? 'menuitem' : entry.radio ? 'menuitemradio' : 'menuitemcheckbox'
        return (
          <div key={entry.label} className="mb-row" onMouseEnter={() => setSubOpen(null)}>
            <button
              type="button"
              role={role}
              aria-checked={entry.checked === undefined ? undefined : entry.checked}
              aria-label={entry.label}
              aria-keyshortcuts={entry.keys ? keyLabel(entry.keys).replace('⌘', 'Meta') : undefined}
              disabled={entry.disabled}
              className="mb-item"
              title={entry.title}
              onClick={() => {
                onDone()
                entry.run()
              }}
            >
              <span className="mb-check">{entry.checked ? (entry.radio ? '●' : '✓') : ''}</span>
              <span className="mb-label">{entry.label}</span>
              {(entry.keys || entry.hint) && (
                <span className="mb-keys">{entry.keys ? keyLabel(entry.keys) : entry.hint}</span>
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}
