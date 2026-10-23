/**
 * Cross-implementation check: a batch produced by the **node's** real queue and
 * Remote owner must be accepted by the **Coordinator's** parser and stored by its
 * repository.
 *
 * This is the test that keeps the two hand-written copies of the contract honest.
 * Both packages implement the same fields independently (they do not import each
 * other at runtime), so the only proof that they agree is to feed one side's output
 * to the other side's input — which is exactly what happens here, using the built
 * `dsh-node` package.
 *
 * @module dsh-coordinator/test/usage-cross-implementation
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeUsageOwner, NodeUsageStore } from 'dsh-node'
import { openCoordinatorDatabase, type CoordinatorDatabase } from '../src/database.js'
import { UsageRepository } from '../src/usage/repository.js'
import { UsageQueries } from '../src/usage/query.js'
import { parseUsageBatch, type UsageStatus } from '../src/usage/types.js'

const directories: string[] = []
const databases: CoordinatorDatabase[] = []
const stores: NodeUsageStore[] = []

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-usage-cross-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // Already closed.
    }
  }
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A node queue with two calls and a finished one. */
async function nodeQueue(): Promise<{ store: NodeUsageStore; owner: NodeUsageOwner; collectorId: string }> {
  const store = NodeUsageStore.open({ file: join(await scratch(), 'usage.sqlite'), nodeId: 'node-cross' })
  stores.push(store)
  store.appendAttempt({
    attemptId: 'attempt-1',
    startedAt: '2026-10-23T01:00:00.000Z',
    endedAt: '2026-10-23T01:00:02.000Z',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    sessionId: 'session-1',
    purpose: 'conversation',
    state: 'completed',
    usageReported: true,
    usage: {
      uncachedInputTokens: '5',
      cacheReadTokens: '3',
      cacheWriteTokens: '0',
      outputTokens: '2',
      reasoningTokens: '1',
      totalTokens: '10',
    },
    source: 'runtime',
  })
  store.appendAttempt({
    attemptId: 'attempt-2',
    startedAt: '2026-10-23T01:05:00.000Z',
    endedAt: '2026-10-23T01:05:01.000Z',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    sessionId: 'session-1',
    purpose: 'compaction',
    state: 'failed',
    // No usage at all: the Coordinator must store "unknown", not zero.
    usageReported: false,
    usage: {
      uncachedInputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    },
    source: 'runtime',
  })
  return { store, owner: new NodeUsageOwner({ store }), collectorId: store.collectorId }
}

/** Drain the queue through the node's own Remote owner. */
async function drain(owner: NodeUsageOwner, collectorId: string): Promise<unknown[]> {
  const batches: unknown[] = []
  let afterSeq = '0'
  for (;;) {
    const batch = owner.read({ collectorId, afterSeq, limit: 200, maxBytes: 262_144 }) as unknown as {
      nextSeq: string
      hasMore: boolean
      events: unknown[]
    }
    batches.push(batch)
    afterSeq = batch.nextSeq
    if (!batch.hasMore) return batches
    if (batch.events.length === 0) return batches
  }
}

describe('node output through Coordinator input', () => {
  it('parses and stores a batch produced by the real node queue', async () => {
    const { owner, collectorId } = await nodeQueue()
    const batches = await drain(owner, collectorId)
    expect(batches.length).toBeGreaterThan(0)
    const parsed = batches.map(batch => parseUsageBatch(batch))
    expect(parsed[0]?.collectorId).toBe(collectorId)
    expect(parsed.flatMap(batch => batch.events)).toHaveLength(2)

    const database = openCoordinatorDatabase({ file: join(await scratch(), 'coordinator.sqlite') })
    databases.push(database)
    const repository = new UsageRepository({ db: database.db })
    let cursor = '0'
    for (const batch of parsed) {
      const result = repository.ingest('node-cross', batch)
      cursor = result.cursorSeq
      owner.ack({ collectorId, throughSeq: result.ackThroughSeq })
    }
    expect(cursor).toBe('2')
    const queries = new UsageQueries({
      db: database.db,
      repository,
      nodes: { list: () => [{ nodeId: 'node-cross', nodeName: 'Cross', state: 'ready', revoked: false }] },
      now: () => Date.parse('2026-10-23T12:00:00.000Z'),
    })
    const summary = queries.summary({
      from: '2026-10-22T00:00:00+08:00',
      to: '2026-10-24T00:00:00+08:00',
    })
    expect(summary.totals.requestCount).toBe('2')
    expect(summary.totals.knownTokens).toBe('10')
    expect(summary.totals.unknownUsageCount).toBe('1')
    expect(summary.totals.failedCount).toBe('1')
  })

  it('agrees on the collector status fields', async () => {
    const { owner, collectorId } = await nodeQueue()
    const status = owner.status() as UsageStatus
    const parsed = parseUsageBatch({
      schemaVersion: 1,
      collectorId,
      events: [],
      gaps: [],
      nextSeq: '0',
      hasMore: false,
      status,
    })
    expect(parsed.status.collectorId).toBe(collectorId)
    expect(parsed.status.pendingCount).toBe('2')
    expect(parsed.status.coverage).toBe('complete')
  })

  it('passes a pruned-prefix gap through unchanged', async () => {
    const store = NodeUsageStore.open({ file: join(await scratch(), 'usage.sqlite'), nodeId: 'node-pruned' })
    stores.push(store)
    store.appendAttempt({
      attemptId: 'a',
      startedAt: '2026-10-23T01:00:00.000Z',
      endedAt: '2026-10-23T01:00:02.000Z',
      provider: 'p',
      model: 'm',
      sessionId: null,
      purpose: 'other',
      state: 'completed',
      usageReported: true,
      usage: {
        uncachedInputTokens: '1',
        cacheReadTokens: '0',
        cacheWriteTokens: '0',
        outputTokens: '1',
        reasoningTokens: null,
        totalTokens: '2',
      },
      source: 'runtime',
    })
    const owner = new NodeUsageOwner({ store })
    const collectorId = store.collectorId
    // Ask for a page from a cursor that no longer exists after a reset.
    const batch = owner.read({ collectorId, afterSeq: '0', limit: 10, maxBytes: 262_144 })
    const parsed = parseUsageBatch(batch)
    expect(parsed.events).toHaveLength(1)
    expect(parsed.gaps).toEqual([])
  })
})
