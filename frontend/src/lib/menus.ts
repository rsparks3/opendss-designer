import type { SampleMeta } from './api'
import {
  chooseOverlay,
  cleanUp,
  exportDss,
  exportImage,
  fitView,
  importDss,
  newCircuit,
  openProjectFile,
  openSample,
  save,
  saveToFile,
} from './fileActions'
import { canSaveInPlace } from './fileSystem'
import { runSolve } from './solve'
import { redo, undo, useCircuitStore } from '../store/circuitStore'
import { useResultsStore, type OverlayMode } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'

/**
 * The menu bar, as data. Each menu is rebuilt from the stores whenever it
 * opens, so enabled and checked states are always current; `MenuBar` only
 * draws what this returns.
 */

export type MenuEntry =
  | {
      kind: 'item'
      label: string
      /** Binding as written in SHORTCUTS ("Mod+S"); printed beside the item. */
      keys?: string
      /** Grey text on the right, where a shortcut would go. */
      hint?: string
      run: () => void
      disabled?: boolean
      /** Present for toggles (checkbox) and choices (radio). */
      checked?: boolean
      radio?: boolean
      title?: string
    }
  | { kind: 'sep' }
  | { kind: 'sub'; label: string; items: MenuEntry[]; disabled?: boolean }

export interface Menu {
  label: string
  items: MenuEntry[]
}

/** What the menus need that only lives inside React Flow's context. */
export interface CanvasOps {
  zoomIn: () => void
  zoomOut: () => void
  deleteSelection: () => void
}

export const DOCS_URL = 'https://opendssdesigner-docs.ryanmsparks.com'
export const ISSUES_URL = 'https://github.com/rsparks3/opendss-designer/issues'

const item = (
  label: string,
  run: () => void,
  more: Partial<Extract<MenuEntry, { kind: 'item' }>> = {},
): MenuEntry => ({ kind: 'item', label, run, ...more })
const sep: MenuEntry = { kind: 'sep' }

export const OVERLAY_CHOICES: { mode: OverlayMode; label: string; title?: string }[] = [
  { mode: 'voltage', label: 'Voltages' },
  { mode: 'loading', label: 'Loading' },
  { mode: 'power', label: 'Power' },
  { mode: 'fault', label: 'Fault', title: 'Short-circuit study: prospective fault current at each bus' },
  {
    mode: 'phases',
    label: 'Phases',
    title: 'Colour lines by the phases they carry and buses by the phases that reach them (no solve needed)',
  },
  { mode: 'off', label: 'Off' },
]

export function selectAll() {
  const s = useCircuitStore.getState()
  s.selectMany({ nodeIds: s.nodes.map((n) => n.id), edgeIds: s.edges.map((e) => e.id) })
}

export function cutSelection(ops: CanvasOps) {
  if (useCircuitStore.getState().copySelection()) ops.deleteSelection()
}

export function copySelection() {
  const n = useCircuitStore.getState().copySelection()
  if (n) useResultsStore.getState().setFlash(`Copied ${n} element${n > 1 ? 's' : ''}`, 'info', 1500)
}

/** Snapshot solve, when one is allowed. */
export function solveNow() {
  const rs = useResultsStore.getState()
  if (rs.solving || rs.tsRunning || rs.analysisMode === 'timeseries') return
  if (rs.issues.some((i) => i.severity === 'error')) return
  void runSolve()
}

export function toggleAutoSolve() {
  const rs = useResultsStore.getState()
  const next = !rs.autoSolve
  rs.setAutoSolve(next)
  if (next && !rs.issues.some((i) => i.severity === 'error')) void runSolve()
}

export function buildMenus(ops: CanvasOps, samples: SampleMeta[]): Menu[] {
  const cs = useCircuitStore.getState()
  const rs = useResultsStore.getState()
  const ui = useUiStore.getState()
  const empty = cs.nodes.length === 0
  const selNodes = cs.nodes.filter((n) => n.selected)
  const selEdges = cs.edges.filter((e) => e.selected)
  const nothingSelected = selNodes.length + selEdges.length === 0
  const past = useCircuitStore.temporal.getState().pastStates.length
  const future = useCircuitStore.temporal.getState().futureStates.length
  const tsMode = rs.analysisMode === 'timeseries'
  const hasErrors = rs.issues.some((i) => i.severity === 'error')
  const bent = selEdges.filter((e) => e.data?.waypoints?.length)
  const inPlace = canSaveInPlace()

  const file: Menu = {
    label: 'File',
    items: [
      item('New', newCircuit, { title: 'Start a new empty circuit' }),
      item('Open…', () => ui.openDialog('library'), {
        keys: 'Mod+O',
        title: 'Open a circuit saved in this browser',
      }),
      item('Open file…', () => void openProjectFile(), {
        keys: 'Mod+Shift+O',
        title: 'Open a .oneline.json project file from disk',
      }),
      {
        kind: 'sub',
        label: 'Samples',
        disabled: samples.length === 0,
        items: samples.map((s) =>
          item(s.name, () => void openSample(s.id), { title: s.description, hint: `${s.nodes} elements` }),
        ),
      },
      item('Import .dss…', () => void importDss(), {
        title: 'Import OpenDSS .dss file(s) — select the main file plus anything it references (line codes, BusCoords csv)',
      }),
      sep,
      item('Save', save, { keys: 'Mod+S', title: 'Save to this browser' }),
      item('Save as…', () => ui.openDialog('saveAs'), { keys: 'Mod+Shift+S' }),
      item('Save to file', () => void saveToFile(), {
        keys: 'Mod+Alt+S',
        title: ui.fileHandle
          ? `Write over ${ui.fileHandle.name}`
          : inPlace
            ? 'Save as a .oneline.json file; later saves write back to the same file'
            : 'Download as a .oneline.json file',
      }),
      ...(inPlace
        ? [item('Save to file as…', () => void saveToFile(true), { title: 'Save as a different .oneline.json file' })]
        : []),
      sep,
      {
        kind: 'sub',
        label: 'Export',
        items: [
          item('OpenDSS (.dss)', () => void exportDss(), { title: 'A runnable OpenDSS script', disabled: empty }),
          sep,
          item('Image (SVG)', () => void exportImage('svg'), {
            title: 'An editable vector drawing, with the active overlay and a legend',
            disabled: empty,
          }),
          item('Image (PNG)', () => void exportImage('png'), {
            title: 'A 2× bitmap, with the active overlay and a legend',
            disabled: empty,
          }),
        ],
      },
    ],
  }

  const edit: Menu = {
    label: 'Edit',
    items: [
      item('Undo', () => undo(), { keys: 'Mod+Z', disabled: past === 0 }),
      item('Redo', () => redo(), { keys: 'Mod+Y', disabled: future === 0 }),
      sep,
      item('Cut', () => cutSelection(ops), { keys: 'Mod+X', disabled: selNodes.length === 0 }),
      item('Copy', copySelection, { keys: 'Mod+C', disabled: selNodes.length === 0 }),
      item('Paste', () => cs.pasteClipboard(), { keys: 'Mod+V' }),
      item('Duplicate', () => cs.duplicateSelection(), { keys: 'Mod+D', disabled: selNodes.length === 0 }),
      item('Delete', ops.deleteSelection, { keys: 'Delete', disabled: nothingSelected }),
      sep,
      item('Select all', selectAll, { keys: 'Mod+A', disabled: empty }),
      item('Select none', () => cs.clearSelection(), { keys: 'Mod+Shift+A', disabled: nothingSelected }),
    ],
  }

  const view: Menu = {
    label: 'View',
    items: [
      item('Zoom in', ops.zoomIn, { keys: 'Mod+=' }),
      item('Zoom out', ops.zoomOut, { keys: 'Mod+-' }),
      item('Fit', fitView, { keys: 'Mod+Shift+H' }),
      sep,
      item('Grid', () => ui.setShowGrid(!ui.showGrid), { checked: ui.showGrid }),
      item('Snap to grid', () => ui.setSnapToGrid(!ui.snapToGrid), { checked: ui.snapToGrid }),
      sep,
      item('Components', () => ui.togglePanel('palette2'), { checked: ui.panelOpen.palette2 }),
      item('Properties', () => ui.togglePanel('properties'), { checked: ui.panelOpen.properties }),
      item('Bottom panel', () => ui.togglePanel('bottom'), { checked: ui.panelOpen.bottom }),
    ],
  }

  const arrange: Menu = {
    label: 'Arrange',
    items: [
      item('Clean up layout', cleanUp, {
        keys: 'Mod+Shift+L',
        disabled: empty,
        title: 'Redraw the whole circuit as a tree: loads in a row beneath their bus, buses sized to fit, nothing overlapping. Undo restores the old arrangement.',
      }),
      sep,
      item('Rotate 90°', () => cs.rotateSelection(), { keys: 'R', disabled: selNodes.length === 0 }),
      item('Straighten', () => bent.forEach((e) => cs.setEdgeWaypoints(e.id, [])), {
        disabled: bent.length === 0,
        title: 'Remove the routing points from the selected wires and lines',
      }),
    ],
  }

  const analysis: Menu = {
    label: 'Analysis',
    items: [
      item('Snapshot', () => rs.setAnalysisMode('snapshot'), {
        radio: true,
        checked: !tsMode,
        title: 'Solve the base case on demand (or automatically)',
      }),
      item('Time series', () => rs.setAnalysisMode('timeseries'), {
        radio: true,
        checked: tsMode,
        title: 'Run daily/yearly simulations and scrub through the results',
      }),
      sep,
      item('Solve', solveNow, {
        keys: 'F5',
        disabled: tsMode || hasErrors || rs.solving || rs.tsRunning || empty,
      }),
      item('Auto-solve', toggleAutoSolve, { checked: rs.autoSolve && !tsMode, disabled: tsMode }),
      sep,
      {
        kind: 'sub',
        label: 'Overlay',
        items: OVERLAY_CHOICES.map((o) =>
          item(o.label, () => chooseOverlay(o.mode), { radio: true, checked: rs.overlay === o.mode, title: o.title }),
        ),
      },
    ],
  }

  const help: Menu = {
    label: 'Help',
    items: [
      item('Keyboard shortcuts', () => ui.openDialog('shortcuts'), { keys: '?' }),
      item('Documentation', () => window.open(DOCS_URL, '_blank', 'noopener')),
      item('Report an issue', () => window.open(ISSUES_URL, '_blank', 'noopener')),
      sep,
      item('About OpenDSS Designer', () => ui.openDialog('about')),
    ],
  }

  return [file, edit, view, arrange, analysis, help]
}
