import { useReactFlow } from '@xyflow/react'
import { effectivePhasing } from '../lib/phasing'
import { allOfType, downstreamOf, onPhase } from '../lib/selection'
import { useCircuitStore } from '../store/circuitStore'
import { typeLabel } from './BulkEditor'

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
    // Everything that compiles to a switch can be opened and closed here.
    const SWITCH_LABELS: Record<string, [string, string]> = {
      breaker: ['Open breaker', 'Close breaker'],
      fuse: ['Blow fuse', 'Replace fuse'],
      recloser: ['Open recloser', 'Close recloser'],
      relay: ['Open relay', 'Close relay'],
    }
    const labels = SWITCH_LABELS[node.type ?? '']
    if (labels) {
      const closed = node.data.params.closed !== false
      items.push({
        label: closed ? labels[0] : labels[1],
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

  // Ways of picking many elements at once, for a bulk edit in the
  // properties panel. Downstream follows the feeder away from the source;
  // the type and phase picks come from the element clicked.
  const type = node ? node.type ?? '' : edge?.type === 'line' ? 'line' : ''
  const picked = node ? { kind: 'node' as const, id: node.id } : edge ? { kind: 'edge' as const, id: edge.id } : null
  if (picked && (node || edge?.type === 'line')) {
    items.push({
      label: 'Select everything downstream',
      action: () => store.selectMany(downstreamOf(store.nodes, store.edges, picked)),
    })
  }
  if (type && type !== 'busbar' && type !== 'vsource') {
    const plural = typeLabel(type, 2)
    items.push({
      label: `Select all ${plural}`,
      action: () => store.selectMany(allOfType(store.nodes, store.edges, type)),
    })
    const params = node ? node.data.params : edge?.data?.params
    if (params && 'phases' in params) {
      for (const letter of effectivePhasing(params)) {
        items.push({
          label: `Select all ${plural} on phase ${letter}`,
          action: () => {
            const all = allOfType(store.nodes, store.edges, type)
            store.selectMany({
              nodeIds: all.nodeIds.filter((id) =>
                onPhase(store.nodes.find((n) => n.id === id)?.data.params, letter)),
              edgeIds: all.edgeIds.filter((id) =>
                onPhase(store.edges.find((e) => e.id === id)?.data?.params, letter)),
            })
          },
        })
      }
    }
  }
  // A mixed multi-selection can be narrowed to one of its types.
  const selNodes = store.nodes.filter((n) => n.selected)
  const selLines = store.edges.filter((e) => e.selected && e.type === 'line')
  const selTypes = new Set<string>([...selNodes.map((n) => n.type ?? ''), ...selLines.map(() => 'line')])
  if (selTypes.size > 1) {
    for (const t of selTypes) {
      const n = t === 'line' ? selLines.length : selNodes.filter((x) => x.type === t).length
      items.push({
        label: `Keep only the ${n} ${typeLabel(t, n)} selected`,
        action: () =>
          store.selectMany({
            nodeIds: selNodes.filter((x) => x.type === t).map((x) => x.id),
            edgeIds: t === 'line' ? selLines.map((x) => x.id) : [],
          }),
      })
    }
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
