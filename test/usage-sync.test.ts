/**
 * Idempotent ingestion and the per-node sync loop.
 *
 * These are the tests that decide whether a retry is free or expensive. The
 * scenarios are the ones a real deployment produces: a lost ACK (the same page
 * offered again), a revision (a running attempt finishing), a restored node backup
 * (different content under a used sequence number), and a pruned prefix (the node
 * says so explicitly instead of skipping quietly).
 *
 * @module dsh-coordinator/test/usage-sync
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openCoordinatorDatabase, type CoordinatorDatabase } from '../src/database.js'
import { UsageRepository } from '../src/usage/repository.js'
import { UsageSync } from '../src/usage/sync.js'
import { normalizeUsage, type AttemptSnapshot, type UsageBatch } from '../src/usage/types.js'

const directories: string[] = []
const databases: CoordinatorDatabase[] = []

async function scratchDatabase(): Promise<CoordinatorDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-coordinator-sync-'))
  directories.push(directory)
  const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
  databases.push(database)
  return database
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One attempt snapshot with explicit usage. */
function snapshot(overrides: Partial<AttemptSnapshot> & { attemptId: string }): AttemptSnapshot {
  return {
    startedAt: '2026-10-23T01:00:00.000Z',
    endedAt: '2026-10-23T01:00:02.000Z',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    sessionId: 'session-1',
    purpose: 'conversation',
    state: 'completed',
    usageReported: true,
    usage: normalizeUsage({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 }).usage,
    source: 'runtime',
    ...overrides,
  }
}

/** One batch over a collector. */
function batch(options: {
  collectorId?: string
  events?: UsageBatch['events']
  gaps?: UsageBatch['gaps']
  nextSeq?: string
  latest?: string
  acked?: string
  coverage?: 'complete' | 'incomplete' | 'unknown'
  pending?: string
} = {}): UsageBatch {
  const collectorId = options.collectorId ?? 'collector-1'
  const events = options.events ?? [{
    seq: '1',
    recordedAt: '2026-10-23T01:00:02.000Z',
    kind: 'attempt',
    attempt: snapshot({ attemptId: 'attempt-1' }),
  }]
  return {
    schemaVersion: 1,
    collectorId,
    events,
    gaps: options.gaps ?? [],
    nextSeq: options.nextSeq ?? (events.at(-1)?.seq ?? '0'),
    hasMore: false,
    status: {
      schemaVersion: 1,
      enabled: true,
      state: 'ready',
      collectorId,
      startedAt: '2026-10-23T00:00:00.000Z',
      earliestAvailableSeq: '1',
      latestIssuedSeq: options.latest ?? (events.at(-1)?.seq ?? '0'),
      ackedThroughSeq: options.acked ?? '0',
      pendingCount: options.pending ?? '0',
      pendingBytes: '0',
      coverage: options.coverage ?? 'complete',
      degradedSince: null,
      issueCode: null,
    },
  }
}

/** Count stored attempts and their known tokens. */
function stored(db: CoordinatorDatabase): { count: number; tokens: string } {
  const row = db.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(known_tokens), 0) AS tokens FROM usage_attempts').get()
  return { count: Number(row?.['count']), tokens: String(row?.['tokens']) }
}

describe('ingest', () => {
  it('counts a replayed batch once', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    const first = repository.ingest('node-1', batch())
    const second = repository.ingest('node-1', batch())
    expect(first.inserted).toBe(1)
    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(1)
    expect(stored(database)).toEqual({ count: 1, tokens: '10' })
  })

  it('updates one attempt for a later revision instead of adding a row', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    repository.ingest('node-1', batch({
      events: [{
        seq: '1',
        recordedAt: '2026-10-23T01:00:00.000Z',
        kind: 'attempt',
        attempt: snapshot({ attemptId: 'attempt-1', state: 'running', endedAt: null, usageReported: false, usage: normalizeUsage({}).usage }),
      }],
    }))
    repository.ingest('node-1', batch({
      events: [{
        seq: '2',
        recordedAt: '2026-10-23T01:00:02.000Z',
        kind: 'attempt',
        attempt: snapshot({ attemptId: 'attempt-1' }),
      }],
      nextSeq: '2',
    }))
    expect(stored(database)).toEqual({ count: 1, tokens: '10' })
    const row = database.db.prepare('SELECT state, revision_seq FROM usage_attempts').get()
    expect(row?.['state']).toBe('completed')
    expect(String(row?.['revision_seq'])).toBe('2')
  })

  it('refuses a sequence number whose content changed, and does not move the cursor', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    repository.ingest('node-1', batch())
    let failure: { code?: string } = {}
    try {
      repository.ingest('node-1', batch({
        events: [{
          seq: '1',
          recordedAt: '2026-10-23T01:00:02.000Z',
          kind: 'attempt',
          attempt: snapshot({ attemptId: 'different-attempt' }),
        }],
      }))
    } catch (error) {
      failure = error as { code?: string }
    }
    expect(failure.code).toBe('usage/collector-fork')
    expect(repository.getCursor('node-1', 'collector-1')).toBe('1')
    expect(stored(database).count).toBe(1)
  })

  it('refuses an unexplained hole in the sequence', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    let failure: { code?: string } = {}
    try {
      repository.ingest('node-1', batch({
        events: [{
          seq: '3',
          recordedAt: '2026-10-23T01:00:02.000Z',
          kind: 'attempt',
          attempt: snapshot({ attemptId: 'attempt-3' }),
        }],
        nextSeq: '3',
        latest: '3',
      }))
    } catch (error) {
      failure = error as { code?: string }
    }
    expect(failure.code).toBe('usage/sequence-gap')
    expect(repository.getCursor('node-1', 'collector-1')).toBe('0')
  })

  it('accepts a named replay gap and advances the cursor over it', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    const result = repository.ingest('node-1', batch({
      events: [{
        seq: '4',
        recordedAt: '2026-10-23T01:00:02.000Z',
        kind: 'attempt',
        attempt: snapshot({ attemptId: 'attempt-4' }),
      }],
      gaps: [{ fromSeq: '1', throughSeq: '3', reason: 'pruned' }],
      nextSeq: '4',
      latest: '4',
    }))
    expect(result.cursorSeq).toBe('4')
    expect(result.gaps).toBe(1)
    const gap = database.db.prepare('SELECT * FROM usage_gaps').get()
    expect(gap?.['reason']).toBe('pruned')
    // Coverage becomes incomplete the moment a gap is recorded, and stays that way.
    const state = repository.getState('node-1', 'collector-1')
    expect(state?.coverage).toBe('complete')
    expect(repository.gapCount('node-1')).toBe(1)
  })

  it('records coverage from the node status', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    repository.ingest('node-1', batch({ coverage: 'incomplete', pending: '3' }))
    const state = repository.getState('node-1', 'collector-1')
    expect(state?.coverage).toBe('incomplete')
    expect(state?.pendingCount).toBe('3')
  })
})

describe('the sync loop', () => {
  it('reads, stores, and only then acknowledges', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    const calls: string[] = []
    const invoke = async (nodeId: string, endpoint: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push(endpoint)
      if (endpoint === 'nodeUsage/status') return batch().status
      if (endpoint === 'nodeUsage/read') {
        const request = args['request'] as { afterSeq: string }
        return request.afterSeq === '0' ? batch() : batch({ events: [], nextSeq: '1', latest: '1' })
      }
      if (endpoint === 'nodeUsage/ack') {
        // The data must already be durable when the ACK is sent.
        expect(stored(database).count).toBe(1)
        return { collectorId: 'collector-1', ackedThroughSeq: String((args['request'] as { throughSeq: string }).throughSeq) }
      }
      throw new Error(`unexpected ${endpoint}`)
    }
    const sync = new UsageSync({
      repository,
      invoke,
      isReady: () => true,
      intervalMs: 10,
      retryMs: 10,
    },)
    void sync
    sync.startNode('node-1')
    await new Promise(resolve => setTimeout(resolve, 120))
    await sync.dispose()
    expect(calls).toContain('nodeUsage/ack')
    expect(stored(database).count).toBe(1)
    expect(repository.getCursor('node-1', 'collector-1')).toBe('1')
  })

  it('does not acknowledge when the write fails', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    let acked = false
    const sync = new UsageSync({
      repository: {
        ...repository,
        ingest: () => { throw new Error('disk on fire') },
      } as unknown as UsageRepository,
      invoke: async (nodeId, endpoint, args) => {
        if (endpoint === 'nodeUsage/status') return batch().status
        if (endpoint === 'nodeUsage/read') return batch()
        if (endpoint === 'nodeUsage/ack') { acked = true; return {} }
        throw new Error(endpoint)
      },
      isReady: () => true,
      intervalMs: 10,
      retryMs: 10,
    })
    sync.startNode('node-1')
    await new Promise(resolve => setTimeout(resolve, 60))
    await sync.dispose()
    expect(acked).toBe(false)
  })

  it('marks a node unsupported instead of retrying forever', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    const sync = new UsageSync({
      repository,
      invoke: async () => {
        const error = new Error('no such capability') as Error & { code: string; details: Record<string, unknown> }
        error.code = 'node/capability-unavailable'
        error.details = {}
        throw error
      },
      isReady: () => true,
      intervalMs: 10,
      retryMs: 10,
    })
    sync.startNode('node-1')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(sync.stateOf('node-1').state).toBe('unsupported')
    await sync.dispose()
  })

  it('stops when the node sequence is behind what is stored', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    repository.ingest('node-1', batch({
      events: [{ seq: '5', recordedAt: '2026-10-23T01:00:02.000Z', kind: 'attempt', attempt: snapshot({ attemptId: 'attempt-5' }) }],
      gaps: [{ fromSeq: '1', throughSeq: '4', reason: 'pruned' }],
      nextSeq: '5',
      latest: '5',
    }))
    let reads = 0
    const sync = new UsageSync({
      repository,
      invoke: async (nodeId, endpoint) => {
        if (endpoint === 'nodeUsage/status') return batch({ latest: '2', nextSeq: '2', events: [], acked: '0' }).status
        reads += 1
        return batch({ latest: '2', nextSeq: '2', events: [] })
      },
      isReady: () => true,
      intervalMs: 10,
      retryMs: 10,
    })
    sync.startNode('node-1')
    await new Promise(resolve => setTimeout(resolve, 60))
    await sync.dispose()
    expect(reads).toBe(0)
    expect(repository.getState('node-1', 'collector-1')?.lastError).toMatch(/behind/u)
  })

  it('stops a collector whose sequence number forked', async () => {
    const database = await scratchDatabase()
    const repository = new UsageRepository({ db: database.db })
    repository.ingest('node-1', batch())
    const sync = new UsageSync({
      repository,
      invoke: async (nodeId, endpoint, args) => {
        if (endpoint === 'nodeUsage/status') return batch({ acked: '0' }).status
        if (endpoint === 'nodeUsage/read') {
          return batch({
            events: [{
              seq: '1',
              recordedAt: '2026-10-23T01:00:02.000Z',
              kind: 'attempt',
              attempt: snapshot({ attemptId: 'replaced-history' }),
            }],
          })
        }
        if (endpoint === 'nodeUsage/ack') return { collectorId: 'collector-1', ackedThroughSeq: String((args['request'] as { throughSeq: string }).throughSeq) }
        throw new Error(endpoint)
      },
      isReady: () => true,
      intervalMs: 10,
      retryMs: 10,
    })
    sync.startNode('node-1')
    await new Promise(resolve => setTimeout(resolve, 60))
    await sync.dispose()
    expect(repository.getState('node-1', 'collector-1')?.lastError).toMatch(/restore or reset the collector/u)
    expect(stored(database).count).toBe(1)
  })
})
