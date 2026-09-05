// Document schema version and the migration seam.
//
// The `version` field has been written since the first release and read by
// nothing: no comparison, no migration table. That is survivable while a
// circuit only ever travels as a file the user hand-picks, and it is not
// survivable once documents are stored somewhere and opened by more than one
// build of the client -- a newer document loaded by an older client silently
// loses any top-level key that client does not know about.
//
// So: a real version check, an explicit place to put migrations, and a loud
// failure instead of a quiet one when a document is from the future.

import type { CircuitJSON } from '../types/circuit'

/** Bump when the document shape changes, and add a migration below. */
export const SCHEMA_VERSION = 1

export interface MigrationResult {
  circuit: CircuitJSON
  /** Non-fatal note for the user; shown as a toast. */
  warning?: string
}

export class DocumentError extends Error {}

/** Migrations from version N to N+1, applied in order. Empty today -- the
 *  point is that the seam exists before the first change needs it. */
const MIGRATIONS: Record<number, (c: CircuitJSON) => CircuitJSON> = {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate and migrate a parsed document.
 *
 * Throws `DocumentError` with a readable message rather than letting a
 * malformed file fail somewhere deep in the store, where the error text is
 * meaningless to whoever is looking at it.
 */
export function migrateCircuit(raw: unknown): MigrationResult {
  if (!isRecord(raw)) {
    throw new DocumentError('That file is not an OpenDSS Designer project.')
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new DocumentError(
      'That file is missing its nodes or edges, so it is not a project file.',
    )
  }

  // A missing version means it predates versioning, which is version 1.
  const version = typeof raw.version === 'number' ? raw.version : 1

  if (version > SCHEMA_VERSION) {
    // Deliberately not a hard failure: refusing to open someone's own work is
    // worse than opening it with a caveat. But it must be said out loud,
    // because saving over it will drop whatever this build cannot represent.
    return {
      circuit: raw as unknown as CircuitJSON,
      warning:
        `This project was saved by a newer version of OpenDSS Designer ` +
        `(format ${version}, this build reads ${SCHEMA_VERSION}). It has been ` +
        `opened, but anything this version does not understand will be lost ` +
        `if you save over it.`,
    }
  }

  let circuit = raw as unknown as CircuitJSON
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v]
    if (!step) {
      throw new DocumentError(
        `Cannot upgrade this project from format ${v} to ${SCHEMA_VERSION}.`,
      )
    }
    circuit = step(circuit)
  }
  return { circuit: { ...circuit, version: SCHEMA_VERSION } }
}
