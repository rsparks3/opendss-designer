import { useReactFlow } from '@xyflow/react'
import { useCircuitStore } from '../store/circuitStore'

export interface MenuTarget {
  kind: 'node' | 'edge'
  id: string
  x: number
  y: number
}

interface MenuItem {
  label: string
  hint?: string
  danger?: boolean
  action: () => void
}

/** Right-click menu for nodes and edges. */
export function ContextMenu({ target, onClose }: { target: MenuTarget; onClose: () => void }) {
  const { deleteElements } = useReactFlow()
  const store = useCircuitStore.getState()
  const node = target.kind === 'node' ? store.nodes.find((n) => n.id === target.id) : undefined
  const edge = target.kind === 'edge' ? store.edges.find((e) => e.id === target.id) : undefined

  const items: MenuItem[] = []

  if (node) {
    if (node.type === 'breaker') {
      const closed = node.data.params.closed !== false
      items.push({
        label: closed ? 'Open breaker' : 'Close breaker',
        action: () => store.updateNodeParams(node.id, { closed: !closed }),
      })
    }
    if (node.type !== 'busbar') {
      items.push({ label: 'Rotate 90°', hint: 'R', action: () => store.rotateNodes([node.id]) })
    }
    items.push({
      label: 'Duplicate',
      hint: 'Ctrl+D',
      action: () => {
        // Right-clicking inside a multi-selection duplicates the whole
        // selection; otherwise just this node.
        if (!node.selected) store.selectOnly('node', node.id)
        useCircuitStore.getState().duplicateSelection()
      },
    })
    items.push({
      label: 'Delete',
      hint: 'Del',
      danger: true,
      action: () => void deleteElements({ nodes: [{ id: node.id }] }),
    })
  }

  if (edge) {
    if (edge.data?.waypoints?.length) {
      items.push({
        label: 'Straighten (remove waypoints)',
        action: () => store.setEdgeWaypoints(edge.id, []),
      })
    }
    items.push({
      label: 'Delete',
      hint: 'Del',
      danger: true,
      action: () => void deleteElements({ edges: [{ id: edge.id }] }),
    })
  }

  if (!items.length) return null

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div className="context-menu" style={{ left: target.x, top: target.y }}>
        {items.map((item) => (
          <button
            key={item.label}
            className={item.danger ? 'danger' : ''}
            onClick={() => {
              item.action()
              onClose()
            }}
          >
            {item.label}
            {item.hint && <span className="kbd-hint">{item.hint}</span>}
          </button>
        ))}
      </div>
    </>
  )
}
