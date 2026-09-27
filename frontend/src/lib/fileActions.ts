import { toCircuitJSON, useCircuitStore } from '../store/circuitStore'
import { useResultsStore, type OverlayMode } from '../store/resultsStore'
import { useUiStore } from '../store/uiStore'
import { api } from './api'
import { diagramToSvg, imageFileName, legendFor, OVERLAY_LABELS, svgToPng } from './exportDiagram'
import {
  canSaveInPlace,
  pickProjectFile,
  pickSaveTarget,
  projectFileName,
  writeTo,
  type FileHandle,
} from './fileSystem'
import { autoLayout } from './layout'
import { loadProject, newProjectId, saveProject } from './library'
import { migrateCircuit } from './schema'
import { inLightTheme } from './theme'

/**
 * Everything the File menu (and the matching shortcuts) does, as plain
 * functions over the stores, so the menu bar, the toolbar and the keyboard
 * all run the same code.
 */

// A browser tab dies on JSON.parse of a few hundred MB long before the server
// ever sees the request, so the first size check has to happen here.
const MAX_PROJECT_BYTES = 32 * 1024 * 1024
const MAX_DSS_BYTES = 32 * 1024 * 1024

function tooBig(files: File[], limit: number): string | null {
  const total = files.reduce((n, f) => n + f.size, 0)
  if (total <= limit) return null
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `That is ${mb(total)}; the editor handles up to ${mb(limit)}.`
}

/** Today as YYYY-MM-DD in the user's own time zone; an ISO string would
 *  date an evening export tomorrow. */
function localDate(): string {
  const d = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export function downloadBlob(filename: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export function download(filename: string, text: string, type = 'application/json') {
  downloadBlob(filename, new Blob([text], { type }))
}

/** Ask the browser for files. Resolves with none if the picker is dismissed
 *  (browsers that report a cancel) or never, which is harmless. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.hidden = true
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []))
      input.remove()
    })
    input.addEventListener('cancel', () => {
      resolve([])
      input.remove()
    })
    document.body.appendChild(input)
    input.click()
  })
}

const circuit = () => toCircuitJSON(useCircuitStore.getState())
const flash = (msg: string, kind?: 'error' | 'info', durationMs?: number) =>
  useResultsStore.getState().setFlash(msg, kind, durationMs)
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** True when it is fine to replace the circuit on screen. */
function mayDiscard(what: string): boolean {
  const st = useCircuitStore.getState()
  return !(st.nodes.length > 0 && st.dirty && !window.confirm(`Discard unsaved changes and ${what}?`))
}

function resetResults() {
  useResultsStore.setState({ result: null, stale: false, issues: [] })
}

/** Which file on disk (if any) Save to file writes back to. */
const linkFile = (h: FileHandle | null) => useUiStore.getState().setFileHandle(h)

export function fitView() {
  window.dispatchEvent(new CustomEvent('opendss:fit-view'))
}

export function newCircuit() {
  if (!mayDiscard('start a new circuit')) return
  const st = useCircuitStore.getState()
  st.clearAll()
  st.setName('my-circuit')
  useCircuitStore.setState({ dirty: false })
  useCircuitStore.temporal.getState().clear()
  resetResults()
  linkFile(null)
}

// --- the browser-local project library -------------------------------------

export async function writeProject(id: string, chosenName: string) {
  try {
    await saveProject(id, chosenName, circuit())
    useCircuitStore.setState({ projectId: id, name: chosenName, dirty: false })
    flash(`Saved "${chosenName}"`, 'info', 2500)
  } catch (err) {
    flash(
      `Could not save in this browser (${errText(err)}). ` +
        'Use File → Export → Project (.json) to keep a copy as a file.',
      'error', 8000)
  }
}

/** Save: silent once the circuit has a home; the first time, ask for a name. */
export function save() {
  const { projectId, name } = useCircuitStore.getState()
  if (projectId) void writeProject(projectId, name.trim() || 'circuit')
  else useUiStore.getState().openDialog('saveAs')
}

export function saveAsChosen(chosen: string) {
  const { projectId, name } = useCircuitStore.getState()
  void writeProject(projectId && chosen === name ? projectId : newProjectId(), chosen)
}

export async function openFromLibrary(id: string) {
  if (!mayDiscard('open the saved circuit')) return
  try {
    const found = await loadProject(id)
    if (!found) {
      flash('That circuit is no longer in the library.')
      return
    }
    const { circuit: c, warning } = migrateCircuit(found.circuit)
    useCircuitStore.getState().loadCircuit(c)
    useCircuitStore.setState({ projectId: id, dirty: false })
    resetResults()
    linkFile(null)
    useUiStore.getState().closeDialog()
    fitView()
    if (warning) flash(warning, 'info', 12000)
  } catch (err) {
    flash(`Could not open: ${errText(err)}`)
  }
}

export async function exportSaved(id: string) {
  const found = await loadProject(id)
  if (found) download(`${found.meta.name}.oneline.json`, JSON.stringify(found.circuit, null, 2))
}

// --- files ------------------------------------------------------------------

/** Open a .oneline.json from disk. Where the browser allows it the file
 *  stays linked, so Save to file writes back over it. */
export async function openProjectFile(file?: File) {
  let f = file
  let handle: FileHandle | null = null
  if (!f && canSaveInPlace()) {
    try {
      const picked = await pickProjectFile()
      if (!picked) return
      f = picked.file
      handle = picked.handle
    } catch (err) {
      flash(`Could not open project: ${errText(err)}`)
      return
    }
  }
  f ??= (await pickFiles('.json'))[0]
  if (!f) return
  if (!mayDiscard('open the file')) return
  const oversize = tooBig([f], MAX_PROJECT_BYTES)
  if (oversize) {
    flash(`Could not open project: ${oversize}`)
    return
  }
  try {
    const { circuit: c, warning } = migrateCircuit(JSON.parse(await f.text()))
    useCircuitStore.getState().loadCircuit(c)
    // A file from disk is not a library entry until it is saved.
    useCircuitStore.setState({ projectId: null, dirty: false })
    resetResults()
    linkFile(handle)
    useUiStore.getState().closeDialog()
    fitView()
    if (warning) flash(warning, 'info', 12000)
  } catch (err) {
    flash(`Could not open project: ${errText(err)}`)
  }
}

export async function openSample(id: string) {
  if (!mayDiscard('open the sample')) return
  try {
    const c = await api.sample(id)
    useCircuitStore.getState().loadCircuit(c)
    useCircuitStore.setState({ dirty: false, projectId: null })
    useCircuitStore.temporal.getState().clear()
    resetResults()
    linkFile(null)
    fitView()
  } catch (err) {
    flash(`Could not open sample: ${errText(err)}`)
  }
}

export async function importDss(fileList?: File[]) {
  const files = fileList ?? (await pickFiles('.dss,.txt,.csv,.dat', true))
  if (!files.length) return
  const oversize = tooBig(files, MAX_DSS_BYTES)
  if (oversize) {
    flash(`Could not import: ${oversize}`)
    return
  }
  try {
    const texts = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
    const { circuit: imported, unsupported, passthrough, warnings } = await api.importDss(texts)
    autoLayout(imported)
    useCircuitStore.getState().loadCircuit(imported)
    useCircuitStore.setState({ projectId: null })
    linkFile(null)
    fitView()
    const notes = [...(warnings ?? [])]
    if (passthrough?.length) {
      notes.push(`Kept ${passthrough.length} element${passthrough.length === 1 ? '' : 's'} the drawing does not ` +
        'show (see the Passthrough tab); they are exported again and solved when safe.')
    }
    if (unsupported.length) {
      const shown = unsupported.slice(0, 5)
      const more = unsupported.length - shown.length
      notes.push(`${unsupported.length} unsupported element(s) skipped: ` +
        shown.join(', ') + (more > 0 ? ` … and ${more} more` : ''))
    }
    if (notes.length) flash(notes.join('\n'), 'info', 8000)
  } catch (err) {
    const msg = errText(err)
    let tip = ''
    if (/references other files|not found/i.test(msg)) {
      tip = '\nTip: in the file dialog, Ctrl+click to select the main .dss file ' +
        'together with every file it references (line codes, bus coordinates, redirects).'
    }
    flash(`Import failed: ${msg}${tip}`, 'error', 8000)
  }
}

export function exportJson() {
  const { name } = useCircuitStore.getState()
  download(projectFileName(name), JSON.stringify(circuit(), null, 2))
  useCircuitStore.getState().markSaved()
}

/** Save to file: back over the linked file when there is one, otherwise
 *  (or with `choose`) wherever the user picks. Without the File System
 *  Access API this is a download. */
export async function saveToFile(choose = false) {
  if (!canSaveInPlace()) {
    exportJson()
    return
  }
  const { name } = useCircuitStore.getState()
  try {
    const current = useUiStore.getState().fileHandle
    const handle = (!choose && current) || (await pickSaveTarget(projectFileName(name)))
    if (!handle) return
    await writeTo(handle, JSON.stringify(circuit(), null, 2))
    linkFile(handle)
    useCircuitStore.getState().markSaved()
    flash(`Saved to ${handle.name}`, 'info', 2500)
  } catch (err) {
    flash(`Could not save the file: ${errText(err)}`, 'error', 8000)
  }
}

export async function exportDss() {
  const { name } = useCircuitStore.getState()
  try {
    download(`${name || 'circuit'}.dss`, await api.exportDss(circuit()), 'text/plain')
  } catch (err) {
    flash(`Export failed: ${errText(err)}`)
  }
}

/** The drawing as an image, with whatever overlay is on: a phasing map or a
 *  voltage plot is exactly what goes into a report. Selection is dropped
 *  first so no element carries the editor's blue outline, and the export
 *  waits a frame for that to render. */
export async function exportImage(kind: 'svg' | 'png') {
  const pane = document.querySelector('.react-flow') as HTMLElement | null
  if (!pane) return
  const { name } = useCircuitStore.getState()
  useCircuitStore.getState().clearSelection()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const rs = useResultsStore.getState()
  const label = OVERLAY_LABELS[rs.overlay]
  const unsolved = rs.overlay !== 'off' && rs.overlay !== 'phases' && (rs.stale || !rs.result)
  const caption = [
    name || 'circuit',
    label && `${label} overlay${unsolved ? ' (not solved)' : ''}`,
    localDate(),
  ]
    .filter(Boolean)
    .join(' · ')
  try {
    // Exports go on white paper, so they are read off a light-theme drawing.
    const svg = await inLightTheme(() => diagramToSvg(pane, { caption, legend: legendFor(rs.overlay) }))
    if (kind === 'svg') {
      download(imageFileName(name, rs.overlay, 'svg'), svg, 'image/svg+xml')
    } else {
      downloadBlob(imageFileName(name, rs.overlay, 'png'), await svgToPng(svg))
    }
  } catch (err) {
    flash(`Export failed: ${errText(err)}`)
  }
}

// --- arrange and analysis ------------------------------------------------------

export function cleanUp() {
  const s = useCircuitStore.getState()
  if (!s.nodes.length) return
  const laidOut = toCircuitJSON(s)
  autoLayout(laidOut)
  s.applyLayout(laidOut)
  // The drawing changed shape; show all of it.
  fitView()
}

/** The fault study runs lazily when its overlay is first selected (results
 *  are cleared on any circuit change, so re-selecting re-runs it). */
export function chooseOverlay(mode: OverlayMode) {
  useResultsStore.getState().setOverlay(mode)
  if (mode === 'fault' && !useResultsStore.getState().fault) {
    void (async () => {
      try {
        const f = await api.faultStudy(circuit())
        useResultsStore.getState().setFault(f)
        if (!f.converged) flash('Fault study failed — check the problems list')
      } catch (err) {
        flash(`Fault study failed: ${errText(err)}`)
      }
    })()
  }
}
