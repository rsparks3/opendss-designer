import { useRef, useState, type ReactNode } from 'react'

/**
 * A resizable, collapsible side column, mirroring the bottom panel: drag the
 * inner edge to resize (width persists), click the chevron to collapse to a
 * thin strip (state persists). The child decides its own content; this only
 * owns the width.
 */
export function SidePanel({
  side,
  storageKey,
  defaultWidth,
  minWidth = 140,
  maxWidth = 520,
  title,
  children,
}: {
  side: 'left' | 'right'
  storageKey: string
  defaultWidth: number
  minWidth?: number
  maxWidth?: number
  title: string
  children: ReactNode
}) {
  const widthKey = `opendss-designer.${storageKey}Width`
  const openKey = `opendss-designer.${storageKey}Open`
  const [width, setWidth] = useState(() => readNumber(widthKey, defaultWidth, minWidth, maxWidth))
  const [open, setOpen] = useState(() => readFlag(openKey, true))
  const widthRef = useRef(width)

  const toggle = () => {
    setOpen((o) => {
      write(openKey, o ? '0' : '1')
      return !o
    })
  }

  const startResize = (down: React.PointerEvent) => {
    down.preventDefault()
    const startX = down.clientX
    const startW = widthRef.current
    const move = (e: PointerEvent) => {
      const delta = side === 'left' ? e.clientX - startX : startX - e.clientX
      const w = Math.min(Math.max(startW + delta, minWidth), maxWidth)
      widthRef.current = w
      setWidth(w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      write(widthKey, String(widthRef.current))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const chevron = open ? (side === 'left' ? '‹' : '›') : side === 'left' ? '›' : '‹'
  return (
    <div
      className={`side-panel side-${side}${open ? '' : ' collapsed'}`}
      style={{ width: open ? width : undefined }}
    >
      <button
        type="button"
        className="sp-toggle"
        onClick={toggle}
        title={open ? `Collapse ${title}` : `Show ${title}`}
        aria-label={open ? `Collapse ${title}` : `Show ${title}`}
        aria-expanded={open}
      >
        {chevron}
      </button>
      {open && (
        <>
          <div className="sp-content">{children}</div>
          <div className="sp-resizer" onPointerDown={startResize} title="Drag to resize" />
        </>
      )}
    </div>
  )
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    if (v >= min && v <= max) return v
  } catch {
    // storage unavailable
  }
  return fallback
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable — the change still applies for this session
  }
}
