import { renameComments, renameInPassthrough } from '../lib/passthroughRefs'
import { divideLength, midpoint, splitAt } from '../lib/splitLine'
import { flipOnScreen, type Axis } from '../lib/arrange'
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import { temporal } from 'zundo'
import { create } from 'zustand'
import { defaultLineParams, defaultParams, isAnnotation, isNote, nextName, NODE_SIZE, SYMBOL_PITCH } from '../lib/defaults'
import { insertPoint, interiorPoints, simplifyCollinear } from '../lib/edgeGeometry'
import type { CircuitJSON, CircuitNodeJSON, EdgeKind, LoadShapeJSON, NodeType, Params,
  GeoPoint,
  HistoryEntryJSON,
  LimitsJSON,
  LineCodeJSON,
  LineGeometryJSON,
  AllocationJSON,
  LoadLevelJSON,
  PassthroughJSON,
  ScenarioJSON,
  StudyInfoJSON,
  TccCurveJSON,
  Winding,
  WireDataJSON,
  XYCurveJSON,
} from '../types/circuit'
import { SCHEMA_VERSION } from '../lib/schema'
import { limitsOf } from '../lib/limits'
import { applyScenario, diffScenario, newScenarioId } from '../lib/scenarios'
import { setLimitsSource, useResultsStore } from './resultsStore'

export interface XY {
  x: number
  y: number
}

export type AppNode = Node<{ params: Params; geo?: GeoPoint }>
export type AppEdge = Edge<{ params: Params; waypoints?: XY[]; geometry?: GeoPoint[] }>

export interface CircuitState {
  name: string
  nodes: AppNode[]
  edges: AppEdge[]
  busNames: Record<string, string>
  /** Circuit-level loadshape library, keyed by shape name. Always replaced
   *  wholesale (never mutated) so undo can compare it by reference. */
  loadShapes: Record<string, LoadShapeJSON>
  tccCurves: Record<string, TccCurveJSON>
  /** Conductor library, keyed by line-code name; a line's `linecode` param
   *  naming an entry takes its impedance from it. */
  lineCodes: Record<string, LineCodeJSON>
  /** What an imported file had that the diagram does not show. */
  passthrough: PassthroughJSON[]
  comments: Record<string, string>
  setPassthrough: (entries: PassthroughJSON[]) => void
  /** Abnormal-condition criteria; null = DEFAULT_LIMITS (lib/limits). */
  limits: LimitsJSON | null
  /** Replacing the limits changes what the results flag, so they go stale. */
  setLimits: (limits: LimitsJSON | null) => void
  /** Voltage bases (kV line-to-line) from an imported file; null = derived. */
  voltageBases: number[] | null
  setVoltageBases: (bases: number[] | null) => void
  /** Coordinate system of every `geo` and `geometry`; null = unknown. */
  crs: string | null
  setCrs: (crs: string | null) => void
  /** Move elements on the map (geographic view); positions in `crs`. Null
   *  takes an element's own coordinate away, so the map places it from its
   *  neighbours again. */
  setGeo: (moves: Record<string, GeoPoint | null>) => void
  /** The study report's title block; cosmetic, results stay valid. */
  study: StudyInfoJSON | null
  setStudy: (study: StudyInfoJSON | null) => void
  /** Conductors and pole configurations (OpenDSS WireData, LineGeometry). */
  wireData: Record<string, WireDataJSON>
  setWireData: (name: string, spec: WireDataJSON) => void
  removeWireData: (name: string) => void
  lineGeometries: Record<string, LineGeometryJSON>
  setLineGeometry: (name: string, spec: LineGeometryJSON) => void
  removeLineGeometry: (name: string) => void
  /** The audit trail: every parameter change, newest last, capped. Not
   *  undoable: an undo is itself a change worth knowing about. */
  history: HistoryEntryJSON[]
  clearChangeLog: () => void
  /** Inverter volt-var / volt-watt curves (OpenDSS XYCurve), by name. */
  xyCurves: Record<string, XYCurveJSON>
  setXyCurve: (name: string, spec: XYCurveJSON) => void
  removeXyCurve: (name: string) => void
  /** Tag names offered on loads; any tag is allowed. */
  tagVocabulary: string[]
  setTagVocabulary: (tags: string[]) => void
  /** Metered-zone load allocations (factor applied at compile time). */
  allocations: AllocationJSON[]
  setAllocations: (allocations: AllocationJSON[]) => void
  /** The load conditions studies run at; null = rated only. */
  loadLevels: LoadLevelJSON[] | null
  setLoadLevels: (levels: LoadLevelJSON[] | null) => void
  /** The level the next solve uses (a name); null is rated. */
  activeLevel: string | null
  setActiveLevel: (name: string | null) => void
  /** Alternatives to the base circuit, as deltas. While one is open its
   *  effective drawing is what `nodes`/`edges` hold and `scenarioBase`
   *  keeps the base; leaving it diffs the two back into the deltas. */
  scenarios: ScenarioJSON[]
  activeScenario: string | null
  scenarioBase: { nodes: AppNode[]; edges: AppEdge[] } | null
  addScenario: (name: string, description?: string) => string
  updateScenario: (id: string, patch: Partial<Pick<ScenarioJSON, 'name' | 'description'>>) => void
  removeScenario: (id: string) => void
  duplicateScenario: (id: string) => string | null
  /** Move a scenario up (-1) or down (+1) the list. */
  moveScenario: (id: string, delta: -1 | 1) => void
  /** Make a scenario the base case: the base becomes its drawing, it is
   *  removed, and every other scenario is rebased so it still describes
   *  the same drawing it did. Not undoable (like switching). */
  promoteScenario: (id: string) => void
  /** Open a scenario for editing and solving (null returns to the base). */
  activateScenario: (id: string | null) => void
  placementType: NodeType | null
  connectMode: EdgeKind
  /** True when there are changes not yet saved to a project file. */
  dirty: boolean
  markSaved: () => void
  /** Library entry this document was opened from or saved to; null = unsaved. */
  projectId: string | null
  setProjectId: (id: string | null) => void

  onNodesChange: (changes: NodeChange<AppNode>[]) => void
  onEdgesChange: (changes: EdgeChange<AppEdge>[]) => void
  onConnect: (conn: Connection) => void
  /** Returns the new node's id. A note ends placement mode: it is typed
   *  into straight away, not dropped by the dozen. */
  addNodeAt: (type: NodeType, pos: XY) => string
  /** A note centred on `pos`, its arrow on `target` when given, selected. */
  addNote: (pos: XY, target?: string) => string
  /** Notes are drawing, not circuit: text, size and arrow never make the
   *  results stale. */
  setNoteWidth: (id: string, width: number) => void
  /** A zone drawn by dragging out its rectangle (flow units), selected. */
  addZoneAt: (rect: { x: number; y: number; w: number; h: number }) => string
  setZoneSize: (id: string, width: number, height: number) => void
  addBusbarAt: (pos: XY, width: number) => void
  updateNodeParams: (id: string, patch: Params) => void
  /** Replace a transformer's winding list. Going from three windings to two
   *  removes terminal t3, so any wire on it goes with it -- an edge on a
   *  handle that no longer exists would render nowhere and still compile. */
  setTransformerWindings: (id: string, windings: Winding[]) => void
  updateEdgeParams: (id: string, patch: Params) => void
  /** Move one end of an existing edge to another terminal (the grab
   *  gesture); the edge keeps its id, kind and parameters. */
  reconnectEdgeEnd: (id: string, end: EdgeEnd, nodeId: string, handleId: string) => void
  setEdgeWaypoints: (id: string, waypoints: XY[]) => void
  /** Add a routing point where the user clicked. `rendered` is the polyline
   *  the edge is currently drawn as (endpoints included), read off the screen
   *  by the caller; passing it keeps the edge's shape exactly as it looks. */
  addEdgeWaypoint: (id: string, pos: XY, rendered?: XY[] | null) => void
  setBusbarWidth: (id: string, width: number) => void
  setName: (name: string) => void
  setPlacement: (t: NodeType | null) => void
  setConnectMode: (m: EdgeKind) => void
  selectOnly: (kind: 'node' | 'edge', id: string) => void
  /** Nothing selected: an exported drawing must not carry a blue outline. */
  clearSelection: () => void
  /** Replace the selection with exactly these elements. */
  selectMany: (picked: { nodeIds: string[]; edgeIds: string[] }) => void
  /** One parameter patch per element, computed from its current params,
   *  applied to every listed node and line edge as a single undo step. A
   *  null patch leaves that element alone. */
  bulkUpdateParams: (
    picked: { nodeIds: string[]; edgeIds: string[] },
    patch: (params: Params) => Params | null,
  ) => void
  /** Take positions, busbar widths and busbar handles from a laid-out copy of
   *  this circuit (lib/layout autoLayout over toCircuitJSON), as one undo
   *  step. Rotations are reset and routing points dropped: the drawing is
   *  being redone, not nudged. */
  applyLayout: (laidOut: CircuitJSON) => void
  mergeBusNames: (names: Record<string, string>) => void
  setLoadShape: (name: string, spec: LoadShapeJSON) => void
  setTccCurve: (name: string, spec: TccCurveJSON) => void
  removeTccCurve: (name: string) => void
  setLineCode: (name: string, spec: LineCodeJSON) => void
  /** Delete a code; lines on it keep the tag but compile from their own
   *  r1/x1/r0/x0 (or the defaults), which validation points out. */
  removeLineCode: (name: string) => void
  /** Rename a code and re-point every line that uses it. */
  renameLineCode: (oldName: string, newName: string) => void
  /** Delete a shape and clear any element params still referencing it. */
  deleteLoadShape: (name: string) => void
  /** Rename a shape and rewrite element references to it. */
  renameLoadShape: (oldName: string, newName: string) => void
  loadCircuit: (c: CircuitJSON) => void
  clearAll: () => void

  /** Copy the selection to the in-memory clipboard; returns elements copied. */
  copySelection: () => number
  pasteClipboard: () => void
  duplicateSelection: () => void
  /** Rotate the given symbol nodes 90° clockwise (busbars are skipped). */
  rotateNodes: (ids: string[]) => void
  rotateSelection: () => void
  /** Mirror symbols as they appear on screen (see lib/arrange.flipOnScreen). */
  flipNodes: (ids: string[], axis: Axis) => void
  /** Move many nodes at once, as one undo step (Align, Distribute). */
  moveNodes: (positions: Record<string, XY>) => void
  /** Split a line with a new busbar at `click` (flow coordinates; the
   *  midpoint when omitted), dividing its length in proportion. `rendered`
   *  is the polyline on screen, as for addEdgeWaypoint. Returns the new
   *  busbar's id. */
  splitLine: (edgeId: string, click?: XY | null, rendered?: XY[] | null) => string | null
}

// Ids used to be `Date.now()` plus a counter that reset on every page load,
// which is unique within one editing session and collides across them. That is
// fine while a circuit only ever lives in one file, and a landmine as soon as
// elements are copied between documents or two clients write to one library:
// `busNames` is keyed by `nodeId:handleId`, so an id collision silently
// reassigns bus names. 10 random base36 characters is ~51 bits -- negligible
// collision odds at any circuit size, and short enough not to bloat the
// document, since every id appears several times across nodes and edges.
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
function randomSuffix(len = 10): string {
  const g = globalThis.crypto
  if (g?.getRandomValues) {
    const buf = new Uint8Array(len)
    g.getRandomValues(buf)
    return Array.from(buf, (b) => ID_CHARS[b % ID_CHARS.length]).join('')
  }
  let out = ''
  for (let i = 0; i < len; i++) {
    out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]
  }
  return out
}
const newId = (p: string) => `${p}_${randomSuffix()}`

function markStale() {
  useResultsStore.getState().markStale()
}

/** Drop the undo timeline. Every path that swaps in a different document must
 *  call this, or Ctrl+Z walks backwards into the previous one. */
function clearHistory() {
  useCircuitStore.temporal.getState().clear()
}

// ---------------------------------------------------------------------------
// Undo gestures: while a continuous gesture (drag, resize) is in progress the
// temporal store records only the first change, so the whole gesture undoes
// as one step. Everything outside a gesture records per action.
let inGesture = false
let gestureRecorded = false
export function beginGesture(): void {
  inGesture = true
  gestureRecorded = false
}
export function endGesture(): void {
  inGesture = false
}

// ---------------------------------------------------------------------------
// Clipboard for copy/paste/duplicate — in-memory, survives circuit switches.
interface Clipboard {
  nodes: AppNode[]
  edges: AppEdge[]
}
let clipboard: Clipboard | null = null
let pasteCount = 0

const NAME_PREFIX: Record<string, string> = {
  vsource: 'SRC',
  busbar: 'BUS',
  transformer: 'T',
  regulator: 'REG',
  load: 'LOAD',
  breaker: 'BRK',
  fuse: 'FU',
  recloser: 'REC',
  relay: 'RLY',
  capacitor: 'CAP',
  generator: 'GEN',
  pvsystem: 'PV',
  storage: 'BAT',
}

const PASTE_OFFSET = 30

/** Every element name currently in use on the canvas. */
function takenNames(s: Pick<CircuitState, 'nodes' | 'edges'>): Set<string> {
  const names = new Set<string>()
  for (const n of s.nodes) if (typeof n.data.params.name === 'string') names.add(n.data.params.name)
  for (const e of s.edges) {
    const nm = e.data?.params?.name
    if (typeof nm === 'string') names.add(nm)
  }
  return names
}

/** `base` itself if free, else base2, base3, ... */
function uniqueSuffixed(base: string, taken: Set<string>): string {
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`
  taken.add(name)
  return name
}

function uniqueName(prefix: string, taken: Set<string>): string {
  let name = nextName(prefix)
  while (taken.has(name)) name = nextName(prefix)
  taken.add(name)
  return name
}

/** Fresh copies of a node/edge set: new ids, remapped endpoints, regenerated
 *  names (so OpenDSS never sees duplicates), positions shifted by offset. */
function materializeClones(clip: Clipboard, offset: XY, taken: Set<string>): Clipboard {
  const idMap = new Map<string, string>()
  const nodes: AppNode[] = clip.nodes.map((n) => {
    const id = newId('n')
    idMap.set(n.id, id)
    const params: Params = { ...n.data.params }
    if (typeof params.name === 'string') {
      params.name = uniqueName(NAME_PREFIX[n.type as string] ?? 'EL', taken)
    }
    return {
      ...n,
      id,
      selected: true,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      data: { params },
    }
  })
  const edges: AppEdge[] = clip.edges.map((e) => {
    const params: Params = { ...(e.data?.params ?? {}) }
    if (typeof params.name === 'string') params.name = uniqueName('LN', taken)
    return {
      ...e,
      id: newId('e'),
      selected: true,
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
      data: {
        params,
        waypoints: e.data?.waypoints?.map((w) => ({ x: w.x + offset.x, y: w.y + offset.y })),
      },
    }
  })
  return { nodes, edges }
}

/** Selected nodes plus the edges whose BOTH endpoints are selected. */
function selectionClipboard(s: Pick<CircuitState, 'nodes' | 'edges'>): Clipboard | null {
  const ids = new Set(s.nodes.filter((n) => n.selected).map((n) => n.id))
  if (!ids.size) return null
  return structuredClone({
    nodes: s.nodes.filter((n) => ids.has(n.id)),
    edges: s.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  })
}

/** Which end of an edge a gesture is acting on. */
export type EdgeEnd = 'source' | 'target'

export function terminalKey(nodeId: string, handleId: string): string {
  return `${nodeId}:${handleId}`
}

// Terminal -> edge ids, memoized on the edges array identity: every Terminal
// component asks this on every store update, so it must not rescan the edge
// list once per handle.
/** A circuit this big is drawn sparingly: only the elements in view, and
 *  only the busbar terminals that hold a wire (see BusbarNode). Below it
 *  the drawing behaves exactly as it always has. */
export const LARGE_CIRCUIT = 1500

let handlesCache: { edges: AppEdge[]; map: Map<string, string> } | null = null

/** The handles on each node that hold a wire, as a sorted comma-joined
 *  string (a cheap value to subscribe to). */
export function handlesInUse(edges: AppEdge[], nodeId: string): string {
  if (handlesCache?.edges !== edges) {
    const sets = new Map<string, Set<string>>()
    const add = (n: string, h: string | null | undefined) => {
      let s = sets.get(n)
      if (!s) sets.set(n, (s = new Set()))
      s.add(h ?? 't1')
    }
    for (const e of edges) {
      add(e.source, e.sourceHandle)
      add(e.target, e.targetHandle)
    }
    const map = new Map<string, string>()
    for (const [n, s] of sets) map.set(n, [...s].sort().join(','))
    handlesCache = { edges, map }
  }
  return handlesCache.map.get(nodeId) ?? ''
}

let termMapCache: { edges: AppEdge[]; map: Map<string, string[]> } | null = null

/** Map of "<nodeId>:<handleId>" to the ids of the edges landing there.
 *  Edges saved without an explicit handle default to t1, matching the
 *  backend's terminal convention. */
export function terminalEdgeMap(edges: AppEdge[]): Map<string, string[]> {
  if (termMapCache?.edges === edges) return termMapCache.map
  const map = new Map<string, string[]>()
  const add = (nodeId: string, handleId: string | null | undefined, id: string) => {
    const key = terminalKey(nodeId, handleId ?? 't1')
    const list = map.get(key)
    if (list) list.push(id)
    else map.set(key, [id])
  }
  for (const e of edges) {
    add(e.source, e.sourceHandle, e.id)
    add(e.target, e.targetHandle, e.id)
  }
  termMapCache = { edges, map }
  return map
}

/** Ids of the edges attached to one terminal. */
export function edgesAtTerminal(
  s: Pick<CircuitState, 'edges'>,
  nodeId: string,
  handleId: string,
): string[] {
  return terminalEdgeMap(s.edges).get(terminalKey(nodeId, handleId)) ?? []
}

/** Number of connection handles per row a busbar of a given width exposes.
 *  Rows: b<i> along the top edge, c<i> along the bottom edge. */
export function busbarHandleCount(width: number): number {
  return Math.max(2, Math.floor(width / SYMBOL_PITCH))
}

const snapGrid = (v: number) => Math.round(v / 10) * 10

const snapPosition = (p: XY): XY => ({ x: snapGrid(p.x), y: snapGrid(p.y) })

/** Busbar widths stay on the symbol pitch so the handles, spaced width/count
 *  apart, land exactly on the grid alongside every symbol terminal. */
export function snapBusbarWidth(width: number): number {
  return Math.max(60, Math.round(width / SYMBOL_PITCH) * SYMBOL_PITCH)
}

/** Why a proposed connection is not allowed, or null if it is fine. */
export function validateConnection(
  conn: { source: string | null; sourceHandle?: string | null; target: string | null; targetHandle?: string | null },
  state?: Pick<CircuitState, 'nodes' | 'edges' | 'connectMode'>,
  /** Edge exempt from the duplicate check — the one being re-routed, which
   *  would otherwise report itself as an existing connection. */
  ignoreEdgeId?: string,
): string | null {
  const s = state ?? useCircuitStore.getState()
  if (!conn.source || !conn.target) return 'Connection is missing an endpoint.'
  if (conn.source === conn.target) return 'An element cannot be connected to itself.'
  const src = s.nodes.find((n) => n.id === conn.source)
  const tgt = s.nodes.find((n) => n.id === conn.target)
  if (!src || !tgt) return 'Connection references a missing element.'
  if (src.type === 'busbar' && tgt.type === 'busbar' && s.connectMode === 'wire') {
    return 'Two busbars cannot be joined by a plain wire — use a Line or a breaker between them.'
  }
  const dup = s.edges.some(
    (e) =>
      e.id !== ignoreEdgeId &&
      ((e.source === conn.source &&
        e.target === conn.target &&
        (e.sourceHandle ?? null) === (conn.sourceHandle ?? null) &&
        (e.targetHandle ?? null) === (conn.targetHandle ?? null)) ||
        (e.source === conn.target &&
          e.target === conn.source &&
          (e.sourceHandle ?? null) === (conn.targetHandle ?? null) &&
          (e.targetHandle ?? null) === (conn.sourceHandle ?? null))),
  )
  if (dup) return 'These terminals are already connected.'
  return null
}

function nodeCenter(n: AppNode): XY {
  const size = NODE_SIZE[(n.type as NodeType) ?? 'load']
  const w = (n.width as number) ?? size.w
  return { x: n.position.x + w / 2, y: n.position.y + size.h / 2 }
}

/** Passthrough text and comments after an element rename, or nothing when
 *  the name did not change. */
function renamed(
  s: Pick<CircuitState, 'passthrough' | 'comments'>,
  type: string,
  oldName: unknown,
  newName: unknown,
): Partial<Pick<CircuitState, 'passthrough' | 'comments'>> {
  if (typeof oldName !== 'string' || typeof newName !== 'string' || oldName === newName) return {}
  return {
    passthrough: renameInPassthrough(s.passthrough, type, oldName, newName),
    comments: renameComments(s.comments, type, oldName, newName),
  }
}

export function toCircuitJSON(
  s: Pick<
    CircuitState,
    'name' | 'nodes' | 'edges' | 'busNames' | 'loadShapes' | 'tccCurves' | 'lineCodes'
  > & Partial<Pick<CircuitState, 'passthrough' | 'comments' | 'limits' | 'study' | 'voltageBases' | 'crs'
    | 'xyCurves' | 'loadLevels' | 'activeLevel' | 'scenarios' | 'activeScenario' | 'scenarioBase'
    | 'wireData' | 'lineGeometries' | 'history' | 'tagVocabulary' | 'allocations'>>,
): CircuitJSON {
  // While a scenario is open the drawing on screen is the scenario's; the
  // document holds the base and the deltas, refreshed from the drawing.
  const inScenario = !!(s.activeScenario && s.scenarioBase)
  const nodes = inScenario ? s.scenarioBase!.nodes : s.nodes
  const edges = inScenario ? s.scenarioBase!.edges : s.edges
  const scenarios = inScenario
    ? (s.scenarios ?? []).map((sc) =>
        sc.id === s.activeScenario ? { ...sc, ...diffScenario(s.scenarioBase!, { nodes: s.nodes, edges: s.edges }) } : sc,
      )
    : (s.scenarios ?? [])
  return {
    version: SCHEMA_VERSION,
    name: s.name,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as NodeType,
      position: n.position,
      width: (n.width ?? (n.style?.width as number)) || null,
      // Only a zone has a height of its own; every other box is its type's.
      ...(n.type === 'zone' ? { height: (n.height ?? (n.style?.height as number)) || null } : {}),
      params: n.data.params,
      ...(n.data.geo ? { geo: n.data.geo } : {}),
    })),
    edges: edges.map((e) => ({
      id: e.id,
      type: (e.type as EdgeKind) ?? 'wire',
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      params: e.data?.params ?? {},
      waypoints: e.data?.waypoints?.length ? e.data.waypoints : null,
      ...(e.data?.geometry?.length ? { geometry: e.data.geometry } : {}),
    })),
    busNames: s.busNames,
    loadShapes: s.loadShapes,
    tccCurves: s.tccCurves,
    lineCodes: s.lineCodes,
    // Only written when there is something: a circuit drawn in the editor
    // saves exactly as it always has.
    ...(s.passthrough?.length ? { passthrough: s.passthrough } : {}),
    ...(s.comments && Object.keys(s.comments).length ? { comments: s.comments } : {}),
    ...(s.voltageBases?.length ? { voltageBases: s.voltageBases } : {}),
    ...(s.crs ? { crs: s.crs } : {}),
    ...(s.limits ? { limits: s.limits } : {}),
    ...(s.study ? { study: s.study } : {}),
    ...(s.xyCurves && Object.keys(s.xyCurves).length ? { xyCurves: s.xyCurves } : {}),
    ...(s.wireData && Object.keys(s.wireData).length ? { wireData: s.wireData } : {}),
    ...(s.lineGeometries && Object.keys(s.lineGeometries).length ? { lineGeometries: s.lineGeometries } : {}),
    ...(s.history?.length ? { history: s.history } : {}),
    ...(s.loadLevels?.length ? { loadLevels: s.loadLevels } : {}),
    ...(s.activeLevel ? { activeLevel: s.activeLevel } : {}),
    ...(scenarios.length ? { scenarios } : {}),
    ...(s.activeScenario ? { activeScenario: s.activeScenario } : {}),
    ...(s.tagVocabulary?.length ? { tagVocabulary: s.tagVocabulary } : {}),
    ...(s.allocations?.length ? { allocations: s.allocations } : {}),
  }
}

/** A scenario's stored additions as drawing nodes and edges. */
function drawingFromJSON(nodes: CircuitNodeJSON[], edges: CircuitJSON['edges']) {
  return fromCircuitJSON({ version: SCHEMA_VERSION, name: '', nodes, edges, busNames: {}, loadShapes: {} })
}

function initialSize(n: CircuitNodeJSON): { initialWidth: number; initialHeight: number } {
  const { w, h } = NODE_SIZE[n.type] ?? NODE_SIZE.load
  const turned = (Number(n.params?.rotation) || 0) % 180 !== 0
  return turned ? { initialWidth: h, initialHeight: w } : { initialWidth: w, initialHeight: h }
}

export function fromCircuitJSON(c: CircuitJSON): { nodes: AppNode[]; edges: AppEdge[] } {
  const nodes: AppNode[] = c.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    // Re-snap on load. Positions are top-left corners, and circuits saved
    // before the symbol boxes were put on SYMBOL_PITCH recorded corners that
    // no longer put the terminal on the grid — leaving every busbar wire with
    // a few pixels of bend until the node was dragged once. Snapping here
    // moves a node by at most half a grid step and makes old files open
    // aligned. Busbar widths are re-snapped for the same reason.
    position: snapPosition(n.position ?? { x: 0, y: 0 }),
    data: n.geo ? { params: n.params, geo: n.geo } : { params: n.params },
    ...(n.type === 'busbar'
      ? {
          width: snapBusbarWidth(n.width ?? NODE_SIZE.busbar.w),
          height: NODE_SIZE.busbar.h,
        }
      : {}),
    // A note keeps the width it was given; its height follows its text.
    ...(n.type === 'note' ? { width: n.width ?? NODE_SIZE.note.w } : {}),
    // A zone is the rectangle it was drawn as.
    ...(n.type === 'zone'
      ? { width: n.width ?? NODE_SIZE.zone.w, height: n.height ?? NODE_SIZE.zone.h }
      : {}),
    // A symbol's box before React Flow has measured it. A large circuit only
    // renders what is in view, so most symbols are never measured, and
    // without a size they count for nothing when the view is fitted.
    ...(n.type !== 'busbar' && n.type !== 'note' && n.type !== 'zone' ? initialSize(n) : {}),
  }))
  const edges: AppEdge[] = c.edges.map((e) => ({
    id: e.id,
    type: e.type,
    source: e.source,
    sourceHandle: e.sourceHandle ?? undefined,
    target: e.target,
    targetHandle: e.targetHandle ?? undefined,
    data: {
      params: e.params ?? {},
      waypoints: e.waypoints ?? undefined,
      ...(e.geometry?.length ? { geometry: e.geometry } : {}),
    },
  }))
  return { nodes, edges }
}

export const useCircuitStore = create<CircuitState>()(
  temporal(
    (set, get) => ({
      name: 'my-circuit',
      nodes: [],
      edges: [],
      busNames: {},
      loadShapes: {},
      tccCurves: {},
      lineCodes: {},
      passthrough: [],
      comments: {},
      setPassthrough: (passthrough) => {
        set({ passthrough, dirty: true })
        markStale()
      },
      limits: null,
      setLimits: (limits) => {
        set({ limits, dirty: true })
        markStale()
      },
      voltageBases: null,
      setVoltageBases: (voltageBases) => {
        set({ voltageBases: voltageBases?.length ? voltageBases : null, dirty: true })
        markStale()
      },
      crs: null,
      // Where things are on the map changes no result.
      setCrs: (crs) => set({ crs: crs || null, dirty: true }),
      setGeo: (moves) =>
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (!(n.id in moves)) return n
            const geo = moves[n.id]
            if (geo) return { ...n, data: { ...n.data, geo } }
            const { geo: _gone, ...data } = n.data
            return { ...n, data }
          }),
          dirty: true,
        })),
      study: null,
      setStudy: (study) => set({ study, dirty: true }),
      wireData: {},
      setWireData: (name, spec) => {
        set({ wireData: { ...get().wireData, [name]: spec }, dirty: true })
        markStale()
      },
      removeWireData: (name) => {
        const { [name]: _gone, ...rest } = get().wireData
        set({ wireData: rest, dirty: true })
        markStale()
      },
      lineGeometries: {},
      setLineGeometry: (name, spec) => {
        set({ lineGeometries: { ...get().lineGeometries, [name]: spec }, dirty: true })
        markStale()
      },
      removeLineGeometry: (name) => {
        const { [name]: _gone, ...rest } = get().lineGeometries
        set({ lineGeometries: rest, dirty: true })
        markStale()
      },
      history: [],
      clearChangeLog: () => set({ history: [], dirty: true }),
      xyCurves: {},
      setXyCurve: (name, spec) => {
        set({ xyCurves: { ...get().xyCurves, [name]: spec }, dirty: true })
        markStale()
      },
      removeXyCurve: (name) => {
        const { [name]: _gone, ...rest } = get().xyCurves
        set({ xyCurves: rest, dirty: true })
        markStale()
      },
      tagVocabulary: [],
      setTagVocabulary: (tags) => {
        const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
        set({ tagVocabulary: clean, dirty: true })
      },
      allocations: [],
      setAllocations: (allocations) => {
        set({ allocations, dirty: true })
        markStale()
      },
      loadLevels: null,
      setLoadLevels: (levels) => {
        const loadLevels = levels?.length ? levels : null
        const active = get().activeLevel
        set({
          loadLevels,
          // A level that was renamed or removed leaves the solve at rated.
          activeLevel: active && loadLevels?.some((l) => l.name === active) ? active : null,
          dirty: true,
        })
        markStale()
      },
      activeLevel: null,
      setActiveLevel: (name) => {
        const levels = get().loadLevels
        const activeLevel = name && levels?.some((l) => l.name === name) ? name : null
        if (activeLevel === get().activeLevel) return
        set({ activeLevel, dirty: true })
        markStale()
      },
      scenarios: [],
      activeScenario: null,
      scenarioBase: null,
      addScenario: (name, description = '') => {
        const id = newScenarioId(get().scenarios.map((sc) => sc.id))
        const scenario: ScenarioJSON = {
          id, name: name.trim() || id, description,
          overrides: {}, addedNodes: [], addedEdges: [], removed: [],
        }
        set({ scenarios: [...get().scenarios, scenario], dirty: true })
        get().activateScenario(id)
        return id
      },
      updateScenario: (id, patch) =>
        set({
          scenarios: get().scenarios.map((sc) => (sc.id === id ? { ...sc, ...patch } : sc)),
          dirty: true,
        }),
      removeScenario: (id) => {
        if (get().activeScenario === id) get().activateScenario(null)
        set({ scenarios: get().scenarios.filter((sc) => sc.id !== id), dirty: true })
      },
      duplicateScenario: (id) => {
        const s = get()
        // The open scenario's deltas are only up to date once it is closed.
        const source = s.activeScenario === id && s.scenarioBase
          ? { ...s.scenarios.find((sc) => sc.id === id)!, ...diffScenario(s.scenarioBase, { nodes: s.nodes, edges: s.edges }) }
          : s.scenarios.find((sc) => sc.id === id)
        if (!source) return null
        const copyId = newScenarioId(s.scenarios.map((sc) => sc.id))
        set({
          scenarios: [...s.scenarios, { ...JSON.parse(JSON.stringify(source)), id: copyId, name: `${source.name} (copy)` }],
          dirty: true,
        })
        return copyId
      },
      moveScenario: (id, delta) => {
        const list = [...get().scenarios]
        const i = list.findIndex((sc) => sc.id === id)
        const j = i + delta
        if (i < 0 || j < 0 || j >= list.length) return
        ;[list[i], list[j]] = [list[j], list[i]]
        set({ scenarios: list, dirty: true })
      },
      promoteScenario: (id) => {
        // Close whatever is open first so every scenario's deltas are current
        // and nodes/edges hold the base.
        get().activateScenario(null)
        const s = get()
        const target = s.scenarios.find((sc) => sc.id === id)
        if (!target) return
        const oldBase = { nodes: s.nodes, edges: s.edges }
        const newBase = applyScenario(oldBase, target, drawingFromJSON)
        const scenarios = s.scenarios
          .filter((sc) => sc.id !== id)
          .map((sc) => ({ ...sc, ...diffScenario(newBase, applyScenario(oldBase, sc, drawingFromJSON)) }))
        set({ nodes: newBase.nodes, edges: newBase.edges, scenarios, dirty: true })
        clearHistory()
        markStale()
      },
      activateScenario: (id) => {
        const s = get()
        if (id === s.activeScenario) return
        let nodes = s.nodes
        let edges = s.edges
        let scenarios = s.scenarios
        if (s.activeScenario && s.scenarioBase) {
          // Leaving: what changed on screen becomes the scenario's deltas,
          // and the base comes back.
          const deltas = diffScenario(s.scenarioBase, { nodes, edges })
          scenarios = scenarios.map((sc) => (sc.id === s.activeScenario ? { ...sc, ...deltas } : sc))
          nodes = s.scenarioBase.nodes
          edges = s.scenarioBase.edges
        }
        const target = id ? scenarios.find((sc) => sc.id === id) : undefined
        if (!target) {
          set({ nodes, edges, scenarios, activeScenario: null, scenarioBase: null, dirty: true })
        } else {
          const base = { nodes, edges }
          const effective = applyScenario(base, target, drawingFromJSON)
          set({
            nodes: effective.nodes,
            edges: effective.edges,
            scenarios,
            activeScenario: target.id,
            scenarioBase: base,
            dirty: true,
          })
        }
        // Undo must not cross the switch: an undo of "the whole drawing
        // changed" would put the base's elements into the scenario.
        clearHistory()
        markStale()
      },
      placementType: null,
      connectMode: 'wire',
      dirty: false,
      markSaved: () => set({ dirty: false }),
      projectId: null,
      setProjectId: (projectId) => set({ projectId }),

      onNodesChange: (changes) => {
        const before = get().nodes
        set({ nodes: applyNodeChanges(changes, before) })
        const edits = changes.filter((ch) => ch.type !== 'select' && ch.type !== 'dimensions')
        if (edits.length) {
          set({ dirty: true })
          // Moving, resizing or deleting a note or a zone changes nothing
          // electrical.
          const noteIds = new Set(before.filter(isAnnotation).map((n) => n.id))
          const electrical = edits.some((ch) =>
            ch.type === 'add' ? !isAnnotation(ch.item) : !noteIds.has(ch.id),
          )
          if (electrical) markStale()
        }
      },
      onEdgesChange: (changes) => {
        set({ edges: applyEdgeChanges(changes, get().edges) })
        if (changes.some((ch) => ch.type !== 'select')) {
          set({ dirty: true })
          markStale()
        }
      },
      onConnect: (conn) => {
        const reason = validateConnection(conn, get())
        if (reason) {
          useResultsStore.getState().setFlash(reason)
          return
        }
        // Connections drawn while a placement mode is active default to plain
        // wire — you're dropping components and hooking them up as you go.
        const kind = get().placementType ? 'wire' : get().connectMode
        const edge: AppEdge = {
          id: newId('e'),
          type: kind,
          source: conn.source,
          sourceHandle: conn.sourceHandle ?? undefined,
          target: conn.target,
          targetHandle: conn.targetHandle ?? undefined,
          data: { params: kind === 'line' ? defaultLineParams() : {} },
        }
        set({ edges: [...get().edges, edge], dirty: true })
        markStale()
      },
      // Placement mode is sticky: keep dropping elements until Escape or the
      // palette item is toggled off.
      addNodeAt: (type, pos) => {
        const size = NODE_SIZE[type]
        const node: AppNode = {
          id: newId('n'),
          type,
          // Snap the corner, not the click point: React Flow's snapGrid moves
          // the corner on the first drag, so a node dropped on a half-grid
          // corner would visibly jump and lose terminal alignment.
          position: { x: snapGrid(pos.x - size.w / 2), y: snapGrid(pos.y - size.h / 2) },
          data: { params: defaultParams(type) },
          ...(type === 'busbar' ? { width: size.w, height: size.h } : {}),
          ...(type === 'note' ? { width: size.w } : {}),
          ...(type === 'zone' ? { width: size.w, height: size.h } : {}),
        }
        if (type === 'note' || type === 'zone') {
          set({
            nodes: [...get().nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), { ...node, selected: true }],
            placementType: null,
            dirty: true,
          })
          return node.id
        }
        set({ nodes: [...get().nodes, node], dirty: true })
        markStale()
        return node.id
      },
      addNote: (pos, target) => {
        const id = get().addNodeAt('note', pos)
        if (target) {
          set({
            nodes: get().nodes.map((n) =>
              n.id === id ? { ...n, data: { params: { ...n.data.params, target } } } : n,
            ),
          })
        }
        return id
      },
      setNoteWidth: (id, width) => {
        const w = Math.max(60, snapGrid(width))
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, width: w, style: undefined } : n)),
          dirty: true,
        })
      },
      addZoneAt: (rect) => {
        const node: AppNode = {
          id: newId('n'),
          type: 'zone',
          position: { x: snapGrid(rect.x), y: snapGrid(rect.y) },
          width: Math.max(60, snapGrid(rect.w)),
          height: Math.max(40, snapGrid(rect.h)),
          data: { params: defaultParams('zone') },
        }
        set({
          nodes: [...get().nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), { ...node, selected: true }],
          placementType: null,
          dirty: true,
        })
        return node.id
      },
      setZoneSize: (id, width, height) => {
        const w = Math.max(60, snapGrid(width))
        const h = Math.max(40, snapGrid(height))
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, width: w, height: h, style: undefined } : n)),
          dirty: true,
        })
      },
      // Drag-sized busbar: pos is the LEFT edge of the bar (vertically centered).
      addBusbarAt: (pos, width) => {
        const node: AppNode = {
          id: newId('n'),
          type: 'busbar',
          position: { x: snapGrid(pos.x), y: snapGrid(pos.y - NODE_SIZE.busbar.h / 2) },
          width: snapBusbarWidth(width),
          height: NODE_SIZE.busbar.h,
          data: { params: defaultParams('busbar') },
        }
        set({ nodes: [...get().nodes, node], dirty: true })
        markStale()
      },
      updateNodeParams: (id, patch) => {
        const node = get().nodes.find((n) => n.id === id)
        // A catalogue pick on a transformer applies the whole nameplate.
        if (node?.type === 'transformer' && typeof patch.catalog === 'string') {
          patch = { ...patch, ...catalogPatch(patch.catalog, node.data.params) }
        }
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n,
          ),
          ...renamed(get(), node?.type ?? '', node?.data.params.name, patch.name),
          ...logged(get(), id, node?.data.params ?? {}, patch),
          dirty: true,
        })
        if (!node || !isAnnotation(node)) markStale()
      },
      setTransformerWindings: (id, windings) => {
        const onT3 = (e: AppEdge) =>
          (e.source === id && e.sourceHandle === 't3') ||
          (e.target === id && e.targetHandle === 't3')
        const edges = get().edges
        const before = get().nodes.find((n) => n.id === id)?.data.params ?? {}
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, windings } } } : n,
          ),
          edges: windings.length < 3 && edges.some(onT3) ? edges.filter((e) => !onT3(e)) : edges,
          ...logged(get(), id, before, { windings }),
          dirty: true,
        })
        markStale()
      },
      updateEdgeParams: (id, patch) => {
        const edge = get().edges.find((e) => e.id === id)
        set({
          edges: get().edges.map((e) =>
            e.id === id
              ? { ...e, data: { ...e.data, params: { ...(e.data?.params ?? {}), ...patch } } }
              : e,
          ),
          ...renamed(get(), edge?.type ?? '', edge?.data?.params?.name, patch.name),
          ...logged(get(), id, edge?.data?.params ?? {}, patch),
          dirty: true,
        })
        markStale()
      },
      // The grab gesture (drag an existing connection off its terminal onto
      // another one). Routing waypoints survive a move between handles of the
      // same node — where they still describe the same path — but are dropped
      // when the end lands on a different node, where the old polyline would
      // be meaningless.
      reconnectEdgeEnd: (id, end, nodeId, handleId) => {
        const edge = get().edges.find((e) => e.id === id)
        if (!edge) return
        const wasNode = end === 'source' ? edge.source : edge.target
        const wasHandle = (end === 'source' ? edge.sourceHandle : edge.targetHandle) ?? null
        if (wasNode === nodeId && wasHandle === handleId) return // dropped where it started
        const moved: AppEdge = {
          ...edge,
          ...(end === 'source'
            ? { source: nodeId, sourceHandle: handleId }
            : { target: nodeId, targetHandle: handleId }),
          data: {
            params: edge.data?.params ?? {},
            waypoints: wasNode === nodeId ? edge.data?.waypoints : undefined,
          },
        }
        set({ edges: get().edges.map((e) => (e.id === id ? moved : e)), dirty: true })
        markStale()
      },
      // Waypoints are routing cosmetics only — unsaved, but no markStale.
      setEdgeWaypoints: (id, waypoints) => {
        set({
          edges: get().edges.map((e) =>
            e.id === id
              ? { ...e, data: { params: e.data?.params ?? {}, waypoints } }
              : e,
          ),
          dirty: true,
        })
      },
      addEdgeWaypoint: (id, pos, rendered) => {
        const edge = get().edges.find((e) => e.id === id)
        if (!edge) return
        const wps = edge.data?.waypoints ?? []
        // Prefer the polyline actually on screen. Without waypoints that is
        // ReactFlow's smoothstep path, whose corners are adopted as waypoints
        // so the edge keeps the shape it had when it was clicked; with
        // waypoints it is our own polyline, which indexes the click exactly.
        const drawn = rendered && rendered.length >= 2 ? rendered : null
        const usable = drawn && (!wps.length || drawn.length === wps.length + 2)
        const src = get().nodes.find((n) => n.id === edge.source)
        const tgt = get().nodes.find((n) => n.id === edge.target)
        const pts = usable
          ? wps.length
            ? drawn!
            : simplifyCollinear(drawn!)
          : // Fall back to a straight run between the node centers.
            src && tgt
            ? [nodeCenter(src), ...wps, nodeCenter(tgt)]
            : []
        if (pts.length < 2) {
          get().setEdgeWaypoints(id, [...wps, pos])
          return
        }
        const { index, point } = insertPoint(pts, pos)
        const base = wps.length ? [...wps] : interiorPoints(pts)
        base.splice(index, 0, point)
        get().setEdgeWaypoints(id, base)
      },
      setBusbarWidth: (id, rawWidth) => {
        const width = snapBusbarWidth(rawWidth)
        const count = busbarHandleCount(width)
        // Re-home edges whose handle no longer exists after a shrink.
        const rehome = (h: string | undefined | null, nodeId: string) => {
          if (nodeId !== id || !h) return h ?? undefined
          const m = h.match(/^([bc])(\d+)$/)
          if (!m) return h
          return Number(m[2]) >= count ? `${m[1]}${count - 1}` : h
        }
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, width } : n)),
          edges: get().edges.map((e) => ({
            ...e,
            sourceHandle: rehome(e.sourceHandle, e.source),
            targetHandle: rehome(e.targetHandle, e.target),
          })),
          dirty: true,
        })
        markStale()
      },
      setName: (name) => set({ name, dirty: true }),
      setPlacement: (t) => set({ placementType: t }),
      // Choosing a connect mode is an explicit "I'm drawing wires/lines now",
      // so it exits placement mode — otherwise onConnect's while-placing
      // wire default would silently override a freshly picked Line mode.
      setConnectMode: (m) => set({ connectMode: m, placementType: null }),
      selectOnly: (kind, id) => {
        set({
          nodes: get().nodes.map((n) => ({ ...n, selected: kind === 'node' && n.id === id })),
          edges: get().edges.map((e) => ({ ...e, selected: kind === 'edge' && e.id === id })),
        })
      },
      clearSelection: () => {
        if (!get().nodes.some((n) => n.selected) && !get().edges.some((e) => e.selected)) return
        set({
          nodes: get().nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
          edges: get().edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
        })
      },
      selectMany: ({ nodeIds, edgeIds }) => {
        const ns = new Set(nodeIds)
        const es = new Set(edgeIds)
        set({
          nodes: get().nodes.map((n) => (n.selected === ns.has(n.id) ? n : { ...n, selected: ns.has(n.id) })),
          edges: get().edges.map((e) => (e.selected === es.has(e.id) ? e : { ...e, selected: es.has(e.id) })),
        })
      },
      bulkUpdateParams: ({ nodeIds, edgeIds }, patch) => {
        const ns = new Set(nodeIds)
        const es = new Set(edgeIds)
        let changed = false
        const nodes = get().nodes.map((n) => {
          if (!ns.has(n.id)) return n
          const p = patch(n.data.params)
          if (!p) return n
          changed = true
          return { ...n, data: { ...n.data, params: { ...n.data.params, ...p } } }
        })
        const edges = get().edges.map((e) => {
          if (!es.has(e.id) || e.type !== 'line') return e
          const p = patch(e.data?.params ?? {})
          if (!p) return e
          changed = true
          return { ...e, data: { ...e.data, params: { ...(e.data?.params ?? {}), ...p } } }
        })
        if (!changed) return
        // One log line per element, with the keys the patch touched.
        const entries: HistoryEntryJSON[] = []
        const who = get().study?.engineer ?? ''
        const t = Date.now()
        for (const n of get().nodes) {
          if (!ns.has(n.id)) continue
          const p = patch(n.data.params)
          if (p) for (const [k, v] of Object.entries(p)) entries.push({ t, who, id: n.id, param: k, old: n.data.params[k], new: v, scenario: get().activeScenario })
        }
        for (const e of get().edges) {
          if (!es.has(e.id) || e.type !== 'line') continue
          const p = patch(e.data?.params ?? {})
          if (p) for (const [k, v] of Object.entries(p)) entries.push({ t, who, id: e.id, param: k, old: e.data?.params?.[k], new: v, scenario: get().activeScenario })
        }
        set({ nodes, edges, history: capped([...get().history, ...entries]), dirty: true })
        markStale()
      },
      applyLayout: (laidOut) => {
        const nodePos = new Map(laidOut.nodes.map((n) => [n.id, n]))
        const edgeHandles = new Map(laidOut.edges.map((e) => [e.id, e]))
        set({
          nodes: get().nodes.map((n) => {
            const l = nodePos.get(n.id)
            if (!l?.position) return n
            const { rotation: _r, flip: _f, compact: _c, ...kept } = n.data.params
            const busbar = n.type === 'busbar'
            // The layout decides orientation (rotation, for a left-to-right
            // drawing) and which bars are compact pass-throughs.
            const params = {
              ...kept,
              ...(l.params?.rotation ? { rotation: l.params.rotation } : {}),
              ...(busbar && l.params?.compact ? { compact: true } : {}),
            }
            const width = busbar ? snapBusbarWidth(l.width ?? (n.width as number) ?? NODE_SIZE.busbar.w) : n.width
            // A zone is re-drawn around what it held (lib/layout setNotesAside).
            const zone = n.type === 'zone' && l.width != null && l.height != null
            return {
              ...n,
              position: { x: l.position.x, y: l.position.y },
              ...(busbar ? { width } : {}),
              ...(zone ? { width: l.width as number, height: l.height as number, style: undefined } : {}),
              data: { ...n.data, params },
            }
          }),
          edges: get().edges.map((e) => {
            const l = edgeHandles.get(e.id)
            if (!l) return e
            return {
              ...e,
              sourceHandle: l.sourceHandle ?? e.sourceHandle,
              targetHandle: l.targetHandle ?? e.targetHandle,
              data: {
                ...e.data,
                params: e.data?.params ?? {},
                waypoints: l.waypoints?.length ? l.waypoints : undefined,
              },
            }
          }),
          dirty: true,
        })
      },
      mergeBusNames: (names) => set({ busNames: { ...get().busNames, ...names } }),
      setTccCurve: (name, spec) => {
        set({ tccCurves: { ...get().tccCurves, [name]: spec }, dirty: true })
      },
      removeTccCurve: (name) => {
        const { [name]: _gone, ...rest } = get().tccCurves
        set({ tccCurves: rest, dirty: true })
      },
      setLineCode: (name, spec) => {
        set({ lineCodes: { ...get().lineCodes, [name]: spec }, dirty: true })
        markStale()
      },
      removeLineCode: (name) => {
        const { [name]: _gone, ...rest } = get().lineCodes
        set({ lineCodes: rest, dirty: true })
        markStale()
      },
      renameLineCode: (oldName, newName) => {
        const codes = get().lineCodes
        if (!codes[oldName] || codes[newName] || !newName) return
        const { [oldName]: spec, ...rest } = codes
        set({
          lineCodes: { ...rest, [newName]: spec },
          edges: get().edges.map((e) =>
            e.type === 'line' && e.data?.params.linecode === oldName
              ? { ...e, data: { ...e.data, params: { ...e.data.params, linecode: newName } } }
              : e,
          ),
          dirty: true,
        })
        markStale()
      },
      setLoadShape: (name, spec) => {
        set({ loadShapes: { ...get().loadShapes, [name]: spec }, dirty: true })
        markStale()
      },
      deleteLoadShape: (name) => {
        const { [name]: _gone, ...rest } = get().loadShapes
        set({
          loadShapes: rest,
          nodes: get().nodes.map((n) =>
            n.data.params.loadshape === name
              ? { ...n, data: { params: { ...n.data.params, loadshape: '' } } }
              : n,
          ),
          dirty: true,
        })
        markStale()
      },
      renameLoadShape: (oldName, newName) => {
        if (oldName === newName || !newName) return
        const { [oldName]: spec, ...rest } = get().loadShapes
        if (!spec) return
        set({
          loadShapes: { ...rest, [newName]: spec },
          nodes: get().nodes.map((n) =>
            n.data.params.loadshape === oldName
              ? { ...n, data: { params: { ...n.data.params, loadshape: newName } } }
              : n,
          ),
          dirty: true,
        })
        markStale()
      },
      // Opening a project file leaves the store clean; the autosave-restore
      // path in App re-marks dirty afterward since that work isn't in a file.
      loadCircuit: (c) => {
        const { nodes, edges } = fromCircuitJSON(c)
        set({
          name: c.name,
          nodes,
          edges,
          busNames: c.busNames ?? {},
          loadShapes: c.loadShapes ?? {},
          tccCurves: c.tccCurves ?? {},
          lineCodes: c.lineCodes ?? {},
          passthrough: c.passthrough ?? [],
          comments: c.comments ?? {},
          limits: c.limits ?? null,
          study: c.study ?? null,
          voltageBases: c.voltageBases?.length ? c.voltageBases : null,
          crs: c.crs ?? null,
          xyCurves: c.xyCurves ?? {},
          wireData: c.wireData ?? {},
          lineGeometries: c.lineGeometries ?? {},
          history: c.history ?? [],
          loadLevels: c.loadLevels?.length ? c.loadLevels : null,
          activeLevel: c.activeLevel ?? null,
          scenarios: c.scenarios ?? [],
          activeScenario: null,
          scenarioBase: null,
          tagVocabulary: c.tagVocabulary ?? [],
          allocations: c.allocations ?? [],
          dirty: false,
        })
        // Cleared here rather than at each call site: Open used to leave the
        // previous document's history in place, so undo crossed documents.
        clearHistory()
        markStale()
        // The document's open scenario is reopened on the loaded base.
        if (c.activeScenario && c.scenarios?.some((sc) => sc.id === c.activeScenario)) {
          get().activateScenario(c.activeScenario)
          set({ dirty: false })
        }
      },
      clearAll: () => {
        set({
          nodes: [],
          edges: [],
          busNames: {},
          loadShapes: {},
          tccCurves: {},
          lineCodes: {},
          passthrough: [],
          comments: {},
          limits: null,
          study: null,
          voltageBases: null,
          crs: null,
          xyCurves: {},
          wireData: {},
          lineGeometries: {},
          history: [],
          loadLevels: null,
          activeLevel: null,
          scenarios: [],
          activeScenario: null,
          scenarioBase: null,
          tagVocabulary: [],
          allocations: [],
          dirty: true,
          projectId: null,
        })
        clearHistory()
        markStale()
      },

      copySelection: () => {
        const clip = selectionClipboard(get())
        if (!clip) return 0
        clipboard = clip
        pasteCount = 0
        return clip.nodes.length
      },
      pasteClipboard: () => {
        if (!clipboard) return
        pasteCount += 1
        const off = PASTE_OFFSET * pasteCount
        const { nodes, edges } = materializeClones(clipboard, { x: off, y: off }, takenNames(get()))
        set({
          nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), ...nodes],
          edges: [...get().edges.map((e) => ({ ...e, selected: false })), ...edges],
          dirty: true,
        })
        markStale()
      },
      duplicateSelection: () => {
        const clip = selectionClipboard(get())
        if (!clip) return
        const { nodes, edges } = materializeClones(clip, { x: PASTE_OFFSET, y: PASTE_OFFSET }, takenNames(get()))
        set({
          nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), ...nodes],
          edges: [...get().edges.map((e) => ({ ...e, selected: false })), ...edges],
          dirty: true,
        })
        markStale()
      },
      // Rotation is diagram cosmetics (stored in params, ignored by the
      // compiler) — dirty for saving, but results stay valid.
      rotateNodes: (ids) => {
        const idSet = new Set(ids)
        if (!idSet.size) return
        set({
          nodes: get().nodes.map((n) =>
            idSet.has(n.id) && n.type !== 'busbar' && !isAnnotation(n)
              ? {
                  ...n,
                  data: {
                    params: {
                      ...n.data.params,
                      rotation: ((Number(n.data.params.rotation) || 0) + 90) % 360,
                    },
                  },
                }
              : n,
          ),
          dirty: true,
        })
      },
      rotateSelection: () => {
        get().rotateNodes(get().nodes.filter((n) => n.selected).map((n) => n.id))
      },
      flipNodes: (ids, axis) => {
        const idSet = new Set(ids)
        if (!idSet.size) return
        set({
          nodes: get().nodes.map((n) => {
            if (!idSet.has(n.id) || n.type === 'busbar' || isAnnotation(n)) return n
            const { rotation, flip } = flipOnScreen(n.data.params, axis)
            const { rotation: _r, flip: _f, ...rest } = n.data.params
            return {
              ...n,
              data: {
                ...n.data,
                params: { ...rest, ...(rotation ? { rotation } : {}), ...(flip ? { flip } : {}) },
              },
            }
          }),
          dirty: true,
        })
      },
      splitLine: (edgeId, click, rendered) => {
        const { nodes, edges } = get()
        const edge = edges.find((e) => e.id === edgeId)
        if (!edge || edge.type !== 'line') return null
        const src = nodes.find((n) => n.id === edge.source)
        const tgt = nodes.find((n) => n.id === edge.target)
        if (!src || !tgt) return null
        const wps = edge.data?.waypoints ?? []
        // The line as drawn, as addEdgeWaypoint reads it.
        const drawn = rendered && rendered.length >= 2 && (!wps.length || rendered.length === wps.length + 2)
        const pts = drawn
          ? wps.length ? rendered! : simplifyCollinear(rendered!)
          : [nodeCenter(src), ...wps, nodeCenter(tgt)]
        const where = splitAt(pts, click ?? midpoint(pts))

        // A short bar whose middle terminal sits on the split point.
        const width = 60
        const cx = snapGrid(where.point.x)
        const cy = where.point.y
        const params = edge.data?.params ?? {}
        const taken = takenNames(get())
        const lineName = String(params.name ?? 'LN')
        const barName = uniqueSuffixed(`${lineName}_MID`, taken)
        const kvFrom = [src, tgt].find((n) => n.type === 'busbar' && n.data.params.basekv != null)
        const bar: AppNode = {
          id: newId('n'),
          type: 'busbar',
          position: { x: cx - width / 2, y: snapGrid(cy - NODE_SIZE.busbar.h / 2) },
          width,
          height: NODE_SIZE.busbar.h,
          selected: true,
          data: {
            params: { ...defaultParams('busbar'), name: barName, ...(kvFrom ? { basekv: kvFrom.data.params.basekv } : {}) },
          },
        }
        // Along the bar for a line running across; top and bottom rows for
        // one running down, so each half meets the bar from its own side.
        const [inHandle, outHandle] = where.vertical
          ? where.forward ? ['b1', 'c1'] : ['c1', 'b1']
          : where.forward ? ['b0', 'b2'] : ['b2', 'b0']
        const hasLength = typeof params.length === 'number'
        const [l1, l2] = hasLength ? divideLength(params.length as number, where.fraction) : [undefined, undefined]
        const first: AppEdge = {
          ...edge,
          selected: false,
          target: bar.id,
          targetHandle: inHandle,
          data: {
            ...edge.data,
            params: { ...params, ...(hasLength ? { length: l1 } : {}) },
            waypoints: where.before.length ? where.before : undefined,
          },
        }
        const second: AppEdge = {
          id: newId('e'),
          type: 'line',
          source: bar.id,
          sourceHandle: outHandle,
          target: edge.target,
          targetHandle: edge.targetHandle,
          data: {
            params: { ...params, name: uniqueSuffixed(`${lineName}_2`, taken), ...(hasLength ? { length: l2 } : {}) },
            waypoints: where.after.length ? where.after : undefined,
          },
        }
        set({
          nodes: [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), bar],
          edges: edges.flatMap((e) => (e.id === edgeId ? [first, second] : e.selected ? [{ ...e, selected: false }] : [e])),
          dirty: true,
        })
        markStale()
        return bar.id
      },
      moveNodes: (positions) => {
        let moved = false
        const nodes = get().nodes.map((n) => {
          const p = positions[n.id]
          if (!p || (p.x === n.position.x && p.y === n.position.y)) return n
          moved = true
          return { ...n, position: { x: p.x, y: p.y } }
        })
        if (moved) set({ nodes, dirty: true })
      },
    }),
    {
      // Selection flags are stripped so clicking around never pollutes the
      // undo history (equality below then sees those states as identical),
      // and so are React Flow's measurements: a busbar changing width makes
      // the canvas report new sizes a frame later, and without this each
      // report became an undo entry that undid nothing.
      partialize: (s) => ({
        name: s.name,
        nodes: s.nodes.map(({ selected: _s, measured: _m, ...n }) => n),
        edges: s.edges.map(({ selected: _s, ...e }) => e),
        busNames: s.busNames,
        loadShapes: s.loadShapes,
        lineCodes: s.lineCodes,
        passthrough: s.passthrough,
        comments: s.comments,
        limits: s.limits,
        study: s.study,
        voltageBases: s.voltageBases,
        crs: s.crs,
        xyCurves: s.xyCurves,
        wireData: s.wireData,
        lineGeometries: s.lineGeometries,
        loadLevels: s.loadLevels,
        activeLevel: s.activeLevel,
        scenarios: s.scenarios,
        tagVocabulary: s.tagVocabulary,
        allocations: s.allocations,
      }),
      limit: 100,
      // By reference, element by element. Every action replaces what it
      // changes (a node's data, its position, a library object) and keeps
      // the rest, so "nothing was replaced" is "nothing changed". This used
      // to stringify the whole document twice on every set -- fine for a
      // drawing, minutes on a 10,000-element feeder, where React Flow's
      // size reports alone are hundreds of sets.
      equality: (past, cur) => {
        for (const key of Object.keys(cur) as (keyof typeof cur)[]) {
          if (key === 'nodes' || key === 'edges') continue
          if (past[key] !== cur[key]) return false
        }
        return sameItems(past.nodes, cur.nodes) && sameItems(past.edges, cur.edges)
      },
      // One undo entry per gesture (drag/resize), one per discrete action.
      handleSet: (handleSet) => (state) => {
        if (inGesture) {
          if (gestureRecorded) return
          gestureRecorded = true
        }
        handleSet(state)
      },
    },
  ),
)

const HISTORY_CAP = 5000

function capped(entries: HistoryEntryJSON[]): HistoryEntryJSON[] {
  return entries.length > HISTORY_CAP ? entries.slice(entries.length - HISTORY_CAP) : entries
}

/** The audit-trail lines a parameter patch adds: one per key that changed. */
function logged(
  s: Pick<CircuitState, 'history' | 'study' | 'activeScenario'>,
  id: string,
  before: Params,
  patch: Params,
): Partial<Pick<CircuitState, 'history'>> {
  const t = Date.now()
  const who = s.study?.engineer ?? ''
  const entries: HistoryEntryJSON[] = []
  for (const [k, v] of Object.entries(patch)) {
    const old = before[k]
    if (old === v || (old === undefined && v === undefined)) continue
    if (typeof old === 'object' && typeof v === 'object' && JSON.stringify(old) === JSON.stringify(v)) continue
    entries.push({ t, who, id, param: k, old, new: v, scenario: s.activeScenario })
  }
  return entries.length ? { history: capped([...s.history, ...entries]) } : {}
}

/** The nameplate a catalogue code stands for, as a parameter patch. The
 *  catalogue is fetched once by the properties panel (lib/catalog.ts). */
let transformerCatalog: Record<string, Params> = {}
export function setTransformerCatalog(entries: Record<string, Params>): void {
  transformerCatalog = entries
}
function catalogPatch(code: string, current: Params): Params {
  const e = transformerCatalog[code]
  if (!e) return {}
  const windings = Array.isArray(current.windings) ? (current.windings as Winding[]) : []
  const kva = (e.kva as number) ?? windings[0]?.kva ?? 1000
  return {
    phases: e.phases,
    xhl: e.xhl,
    pctloadloss: e.pctloadloss,
    pctnoloadloss: e.pctnoloadloss,
    splitphase: e.splitphase === true,
    windings: [
      { kv: e.kvh as number, kva, conn: (e.connh as 'wye' | 'delta') ?? 'wye' },
      { kv: e.kvl as number, kva, conn: (e.connl as 'wye' | 'delta') ?? 'wye' },
    ],
  }
}

/** Two lists of (selection-stripped) nodes or edges hold the same things:
 *  same length, and every item has the same fields holding the same
 *  references. */
function sameItems(a: object[], b: object[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Record<string, unknown>
    const y = b[i] as Record<string, unknown>
    const keys = Object.keys(x)
    if (keys.length !== Object.keys(y).length) return false
    for (const k of keys) if (x[k] !== y[k]) return false
  }
  return true
}

setLimitsSource(() => limitsOf(useCircuitStore.getState().limits))

/** The limits the open circuit applies, for components. */
export const useLimits = () => limitsOf(useCircuitStore((s) => s.limits))

export const undo = () => useCircuitStore.temporal.getState().undo()
export const redo = () => useCircuitStore.temporal.getState().redo()
