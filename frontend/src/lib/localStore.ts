// Local persistence for autosaved work.
//
// This used to be a single localStorage key. Two problems with that, both of
// which bite silently: localStorage is capped at roughly 5 MB per origin, and
// a document carrying three 15-minute-year loadshapes is already past it -- so
// the people with the most work to lose were the ones with no protection. And
// a quota failure throws, which the old code swallowed, so the app went on
// claiming to autosave while writing nothing.
//
// IndexedDB has no practical size ceiling here and stores structured values
// without a stringify round-trip. localStorage remains as a fallback for
// private-browsing modes and anything that blocks IndexedDB.

const DB_NAME = 'opendss-designer'
// v1: the autosave slot. v2: the project library (lib/library.ts).
const DB_VERSION = 2
const STORE = 'documents'
const LEGACY_KEY = 'opendss-designer.autosave'
const ALL_STORES = [STORE, 'projects', 'projectBodies']

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of ALL_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Promise wrapper for one IDB request, for use inside `withTx`. */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * Run `fn` inside one transaction over `stores` and resolve when it commits.
 * Only await IDB requests inside `fn` (via `request`): awaiting anything else
 * lets the browser auto-commit the transaction under you.
 */
export async function withTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode)
      let out: T
      tx.oncomplete = () => resolve(out)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
      Promise.resolve()
        .then(() => fn(tx))
        .then((v) => {
          out = v
        })
        .catch((err) => {
          try {
            tx.abort()
          } catch {
            // already finished
          }
          reject(err)
        })
    })
  } finally {
    db.close()
  }
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return withTx([STORE], mode, (tx) => request(fn(tx.objectStore(STORE))))
}

/** True when the last write failed, so the UI can stop promising protection. */
export let lastWriteFailed = false

export async function saveDoc(key: string, value: unknown): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.put(value, key))
    lastWriteFailed = false
    return
  } catch {
    // fall through to localStorage
  }
  try {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(value))
    lastWriteFailed = false
  } catch {
    // Genuinely nowhere to put it. Surfaced rather than swallowed: the
    // beforeunload prompt is now the only thing standing between the user
    // and losing their work.
    lastWriteFailed = true
  }
}

export async function loadDoc<T>(key: string): Promise<T | null> {
  try {
    const found = await withStore<T | undefined>('readonly', (s) => s.get(key))
    if (found !== undefined) return found
  } catch {
    // fall through
  }
  // Migrate a pre-IndexedDB autosave rather than stranding it.
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw) return JSON.parse(raw) as T
  } catch {
    // corrupt or unavailable
  }
  return null
}

export async function clearLegacyDoc(): Promise<void> {
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // nothing to do
  }
}
