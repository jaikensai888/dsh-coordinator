/**
 * A tiny synchronous SQLite surface, with two interchangeable drivers.
 *
 * Why a wrapper at all: `node:sqlite` is present in the DSH host (Node 24.21,
 * measured) and in every Node >= 22.5, while `better-sqlite3` is the dependency
 * the contract names. Both are synchronous, and both expose the same
 * `exec`/`prepare`/`run`/`get`/`all` shape, so the rest of the service can be
 * written once against this interface and pick a driver at open time.
 *
 * The project still declares `engines: node >= 20`. On a Node 20 host neither
 * driver is available, so {@link openSqliteDatabase} fails with a clear,
 * actionable error instead of a `Cannot find module` at import time. That is a
 * measured compatibility fact, recorded in `docs/usage-compatibility.md`, not an
 * assumption.
 *
 * @module dsh-coordinator/sqlite
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { CoordinatorError } from './errors.js'

/** A value SQLite can bind. `bigint` keeps 64-bit integers exact. */
export type SqlValue = string | number | bigint | null | Uint8Array

/** What a write reports back. */
export interface SqlRunResult {
  readonly changes: number | bigint
  readonly lastInsertRowid: number | bigint
}

/** One prepared statement. */
export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult
  get(...params: SqlValue[]): Record<string, unknown> | undefined
  all(...params: SqlValue[]): Record<string, unknown>[]
}

/** Which implementation is actually loaded. */
export type SqlDriverName = 'node:sqlite' | 'better-sqlite3'

/** An open database. */
export interface SqlDatabase {
  readonly driver: SqlDriverName
  readonly file: string
  exec(sql: string): void
  /**
   * Prepare a statement.
   * @param sql - the statement text.
   * @param options - `bigint: true` makes INTEGER columns come back as `bigint`,
   * which is what every token column needs: a 64-bit token count is not a JS
   * number, and silently rounding it would corrupt a total.
   */
  prepare(sql: string, options?: { readonly bigint?: boolean }): SqlStatement
  close(): void
}

/** Options for {@link openSqliteDatabase}. */
export interface OpenSqliteOptions {
  /** An in-memory database, used only by `--no-state-file`. */
  readonly memory?: boolean
}

/** The `node:sqlite` module, as much of it as this file uses. */
interface NodeSqliteModule {
  DatabaseSync: new (path: string) => DriverRaw
}

/** The shared shape both drivers expose. */
interface DriverRaw {
  exec(sql: string): void
  prepare(sql: string): DriverStatement
  close(): void
}

interface DriverStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  setReadBigInts?(enabled: boolean): void
  safeIntegers?(enabled: boolean): void
}

/** The `better-sqlite3` module, as much of it as this file uses. */
interface BetterSqlite3Module {
  default?: new (path: string) => DriverRaw
  new (path: string): DriverRaw
}

interface DriverHandle {
  readonly driver: SqlDriverName
  readonly raw: DriverRaw
}

const require = createRequire(import.meta.url)

/** Load `node:sqlite`, or undefined on a Node that predates it. */
function loadNodeSqlite(): NodeSqliteModule | undefined {
  try {
    return require('node:sqlite') as NodeSqliteModule
  } catch {
    return undefined
  }
}

/**
 * Load `better-sqlite3`, or undefined when it is not installed.
 *
 * Optional on purpose: the package is a native module, and
 * `docs/usage-compatibility.md` records why this deployment cannot assume it is
 * present. When it *is* installed it wins, because the contract names it.
 */
function loadBetterSqlite3(): BetterSqlite3Module | undefined {
  try {
    return require('better-sqlite3') as BetterSqlite3Module
  } catch {
    return undefined
  }
}

/** Pick the driver, preferring the one the contract names. */
function loadDriver(file: string): DriverHandle {
  const better = loadBetterSqlite3()
  if (better !== undefined) {
    const Database = (better.default ?? better) as unknown as new (path: string) => DriverRaw
    return { driver: 'better-sqlite3', raw: new Database(file) }
  }
  const nodeSqlite = loadNodeSqlite()
  if (nodeSqlite !== undefined) {
    return { driver: 'node:sqlite', raw: new nodeSqlite.DatabaseSync(file) }
  }
  throw new CoordinatorError(
    'coordinator/sqlite-unavailable',
    'no SQLite driver is available: this Node has no node:sqlite (needs Node >= 22.5) and better-sqlite3 is not installed',
    { node: process.versions.node },
  )
}

/**
 * Open (or create) a database and apply the pragmas the contract requires.
 *
 * `foreign_keys`, WAL, `synchronous=FULL` and a 1000 ms busy timeout are not
 * tunables here: they are the durability contract for credentials, sessions and
 * usage, and a caller that could relax them could silently turn an ACK into a
 * promise the disk never made.
 * @param file - absolute path, or any path when `memory` is set.
 * @param options - `memory` for a throwaway database.
 * @returns the open database.
 * @throws CoordinatorError `coordinator/sqlite-unavailable` when no driver loads.
 * @throws CoordinatorError `coordinator/storage-unavailable` when the file cannot
 * be created or opened.
 */
export function openSqliteDatabase(file: string, options: OpenSqliteOptions = {}): SqlDatabase {
  const target = options.memory === true ? ':memory:' : file
  if (options.memory !== true) {
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch (error) {
      throw new CoordinatorError(
        'coordinator/storage-unavailable',
        `the database directory could not be created: ${(error as Error).message}`,
        { file },
      )
    }
  }
  let handle: DriverHandle
  try {
    handle = loadDriver(target)
  } catch (error) {
    if (error instanceof CoordinatorError) throw error
    throw new CoordinatorError(
      'coordinator/storage-unavailable',
      `the database could not be opened: ${(error as Error).message}`,
      { file: target },
    )
  }

  const database: SqlDatabase = {
    driver: handle.driver,
    file: target,
    exec: (sql: string) => { handle.raw.exec(sql) },
    prepare: (sql: string, prepareOptions?: { readonly bigint?: boolean }) => {
      const statement = handle.raw.prepare(sql)
      if (prepareOptions?.bigint === true) {
        statement.setReadBigInts?.(true)
        statement.safeIntegers?.(true)
      }
      return {
        run: (...params: SqlValue[]) => statement.run(...params),
        get: (...params: SqlValue[]) => asRow(statement.get(...params)),
        all: (...params: SqlValue[]) => {
          const rows = statement.all(...params)
          return rows.map(row => asRow(row)).filter((row): row is Record<string, unknown> => row !== undefined)
        },
      }
    },
    close: () => { handle.raw.close() },
  }

  if (options.memory !== true) {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = FULL')
    database.exec('PRAGMA busy_timeout = 1000')
  }
  return database
}

/** Normalise a driver row to a plain object of known values. */
function asRow(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') return undefined
  return { ...(value as Record<string, unknown>) }
}

/**
 * Run `work` inside one immediate transaction, rolling back on any throw.
 *
 * `BEGIN IMMEDIATE` rather than the default deferred transaction: the writes this
 * service makes are all read-then-write (allocate the next sequence number,
 * compare a revision, advance a cursor), and a deferred transaction that upgrades
 * to a writer mid-way can fail with `SQLITE_BUSY` on a database another process
 * holds. Taking the write lock up front turns that into a wait bounded by
 * `busy_timeout`.
 * @param db - the database.
 * @param work - the unit of work. Must be synchronous.
 * @returns whatever `work` returns, after the commit.
 */
export function inTransaction<T>(db: SqlDatabase, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = work()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // A rollback that fails means the transaction was already gone; the
      // original error is the one worth reporting.
    }
    throw error
  }
}
