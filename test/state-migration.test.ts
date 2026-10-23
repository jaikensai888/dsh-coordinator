/**
 * JSON -> SQLite migration: the one operation in this change that can lose a
 * credential if it is wrong.
 *
 * Every test here reads the *stored* value back rather than trusting the import
 * path's return value, and the failure cases check that nothing was partially
 * written — a half-imported allowlist is worse than a refused one, because it looks
 * like success.
 *
 * @module dsh-coordinator/test/state-migration
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openCoordinatorDatabase } from '../src/database.js'
import {
  importLegacyState,
  loadCoordinatorState,
  resolveDatabasePaths,
  saveCoordinatorState,
  toDatabaseFile,
} from '../src/state-migration.js'

const directories: string[] = []

/** A scratch directory, removed after the test. */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-coordinator-migrate-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A complete state document, as the old Coordinator wrote it. */
const LEGACY = {
  version: 1,
  apiToken: 'operator-token-that-must-survive',
  enrollment: { kind: 'shared-secret', token: 'enrollment-secret-that-must-survive' },
  nodes: [
    { nodeId: 'node-a', token: 'token-a', nodeName: 'Alpha', role: 'worker' },
    { nodeId: 'node-b', token: 'token-b', revokedAt: '2026-01-01T00:00:00.000Z' },
  ],
}

describe('path resolution', () => {
  it('maps the default state file onto coordinator.sqlite', () => {
    const paths = resolveDatabasePaths({}, join('C:', 'work'))
    expect(paths.dbFile).toBe(join('C:', 'work', 'coordinator.sqlite'))
    expect(paths.legacyFile).toBe(join('C:', 'work', 'coordinator-state.json'))
  })

  it('maps a.json to a.sqlite so two instances in one directory do not share a database', () => {
    expect(toDatabaseFile(join('C:', 'work', 'a.json'))).toBe(join('C:', 'work', 'a.sqlite'))
    expect(toDatabaseFile(join('C:', 'work', 'b.json'))).toBe(join('C:', 'work', 'b.sqlite'))
    expect(toDatabaseFile(join('C:', 'work', 'coordinator-state.json'))).toBe(join('C:', 'work', 'coordinator.sqlite'))
  })

  it('refuses --db-file together with --state-file', () => {
    expect(() => resolveDatabasePaths({ dbFile: 'a.sqlite', stateFile: 'a.json' }, 'C:/work'))
      .toThrow(/only one/u)
  })

  it('keeps --no-state-file as a real in-memory mode', () => {
    expect(resolveDatabasePaths({ noStateFile: true }, 'C:/work').dbFile).toBeNull()
    expect(() => resolveDatabasePaths({ noStateFile: true, dbFile: 'a.sqlite' }, 'C:/work'))
      .toThrow(/contradict/u)
  })

  it('accepts a custom migration source only with --db-file', () => {
    expect(() => resolveDatabasePaths({ migrateStateFile: 'old.json' }, 'C:/work')).toThrow(/together with --db-file/u)
  })
})

describe('importing the old state', () => {
  it('preserves every node field, the enrollment secret and the operator token', async () => {
    const directory = await scratch()
    const file = join(directory, 'coordinator-state.json')
    await writeFile(file, JSON.stringify(LEGACY), 'utf8')
    const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
    try {
      const outcome = await importLegacyState(database, file)
      expect(outcome.imported).toBe(true)
      expect(outcome.backupFile).toBe(`${file}.migrated.bak`)
      const state = loadCoordinatorState(database.db)
      expect(state.nodes).toHaveLength(2)
      expect(state.nodes.find(node => node.nodeId === 'node-a')).toEqual({
        nodeId: 'node-a',
        token: 'token-a',
        nodeName: 'Alpha',
        role: 'worker',
      })
      // A revoked node stays revoked; resurfacing it would silently re-authorise a
      // machine an operator had removed.
      expect(state.nodes.find(node => node.nodeId === 'node-b')?.revokedAt).toBe('2026-01-01T00:00:00.000Z')
      expect(state.enrollment).toEqual({ kind: 'shared-secret', token: 'enrollment-secret-that-must-survive' })
      expect(state.apiToken).toBe('operator-token-that-must-survive')
    } finally {
      database.close()
    }
  })

  it('renames the JSON to a backup and never imports twice', async () => {
    const directory = await scratch()
    const file = join(directory, 'coordinator-state.json')
    await writeFile(file, JSON.stringify(LEGACY), 'utf8')
    const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
    try {
      await importLegacyState(database, file)
      const names = await readdir(directory)
      expect(names).toContain('coordinator-state.json.migrated.bak')
      expect(names).not.toContain('coordinator-state.json')
      // Even if the JSON reappears, the marker in the database wins.
      await writeFile(file, JSON.stringify({ version: 1, nodes: [{ nodeId: 'node-z', token: 'token-z' }] }), 'utf8')
      const second = await importLegacyState(database, file)
      expect(second.imported).toBe(false)
      expect(loadCoordinatorState(database.db).nodes.map(node => node.nodeId).sort()).toEqual(['node-a', 'node-b'])
    } finally {
      database.close()
    }
  })

  it('refuses a broken document without importing any of it', async () => {
    const directory = await scratch()
    const file = join(directory, 'coordinator-state.json')
    await writeFile(file, '{"nodes": [{"nodeId": "node-a", "token": "token-a"}, {"nodeId": "node-b"}]}', 'utf8')
    const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
    try {
      await expect(importLegacyState(database, file)).rejects.toThrow(/no token/u)
      expect(loadCoordinatorState(database.db).nodes).toHaveLength(0)
    } finally {
      database.close()
    }
  })

  it('refuses malformed JSON rather than starting empty', async () => {
    const directory = await scratch()
    const file = join(directory, 'coordinator-state.json')
    await writeFile(file, '{not json', 'utf8')
    const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
    try {
      await expect(importLegacyState(database, file)).rejects.toThrow(/not valid JSON/u)
    } finally {
      database.close()
    }
  })

  it('refuses to import into a database that already has nodes but no marker', async () => {
    const directory = await scratch()
    const file = join(directory, 'coordinator-state.json')
    await writeFile(file, JSON.stringify(LEGACY), 'utf8')
    const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
    try {
      saveCoordinatorState(database.db, {
        nodes: [{ nodeId: 'manual', token: 'manual-token' }],
      })
      await expect(importLegacyState(database, file)).rejects.toThrow(/refusing to guess/u)
      // The manual record is untouched.
      expect(loadCoordinatorState(database.db).nodes.map(node => node.nodeId)).toEqual(['manual'])
    } finally {
      database.close()
    }
  })

  it('is a no-op for a fresh install with no JSON', async () => {
    const directory = await scratch()
    const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
    try {
      const outcome = await importLegacyState(database, join(directory, 'coordinator-state.json'))
      expect(outcome.imported).toBe(false)
      expect(loadCoordinatorState(database.db).nodes).toHaveLength(0)
    } finally {
      database.close()
    }
  })

  it('keeps the backup bytes identical to the source', async () => {
    const directory = await scratch()
    const file = join(directory, 'coordinator-state.json')
    const contents = `${JSON.stringify(LEGACY, null, 2)}\n`
    await writeFile(file, contents, 'utf8')
    const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
    try {
      await importLegacyState(database, file)
      expect(await readFile(`${file}.migrated.bak`, 'utf8')).toBe(contents)
    } finally {
      database.close()
    }
  })
})
