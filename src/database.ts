/**
 * Opening and closing the Coordinator's one database.
 *
 * Everything that outlives the process lives here: node credentials, the
 * enrollment rule, the administrator, sessions and usage. Opening runs the
 * versioned migrations; a failure closes the handle again rather than leaving a
 * half-open database behind a service that then behaves as if it had no state.
 *
 * Deliberately **not** a singleton and deliberately not a connection pool. SQLite
 * in WAL mode with one writer is the whole design; the service is documented as
 * single-instance for writes, and `busy_timeout` covers the brief overlap with a
 * maintenance CLI that takes the write lock.
 *
 * @module dsh-coordinator/database
 */

import { CoordinatorError, isCoordinatorError } from './errors.js'
import { migrateDatabase, SCHEMA_VERSION } from './db-schema.js'
import { inTransaction, openSqliteDatabase, type SqlDatabase, type SqlDriverName } from './sqlite.js'

/** Options for {@link openCoordinatorDatabase}. */
export interface CoordinatorDatabaseOptions {
  /** Absolute path, or ignored when `memory` is set. */
  readonly file: string
  /** Keep everything in memory. Only `--no-state-file` asks for this. */
  readonly memory?: boolean
}

/** An open, migrated database. */
export interface CoordinatorDatabase {
  readonly db: SqlDatabase
  readonly file: string
  readonly driver: SqlDriverName
  /** False for the in-memory database, which is what disables durable sync. */
  readonly persistent: boolean
  readonly schemaVersion: number
  close(): void
}

/**
 * Open the database and bring its schema up to date.
 * @param options - where the file is, or that it should be in memory.
 * @returns the open database.
 * @throws CoordinatorError `coordinator/sqlite-unavailable` when no driver can load.
 * @throws CoordinatorError `coordinator/storage-unavailable` when the file or a
 * migration is unusable.
 * @throws CoordinatorError `coordinator/schema-too-new` when written by a newer build.
 */
export function openCoordinatorDatabase(options: CoordinatorDatabaseOptions): CoordinatorDatabase {
  const memory = options.memory === true
  const database = openSqliteDatabase(memory ? ':memory:' : options.file, { memory })
  try {
    migrateDatabase(database)
  } catch (error) {
    // A database that cannot migrate must not stay open: the service would go on
    // to read an older schema with newer SQL and fail in a place that looks
    // unrelated.
    try {
      database.close()
    } catch {
      // Already unusable; the migration error is the one to report.
    }
    if (isCoordinatorError(error)) throw error
    throw new CoordinatorError(
      'coordinator/storage-unavailable',
      `the database could not be initialised: ${(error as Error).message}`,
      { file: options.file },
    )
  }
  return {
    db: database,
    file: database.file,
    driver: database.driver,
    persistent: !memory,
    schemaVersion: SCHEMA_VERSION,
    close: () => { database.close() },
  }
}

/** Read one `settings` value, parsed as JSON. */
export function readSetting<T>(db: SqlDatabase, key: string): T | undefined {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key)
  const text = row?.['value_json']
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** Write one `settings` value as JSON. */
export function writeSetting(db: SqlDatabase, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
  ).run(key, JSON.stringify(value))
}

/** Run a unit of work with the write lock held. Re-exported for the repository. */
export { inTransaction }
