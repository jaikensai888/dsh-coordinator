/**
 * The unified database: schema, transactions, and 64-bit integers.
 *
 * The integer tests are the point of this file. Every token column is a SQLite
 * INTEGER, which is 64-bit, while JavaScript numbers are exact only to 2^53 — so the
 * only acceptable behaviour is "the full range round-trips, and anything outside it
 * is refused". A silent coercion here would corrupt a total with no error anywhere.
 *
 * @module dsh-coordinator/test/database
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openCoordinatorDatabase } from '../src/database.js'
import { migrateDatabase, SCHEMA_VERSION } from '../src/db-schema.js'
import { inTransaction, openSqliteDatabase } from '../src/sqlite.js'

const directories: string[] = []

/** A scratch directory, removed after the test. */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-coordinator-db-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('opening the database', () => {
  it('creates every table the contract names', async () => {
    const file = join(await scratch(), 'coordinator.sqlite')
    const database = openCoordinatorDatabase({ file })
    try {
      const names = database.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map(row => String(row['name']))
      for (const table of [
        'schema_migrations',
        'settings',
        'enrollment',
        'nodes',
        'admin_users',
        'admin_sessions',
        'auth_audit',
        'usage_events',
        'usage_attempts',
        'usage_sync_state',
        'usage_gaps',
      ]) {
        expect(names, table).toContain(table)
      }
      expect(database.schemaVersion).toBe(SCHEMA_VERSION)
      expect(database.driver).toBe('node:sqlite')
    } finally {
      database.close()
    }
  })

  it('is idempotent: migrating again changes nothing', async () => {
    const file = join(await scratch(), 'coordinator.sqlite')
    const first = openCoordinatorDatabase({ file })
    first.close()
    const second = openCoordinatorDatabase({ file })
    try {
      const row = second.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()
      expect(Number(row?.['count'])).toBe(SCHEMA_VERSION)
    } finally {
      second.close()
    }
  })

  it('refuses a database written by a newer build', async () => {
    const file = join(await scratch(), 'coordinator.sqlite')
    const db = openSqliteDatabase(file)
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION + 1, new Date().toISOString())
    expect(() => migrateDatabase(db)).toThrow(/schema/u)
    db.close()
  })

  it('applies a migration in a transaction: a failure leaves no partial schema', () => {
    const db = openSqliteDatabase(':memory:', { memory: true })
    try {
      // An invalid statement after a valid one must roll the whole migration back.
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
      expect(() => {
        inTransaction(db, () => {
          db.exec('CREATE TABLE probe (a INTEGER)')
          db.exec('THIS IS NOT SQL')
        })
      }).toThrow()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row['name']))
      expect(tables).not.toContain('probe')
      expect(tables).toContain('schema_migrations')
    } finally {
      db.close()
    }
  })
})

describe('64-bit integers', () => {
  it('round-trips the largest SQLite INTEGER without loss', () => {
    const db = openSqliteDatabase(':memory:', { memory: true })
    try {
      db.exec('CREATE TABLE t (v INTEGER)')
      db.prepare('INSERT INTO t (v) VALUES (?)').run(9223372036854775807n)
      const row = db.prepare('SELECT v FROM t', { bigint: true }).get()
      expect(row?.['v']).toBe(9223372036854775807n)
      // And rendering it as a contract Decimal does not go through a JS number.
      expect(String(row?.['v'])).toBe('9223372036854775807')
    } finally {
      db.close()
    }
  })

  it('refuses a value beyond the 64-bit range instead of truncating it', () => {
    const db = openSqliteDatabase(':memory:', { memory: true })
    try {
      db.exec('CREATE TABLE t (v INTEGER)')
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
      expect(() => insert.run(9223372036854775808n)).toThrow()
    } finally {
      db.close()
    }
  })

  it('keeps a sum larger than MAX_SAFE_INTEGER exact across rows', () => {
    const db = openSqliteDatabase(':memory:', { memory: true })
    try {
      db.exec('CREATE TABLE t (v INTEGER)')
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
      insert.run(9007199254740993n)
      insert.run(9007199254740993n)
      const rows = db.prepare('SELECT v FROM t', { bigint: true }).all()
      const total = rows.reduce((sum: bigint, row) => sum + (row['v'] as bigint), 0n)
      // 18014398509481986: a number could not represent this exactly.
      expect(String(total)).toBe('18014398509481986')
    } finally {
      db.close()
    }
  })
})

describe('the database file', () => {
  it('is the only state written: no JSON file appears beside it', async () => {
    const directory = await scratch()
    const file = join(directory, 'coordinator.sqlite')
    const database = openCoordinatorDatabase({ file })
    database.close()
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(directory)
    expect(files).toContain('coordinator.sqlite')
    expect(files.some(name => name.endsWith('.json'))).toBe(false)
    // The SQLite header proves the file is a real database rather than a renamed JSON.
    const header = (await readFile(file)).subarray(0, 15).toString('utf8')
    expect(header).toBe('SQLite format 3')
  })
})
