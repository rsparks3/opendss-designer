/**
 * Saving a project to a real file and back to the same file again, through
 * the File System Access API (Chrome, Edge, Opera). The browser library
 * stays the primary home for a circuit; this is the way to keep one as a
 * file on disk, in a shared folder or under version control, without a
 * fresh download every time.
 *
 * Where the API is missing (Firefox, Safari) "save to file" is a download
 * and "open file" is the ordinary file input, so every command still works,
 * only without the in-place write.
 */

// Just the parts of the API used here; TypeScript's DOM library does not
// declare the pickers yet.
export interface FileHandle {
  name: string
  getFile: () => Promise<File>
  createWritable: () => Promise<{ write: (data: Blob | string) => Promise<void>; close: () => Promise<void> }>
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
}

interface PickerOptions {
  suggestedName?: string
  types?: { description: string; accept: Record<string, string[]> }[]
  excludeAcceptAllOption?: boolean
}

export interface Pickers {
  showOpenFilePicker?: (o?: PickerOptions) => Promise<FileHandle[]>
  showSaveFilePicker?: (o?: PickerOptions) => Promise<FileHandle>
}

const PROJECT_TYPES = [
  { description: 'OpenDSS Designer project', accept: { 'application/json': ['.json'] } },
]

const pickers = (): Pickers => globalThis as unknown as Pickers

/** True where a file can be written in place. */
export function canSaveInPlace(p: Pickers = pickers()): boolean {
  return typeof p.showSaveFilePicker === 'function' && typeof p.showOpenFilePicker === 'function'
}

/** The user dismissing a picker is not an error worth reporting. */
export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** Ask for a project file to open. Null when the user backs out. */
export async function pickProjectFile(p: Pickers = pickers()): Promise<{ file: File; handle: FileHandle } | null> {
  try {
    const [handle] = await p.showOpenFilePicker!({ types: PROJECT_TYPES })
    return { file: await handle.getFile(), handle }
  } catch (err) {
    if (isAbort(err)) return null
    throw err
  }
}

/** Ask where to save. Null when the user backs out. */
export async function pickSaveTarget(suggestedName: string, p: Pickers = pickers()): Promise<FileHandle | null> {
  try {
    return await p.showSaveFilePicker!({ suggestedName, types: PROJECT_TYPES })
  } catch (err) {
    if (isAbort(err)) return null
    throw err
  }
}

/** Write the text over the file. A handle that came from the open picker
 *  only has read access until the user grants write, which the browser asks
 *  about once; refusing leaves the file untouched and says so. */
export async function writeTo(handle: FileHandle, text: string): Promise<void> {
  if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    const answer = await handle.requestPermission?.({ mode: 'readwrite' })
    if (answer !== 'granted') throw new Error(`permission to write ${handle.name} was not given`)
  }
  const out = await handle.createWritable()
  await out.write(text)
  await out.close()
}

/** "feeder" becomes "feeder.oneline.json". */
export function projectFileName(name: string): string {
  const base = (name.trim() || 'circuit').replace(/[\\/:*?"<>|]+/g, '-')
  return base.endsWith('.json') ? base : `${base}.oneline.json`
}
