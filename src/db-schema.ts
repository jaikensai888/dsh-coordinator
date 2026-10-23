/**
 * The unified Coordinator schema, versioned by `schema_migrations`.
 *
 * One database holds everything the Coordinator remembers: node credentials, the
 * enrollment rule, the single administrator, their sessions, the audit trail, the
 * usage events pulled from nodes, and the cursors that say how far those pulls
 * got. The design note explains why there is one file instead of a JSON state file
 * plus a usage database; the short version is that two files can disagree, and the
 * pair that must never disagree is "this node's cursor" and "what we stored from
 * that node".
 *
 * Migrations are a list, applied in order, each inside its own transaction. A
 * database whose recorded version is newer than this code refuses to open rather
 * than trying to interpret a future schema.
 *
 * @module dsh-coordinator/db-schema
 */

import { CoordinatorError } from './errors.js'
import { inTransaction, type SqlDatabase } from './sqlite.js'

/** The schema version this build understands. */
export const SCHEMA_VERSION = 3

/** One forward migration. */
interface Migration {
  readonly version: number
  readonly statements: readonly string[]
}

/**
 * Every migration, oldest first.
 *
 * Written as literal SQL rather than generated from a model: a migration is a
 * historical record, and editing an old one rewrites history for databases that
 * already ran it.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS enrollment (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        kind TEXT NOT NULL,
        token TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        node_name TEXT,
        role TEXT,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS admin_users (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        kdf_json TEXT NOT NULL,
        credential_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES admin_users(singleton_id) ON DELETE CASCADE,
        credential_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        csrf_hash TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at)`,
      `CREATE TABLE IF NOT EXISTS auth_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        source_address TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS auth_audit_at ON auth_audit(at)`,
      `CREATE TABLE IF NOT EXISTS usage_events (
        node_id TEXT NOT NULL,
        collector_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (node_id, collector_id, seq)
      )`,
      `CREATE TABLE IF NOT EXISTS usage_attempts (
        node_id TEXT NOT NULL,
        collector_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        revision_seq INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        provider TEXT,
        model TEXT,
        session_id TEXT,
        purpose TEXT NOT NULL,
        state TEXT NOT NULL,
        usage_reported INTEGER NOT NULL,
        uncached_input_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        known_tokens INTEGER NOT NULL,
        PRIMARY KEY (node_id, collector_id, attempt_id)
      )`,
      `CREATE INDEX IF NOT EXISTS usage_attempts_started
        ON usage_attempts(node_id, started_at, collector_id, attempt_id)`,
      `CREATE INDEX IF NOT EXISTS usage_attempts_by_started ON usage_attempts(started_at)`,
      `CREATE INDEX IF NOT EXISTS usage_attempts_by_model ON usage_attempts(provider, model, started_at)`,
      `CREATE TABLE IF NOT EXISTS usage_sync_state (
        node_id TEXT NOT NULL,
        collector_id TEXT NOT NULL,
        cursor_seq INTEGER NOT NULL,
        last_synced_at TEXT,
        last_error TEXT,
        coverage TEXT NOT NULL,
        pending_count INTEGER,
        pending_bytes INTEGER,
        started_at TEXT,
        PRIMARY KEY (node_id, collector_id)
      )`,
      `CREATE TABLE IF NOT EXISTS usage_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL,
        collector_id TEXT NOT NULL,
        from_seq INTEGER,
        to_seq INTEGER,
        from_at TEXT,
        to_at TEXT,
        reason TEXT NOT NULL,
        detected_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS usage_gaps_lookup ON usage_gaps(node_id, collector_id, detected_at)`,
    ],
  },
  {
    // The retention window for the audit trail is a delete predicate, so it needs
    // an index that the cleanup can actually use.
    version: 2,
    statements: [
      `CREATE INDEX IF NOT EXISTS auth_audit_outcome ON auth_audit(outcome, at)`,
    ],
  },
  {
    // `gap` events carry a reason; the coverage summary needs to count them per
    // collector without scanning every event row.
    version: 3,
    statements: [
      `CREATE INDEX IF NOT EXISTS usage_events_kind ON usage_events(kind, node_id, collector_id)`,
    ],
  },
]

/**
 * Create or upgrade the schema.
 *
 * Each migration commits alone: a database that fails halfway through version 3
 * is at version 2, not in a half-applied state. That is what makes a subsequent
 * start able to retry instead of refusing forever.
 * @param db - an open database.
 * @throws CoordinatorError `coordinator/schema-too-new` when the database was
 * written by a newer build.
 * @throws CoordinatorError `coordinator/storage-unavailable` when a migration
 * fails.
 */
export function migrateDatabase(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
  const current = toVersion(row?.['version'])
  if (current > SCHEMA_VERSION) {
    throw new CoordinatorError(
      'coordinator/schema-too-new',
      `the database is at schema ${current}, but this build understands ${SCHEMA_VERSION}; start the newer Coordinator or restore a backup`,
      { databaseVersion: current, supportedVersion: SCHEMA_VERSION },
    )
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    try {
      inTransaction(db, () => {
        for (const statement of migration.statements) db.exec(statement)
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString())
      })
    } catch (error) {
      throw new CoordinatorError(
        'coordinator/storage-unavailable',
        `schema migration ${migration.version} failed: ${(error as Error).message}`,
        { version: migration.version },
      )
    }
  }
}

/** Read a migration version defensively; a foreign value means "unknown, newest". */
function toVersion(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  return 0
}
