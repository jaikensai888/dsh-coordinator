/**
 * Moving the old JSON state into the unified database — once, safely, and never
 * twice.
 *
 * The previous Coordinator kept node credentials and the enrollment rule in
 * `coordinator-state.json`. That file is now a **migration source**, not a live
 * store: the SQLite database is the only thing written after this runs.
 *
 * The important properties, each of which exists because getting it wrong loses a
 * credential:
 *
 * - The whole document is validated before anything is written. The old reader
 *   dropped records it did not like and carried on; that behaviour is exactly
 *   what must not happen here, because a partially imported allowlist looks like a
 *   successful start and is discovered when a node cannot connect.
 * - The import is one transaction, with the nodes and the "this database was
 *   migrated from that file" marker committed together. A crash leaves the
 *   database untouched, so the next start retries instead of half-importing.
 * - The source file is renamed to `*.migrated.bak` only after the commit. If the
 *   rename fails, the marker already in the database prevents a second import and
 *   the operator is told which backup to move by hand.
 * - Custom paths never share a database. `a.json` maps to `a.sqlite`, the default
 *   name maps to `coordinator.sqlite`, and a database whose recorded source does
 *   not match the file it is asked to import refuses rather than mixing two
 *   deployments' credentials.
 *
 * @module dsh-coordinator/state-migration
 */

import { readFile, rename } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { CoordinatorError } from './errors.js'
import { readSetting, writeSetting, type CoordinatorDatabase } from './database.js'
import { inTransaction, type SqlDatabase } from './sqlite.js'
import type { EnrollmentPolicy } from './node-registry.js'
import type { NodeRecord } from './protocol.js'
import { DEFAULT_STATE_FILE_NAME, STATE_FILE_VERSION, type CoordinatorState } from './state-file.js'

/** The database file a legacy state file maps onto. */
export const DEFAULT_DATABASE_FILE_NAME = 'coordinator.sqlite'

/** The `settings` key that records the migration, and the source it came from. */
export const MIGRATION_SETTING_KEY = 'legacyMigration'

/** The `settings` key holding the operator bearer token. */
export const API_TOKEN_SETTING_KEY = 'operatorToken'

/** How the paths were configured. Mirrors the CLI's own options. */
export interface DatabasePathOptions {
  /** Legacy `--state-file`. */
  readonly stateFile?: string
  /** New `--db-file`. */
  readonly dbFile?: string
  /** New `--migrate-state-file`, only meaningful with `--db-file`. */
  readonly migrateStateFile?: string
  /** `--no-state-file`: no durable state at all. */
  readonly noStateFile?: boolean
}

/** The resolved locations. */
export interface ResolvedDatabasePaths {
  /** Absolute database path, or null for `--no-state-file`. */
  readonly dbFile: string | null
  /** Absolute JSON file to migrate from, when one is configured. */
  readonly legacyFile?: string
}

/** A migration record, stored in `settings`. */
export interface MigrationRecord {
  readonly source: string
  readonly importedAt: string
  readonly nodes: number
  readonly enrollment: 'closed' | 'shared-secret'
}

/** What {@link importLegacyState} did. */
export interface ImportOutcome {
  /** True only when this call actually imported the document. */
  readonly imported: boolean
  /** Present when the JSON was renamed to a backup. */
  readonly backupFile?: string
  /** Present when the commit succeeded but the rename did not. */
  readonly backupError?: string
  /** The migration record now in the database, when there is one. */
  readonly record?: MigrationRecord
}

/** Treat a path with no extension as a directory, matching `resolveStateFile`. */
function looksLikeFile(path: string): boolean {
  return /\.[A-Za-z0-9]+$/u.test(path)
}

/** Resolve a configured database path. */
export function resolveDatabaseFile(configured: string | undefined, cwd: string): string {
  if (configured === undefined || configured.trim() === '') {
    return join(cwd, DEFAULT_DATABASE_FILE_NAME)
  }
  const trimmed = configured.trim()
  const base = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
  return looksLikeFile(base) ? base : join(base, DEFAULT_DATABASE_FILE_NAME)
}

/** Resolve a legacy `--state-file`, keeping the old defaults. */
export function resolveLegacyStateFile(configured: string | undefined, cwd: string): string {
  if (configured === undefined || configured.trim() === '') return join(cwd, DEFAULT_STATE_FILE_NAME)
  const trimmed = configured.trim()
  const base = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
  return looksLikeFile(base) ? base : join(base, DEFAULT_STATE_FILE_NAME)
}

/**
 * Work out which database to open and which JSON (if any) may seed it.
 *
 * `--db-file` and `--state-file` are two spellings of one decision, so supplying
 * both is refused instead of letting argument order silently pick a winner.
 * @param options - the configured paths.
 * @param cwd - base for relative paths.
 * @returns the resolved pair.
 * @throws CoordinatorError `coordinator/invalid-arguments` on an ambiguous combination.
 */
export function resolveDatabasePaths(
  options: DatabasePathOptions,
  cwd: string = process.cwd(),
): ResolvedDatabasePaths {
  if (options.noStateFile === true) {
    if (options.dbFile !== undefined) {
      throw new CoordinatorError(
        'coordinator/invalid-arguments',
        '--no-state-file and --db-file contradict each other: pick one',
        {},
      )
    }
    if (options.migrateStateFile !== undefined) {
      throw new CoordinatorError(
        'coordinator/invalid-arguments',
        '--no-state-file cannot migrate a state file: usage sync and administration need a database',
        {},
      )
    }
    return { dbFile: null }
  }
  if (options.dbFile !== undefined && options.stateFile !== undefined) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      '--db-file replaces --state-file: pass only one (use --migrate-state-file to name an old JSON file)',
      {},
    )
  }
  if (options.migrateStateFile !== undefined && options.dbFile === undefined) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      '--migrate-state-file only makes sense together with --db-file',
      {},
    )
  }

  if (options.dbFile !== undefined) {
    const dbFile = resolveDatabaseFile(options.dbFile, cwd)
    const legacyFile = options.migrateStateFile === undefined
      ? join(dirname(dbFile), DEFAULT_STATE_FILE_NAME)
      : resolveLegacyStateFile(options.migrateStateFile, cwd)
    return { dbFile, legacyFile }
  }

  if (options.stateFile !== undefined) {
    // The old flag keeps working, but lands in a database beside the file it
    // names: `a.json` becomes `a.sqlite`, so two instances in one directory do
    // not end up sharing one credential store.
    const legacyFile = resolveLegacyStateFile(options.stateFile, cwd)
    return { dbFile: toDatabaseFile(legacyFile), legacyFile }
  }

  const legacyFile = join(cwd, DEFAULT_STATE_FILE_NAME)
  return { dbFile: join(cwd, DEFAULT_DATABASE_FILE_NAME), legacyFile }
}

/** Map a legacy state path onto its database path. */
export function toDatabaseFile(legacyFile: string): string {
  const name = basename(legacyFile)
  if (name === DEFAULT_STATE_FILE_NAME) return join(dirname(legacyFile), DEFAULT_DATABASE_FILE_NAME)
  const stem = name.replace(/\.[^.]+$/u, '')
  return join(dirname(legacyFile), `${stem}.sqlite`)
}

/** The migration record currently stored, if any. */
export function readMigrationRecord(db: SqlDatabase): MigrationRecord | undefined {
  return readSetting<MigrationRecord>(db, MIGRATION_SETTING_KEY)
}

/**
 * Read the old state file and refuse anything this build cannot import whole.
 *
 * @param file - absolute path.
 * @returns the validated state, or undefined when the file does not exist.
 * @throws CoordinatorError `coordinator/invalid-arguments` when the document is
 * structurally unusable, or `coordinator/storage-unavailable` when it cannot be read.
 */
export async function readLegacyState(file: string): Promise<CoordinatorState | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new CoordinatorError(
      'coordinator/storage-unavailable',
      `the legacy state file ${file} could not be read: ${(error as Error).message}`,
      { file },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      `${file} is not valid JSON; refusing to start with a partially imported allowlist`,
      { file },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      `${file} must contain a JSON object; refusing to import it`,
      { file },
    )
  }
  const document = parsed as Record<string, unknown>
  const version = document['version']
  if (version !== undefined && version !== STATE_FILE_VERSION) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      `${file} has version ${String(version)}, expected ${String(STATE_FILE_VERSION)}; refusing to import it`,
      { file, version: String(version) },
    )
  }

  const rawNodes = document['nodes']
  if (rawNodes !== undefined && !Array.isArray(rawNodes)) {
    throw new CoordinatorError('coordinator/invalid-arguments', `${file}: "nodes" must be an array`, { file })
  }
  const nodes: NodeRecord[] = []
  const seen = new Set<string>()
  for (const [index, entry] of (rawNodes ?? []).entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new CoordinatorError('coordinator/invalid-arguments', `${file}: node record ${index} is not an object`, {
        file,
        index,
      })
    }
    const record = entry as Record<string, unknown>
    const nodeId = record['nodeId']
    const token = record['token']
    if (typeof nodeId !== 'string' || nodeId.trim() === '') {
      throw new CoordinatorError('coordinator/invalid-arguments', `${file}: node record ${index} has no nodeId`, {
        file,
        index,
      })
    }
    if (typeof token !== 'string' || token === '') {
      throw new CoordinatorError('coordinator/invalid-arguments', `${file}: node record ${index} has no token`, {
        file,
        index,
      })
    }
    if (seen.has(nodeId)) {
      throw new CoordinatorError(
        'coordinator/invalid-arguments',
        `${file}: node "${nodeId}" appears more than once`,
        { file, nodeId },
      )
    }
    seen.add(nodeId)
    const optional = (field: string): string | undefined => {
      const value = record[field]
      if (value === undefined) return undefined
      if (typeof value !== 'string') {
        throw new CoordinatorError(
          'coordinator/invalid-arguments',
          `${file}: node record ${index} has a non-string "${field}"`,
          { file, index, field },
        )
      }
      return value
    }
    const nodeName = optional('nodeName')
    const role = optional('role')
    const revokedAt = optional('revokedAt')
    nodes.push({
      nodeId,
      token,
      ...(nodeName === undefined ? {} : { nodeName }),
      ...(role === undefined ? {} : { role }),
      ...(revokedAt === undefined ? {} : { revokedAt }),
    })
  }

  const enrollment = parseEnrollment(document['enrollment'], file)
  const apiToken = document['apiToken']
  if (apiToken !== undefined && (typeof apiToken !== 'string' || apiToken.trim() === '')) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      `${file}: "apiToken" must be a non-empty string when present`,
      { file },
    )
  }
  return {
    nodes,
    ...(typeof apiToken === 'string' ? { apiToken } : {}),
    ...(enrollment === undefined ? {} : { enrollment }),
  }
}

/** Validate the enrollment block without inventing a default for a broken one. */
function parseEnrollment(value: unknown, file: string): EnrollmentPolicy | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CoordinatorError('coordinator/invalid-arguments', `${file}: "enrollment" must be an object`, { file })
  }
  const raw = value as Record<string, unknown>
  if (raw['kind'] === 'closed') return { kind: 'closed' }
  if (raw['kind'] === 'shared-secret') {
    if (typeof raw['token'] !== 'string' || raw['token'] === '') {
      throw new CoordinatorError(
        'coordinator/invalid-arguments',
        `${file}: a shared-secret enrollment rule needs a non-empty token`,
        { file },
      )
    }
    return { kind: 'shared-secret', token: raw['token'] }
  }
  throw new CoordinatorError(
    'coordinator/invalid-arguments',
    `${file}: "enrollment.kind" must be "closed" or "shared-secret"`,
    { file, kind: String(raw['kind']) },
  )
}

/** Insert one validated state document inside the caller's transaction. */
function insertState(db: SqlDatabase, state: CoordinatorState): void {
  const insert = db.prepare(
    `INSERT INTO nodes (node_id, token, node_name, role, revoked_at) VALUES (?, ?, ?, ?, ?)`,
  )
  for (const record of state.nodes) {
    insert.run(
      record.nodeId,
      record.token,
      record.nodeName ?? null,
      record.role ?? null,
      record.revokedAt ?? null,
    )
  }
  if (state.enrollment !== undefined) {
    db.prepare('INSERT INTO enrollment (singleton_id, kind, token) VALUES (1, ?, ?)')
      .run(state.enrollment.kind, state.enrollment.kind === 'shared-secret' ? state.enrollment.token : null)
  }
  if (state.apiToken !== undefined) writeSetting(db, API_TOKEN_SETTING_KEY, state.apiToken)
}

/**
 * Import the legacy state file into an empty database, exactly once.
 *
 * A database that already has a migration record is left alone, whatever the file
 * now says: the point of the record is that the file is no longer the truth. A
 * database that already has nodes but no record refuses to import, because that
 * combination means two sources of truth and guessing which one wins would be a
 * coin flip with credentials.
 * @param database - the open, migrated database.
 * @param legacyFile - absolute path to the old JSON.
 * @returns what happened.
 */
export async function importLegacyState(
  database: CoordinatorDatabase,
  legacyFile: string,
): Promise<ImportOutcome> {
  const existing = readMigrationRecord(database.db)
  if (existing !== undefined) return { imported: false, record: existing }

  const state = await readLegacyState(legacyFile)
  if (state === undefined) return { imported: false }

  const nodeCount = database.db.prepare('SELECT COUNT(*) AS count FROM nodes').get()?.['count']
  if (typeof nodeCount === 'bigint' ? nodeCount > 0n : Number(nodeCount ?? 0) > 0) {
    throw new CoordinatorError(
      'coordinator/storage-unavailable',
      `${legacyFile} exists but the database already holds nodes and no migration record; refusing to guess which one is authoritative`,
      { legacyFile },
    )
  }

  const record: MigrationRecord = {
    source: resolve(legacyFile),
    importedAt: new Date().toISOString(),
    nodes: state.nodes.length,
    enrollment: state.enrollment === undefined || state.enrollment.kind === 'closed' ? 'closed' : 'shared-secret',
  }
  inTransaction(database.db, () => {
    insertState(database.db, state)
    writeSetting(database.db, MIGRATION_SETTING_KEY, record)
  })

  // Committed. The rename is bookkeeping from here on: the marker above already
  // guarantees the import never runs twice, so a failed rename is a cleanup note
  // rather than a reason to fail startup.
  const backupFile = `${legacyFile}.migrated.bak`
  try {
    await rename(legacyFile, backupFile)
    return { imported: true, backupFile, record }
  } catch (error) {
    return {
      imported: true,
      record,
      backupError: `${legacyFile} could not be renamed to ${backupFile}: ${(error as Error).message}`,
    }
  }
}

/**
 * Read the persisted state.
 * @param db - the database.
 * @returns the state document, with the same shape the JSON file had.
 */
export function loadCoordinatorState(db: SqlDatabase): CoordinatorState {
  const rows = db.prepare('SELECT node_id, token, node_name, role, revoked_at FROM nodes ORDER BY node_id').all()
  const nodes: NodeRecord[] = rows.map(row => {
    const nodeId = String(row['node_id'])
    const token = String(row['token'])
    const nodeName = row['node_name']
    const role = row['role']
    const revokedAt = row['revoked_at']
    return {
      nodeId,
      token,
      ...(typeof nodeName === 'string' ? { nodeName } : {}),
      ...(typeof role === 'string' ? { role } : {}),
      ...(typeof revokedAt === 'string' ? { revokedAt } : {}),
    }
  })
  const enrollmentRow = db.prepare('SELECT kind, token FROM enrollment WHERE singleton_id = 1').get()
  let enrollment: EnrollmentPolicy | undefined
  if (enrollmentRow?.['kind'] === 'shared-secret') {
    const token = enrollmentRow['token']
    if (typeof token === 'string' && token !== '') enrollment = { kind: 'shared-secret', token }
  } else if (enrollmentRow?.['kind'] === 'closed') {
    enrollment = { kind: 'closed' }
  }
  const apiToken = readSetting<string>(db, API_TOKEN_SETTING_KEY)
  return {
    nodes,
    ...(enrollment === undefined ? {} : { enrollment }),
    ...(typeof apiToken === 'string' && apiToken !== '' ? { apiToken } : {}),
  }
}

/**
 * Persist the registry's current records and enrollment rule.
 *
 * Only those two things: the operator token, administrator, sessions and usage
 * live in their own tables and a generic "save everything" would overwrite them
 * with whatever the caller happened to hold.
 * @param db - the database.
 * @param state - the records and the rule.
 */
export function saveCoordinatorState(db: SqlDatabase, state: CoordinatorState): void {
  inTransaction(db, () => {
    const upsert = db.prepare(
      `INSERT INTO nodes (node_id, token, node_name, role, revoked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         token = excluded.token,
         node_name = excluded.node_name,
         role = excluded.role,
         revoked_at = excluded.revoked_at`,
    )
    for (const record of state.nodes) {
      upsert.run(
        record.nodeId,
        record.token,
        record.nodeName ?? null,
        record.role ?? null,
        record.revokedAt ?? null,
      )
    }
    if (state.enrollment !== undefined) {
      db.prepare(
        `INSERT INTO enrollment (singleton_id, kind, token) VALUES (1, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET kind = excluded.kind, token = excluded.token`,
      ).run(state.enrollment.kind, state.enrollment.kind === 'shared-secret' ? state.enrollment.token : null)
    }
  })
}

/** Store the operator bearer token; `undefined` clears it. */
export function saveOperatorToken(db: SqlDatabase, token: string | undefined): void {
  inTransaction(db, () => {
    if (token === undefined) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(API_TOKEN_SETTING_KEY)
      return
    }
    writeSetting(db, API_TOKEN_SETTING_KEY, token)
  })
}
