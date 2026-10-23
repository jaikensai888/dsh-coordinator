/**
 * Usage reads: totals, trends, pagination, and the boundaries that are easy to get
 * subtly wrong (timezone day rollover, [from,to), and 64-bit sums).
 *
 * The rows are inserted directly: this file tests the read side, and going through
 * the sync loop for every fixture would only re-test ingestion. Ingestion has its
 * own tests in `usage-sync.test.ts`.
 *
 * @module dsh-coordinator/test/usage-query
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openCoordinatorDatabase, type CoordinatorDatabase } from '../src/database.js'
import { UsageRepository } from '../src/usage/repository.js'
import { UsageQueries, parseWindow } from '../src/usage/query.js'
import { MAX_MODEL_GROUPS } from '../src/usage/query.js'

const directories: string[] = []
const databases: CoordinatorDatabase[] = []

async function harness(): Promise<{ database: CoordinatorDatabase; queries: UsageQueries }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-coordinator-query-'))
  directories.push(directory)
  const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
  databases.push(database)
  database.db.prepare(
    "INSERT INTO nodes (node_id, token, node_name) VALUES ('node-1', 't1', 'Alpha'), ('node-2', 't2', 'Beta')",
  ).run()
  database.db.prepare(
    "INSERT INTO usage_sync_state (node_id, collector_id, cursor_seq, last_synced_at, coverage, started_at) VALUES ('node-1', 'c1', 0, '2026-10-23T00:00:00.000Z', 'complete', '2026-10-01T00:00:00.000Z')",
  ).run()
  const repository = new UsageRepository({ db: database.db })
  const queries = new UsageQueries({
    db: database.db,
    repository,
    nodes: {
      list: () => [
        { nodeId: 'node-1', nodeName: 'Alpha', state: 'ready', revoked: false },
        { nodeId: 'node-2', nodeName: 'Beta', state: 'offline', revoked: false },
      ],
    },
    now: () => Date.parse('2026-10-23T12:00:00.000Z'),
  })
  return { database, queries }
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

interface Row {
  attemptId: string
  nodeId?: string
  collectorId?: string
  startedAt: string
  state?: string
  provider?: string | null
  model?: string | null
  usageReported?: boolean
  input?: string | null
  cacheRead?: string | null
  cacheWrite?: string | null
  output?: string | null
  total?: string | null
  known?: string
}

/** Insert one attempt row with the defaults a completed call would have. */
function insert(database: CoordinatorDatabase, row: Row): void {
  database.db.prepare(
    `INSERT INTO usage_attempts
       (node_id, collector_id, attempt_id, revision_seq, started_at, ended_at, provider, model, session_id,
        purpose, state, usage_reported, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens, total_tokens, known_tokens)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, 'conversation', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    row.nodeId ?? 'node-1',
    row.collectorId ?? 'c1',
    row.attemptId,
    row.startedAt,
    row.startedAt,
    row.provider === undefined ? 'deepseek-official' : row.provider,
    row.model === undefined ? 'deepseek-v4-flash' : row.model,
    row.state ?? 'completed',
    row.usageReported === false ? 0 : 1,
    row.input === undefined ? '5' : row.input,
    row.cacheRead === undefined ? '3' : row.cacheRead,
    row.cacheWrite === undefined ? '0' : row.cacheWrite,
    row.output === undefined ? '2' : row.output,
    row.total === undefined ? null : row.total,
    row.known ?? '10',
  )
}

/** The query parameters for one fixed window. */
const WINDOW = {
  from: '2026-10-20T00:00:00+08:00',
  to: '2026-10-24T00:00:00+08:00',
}

describe('totals', () => {
  it('separates known buckets from unknown ones', async () => {
    const { database, queries } = await harness()
    insert(database, { attemptId: 'a', startedAt: '2026-10-21T02:00:00.000Z' })
    insert(database, { attemptId: 'b', startedAt: '2026-10-21T03:00:00.000Z', cacheRead: null, known: '7' })
    insert(database, { attemptId: 'c', startedAt: '2026-10-21T04:00:00.000Z', usageReported: false, input: null, cacheRead: null, cacheWrite: null, output: null, known: '0' })
    const summary = queries.summary(WINDOW)
    expect(summary.totals.requestCount).toBe('3')
    expect(summary.totals.knownTokens).toBe('17')
    expect(summary.totals.uncachedInputTokens).toBe('10')
    expect(summary.totals.cacheReadTokens).toBe('3')
    expect(summary.totals.usageReportedCount).toBe('2')
    expect(summary.totals.unknownUsageCount).toBe('1')
    // Two calls have no complete total: one missing a cache bucket and one missing
    // every bucket. `usageReported` and "has a total" are different questions.
    expect(summary.totals.totalUnknownCount).toBe('2')
    expect(summary.totals.bucketUnknownCounts.cacheRead).toBe('2')
  })

  it('does not count a running call as missing usage', async () => {
    const { database, queries } = await harness()
    insert(database, { attemptId: 'a', startedAt: '2026-10-21T02:00:00.000Z', state: 'running', input: null, cacheRead: null, cacheWrite: null, output: null, known: '0' })
    const summary = queries.summary(WINDOW)
    expect(summary.totals.runningCount).toBe('1')
    expect(summary.totals.unknownUsageCount).toBe('0')
    expect(summary.totals.totalUnknownCount).toBe('1')
  })

  it('keeps a sum beyond MAX_SAFE_INTEGER exact', async () => {
    const { database, queries } = await harness()
    insert(database, { attemptId: 'a', startedAt: '2026-10-21T02:00:00.000Z', known: '9007199254740993' })
    insert(database, { attemptId: 'b', startedAt: '2026-10-21T03:00:00.000Z', known: '9007199254740993' })
    const summary = queries.summary(WINDOW)
    expect(summary.totals.knownTokens).toBe('18014398509481986')
  })

  it('labels the model distribution and folds the tail into one group', async () => {
    const { database, queries } = await harness()
    for (let index = 0; index < MAX_MODEL_GROUPS + 5; index += 1) {
      insert(database, {
        attemptId: `m${index}`,
        startedAt: '2026-10-21T02:00:00.000Z',
        provider: 'p',
        model: `model-${String(index).padStart(2, '0')}`,
        known: String(100 - index),
      })
    }
    const summary = queries.summary(WINDOW)
    expect(summary.byModel).toHaveLength(MAX_MODEL_GROUPS)
    const other = summary.byModel.at(-1)
    expect(other?.isOther).toBe(true)
    expect(other?.provider).toBeNull()
    expect(summary.byModel[0]?.knownTokens).toBe('100')
    // Every group is present in exactly one bucket: named plus other sums to the total.
    const sum = summary.byModel.reduce((total, entry) => total + BigInt(entry.knownTokens), 0n)
    expect(sum.toString()).toBe(summary.totals.knownTokens)
  })
})

describe('windows', () => {
  it('attributes a call to the Shanghai day it started on', async () => {
    const { database, queries } = await harness()
    // 2026-10-21T23:30+08:00 is 15:30Z.
    insert(database, { attemptId: 'late', startedAt: '2026-10-21T15:30:00.000Z' })
    // 2026-10-22T00:30+08:00 is 16:30Z the previous UTC day.
    insert(database, { attemptId: 'early', startedAt: '2026-10-21T16:30:00.000Z' })
    const series = queries.series({
      from: '2026-10-21T00:00:00+08:00',
      to: '2026-10-23T00:00:00+08:00',
    }, 'day')
    expect(series.points).toHaveLength(2)
    expect(series.points[0]?.totals.requestCount).toBe('1')
    expect(series.points[1]?.totals.requestCount).toBe('1')
  })

  it('uses [from, to) boundaries', async () => {
    const { database, queries } = await harness()
    insert(database, { attemptId: 'edge', startedAt: '2026-10-20T16:00:00.000Z' })
    const inside = queries.summary({ from: '2026-10-21T00:00:00+08:00', to: '2026-10-22T00:00:00+08:00' })
    const outside = queries.summary({ from: '2026-10-21T00:00:01+08:00', to: '2026-10-22T00:00:00+08:00' })
    expect(inside.totals.requestCount).toBe('1')
    expect(outside.totals.requestCount).toBe('0')
  })

  it('refuses a range over 90 days, an hourly range over 7 days, and an unknown timezone', () => {
    const now = Date.parse('2026-10-23T12:00:00.000Z')
    expect(() => parseWindow({ from: '2026-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }, now)).toThrow(/90 days/u)
    expect(() => parseWindow({ timezone: 'Europe/Berlin' }, now)).toThrow(/timezone/u)
    expect(() => parseWindow({ from: '2026-01-01', to: '2026-02-01' }, now)).toThrow(/offset/u)
  })

  it('refuses an hourly series beyond seven days', async () => {
    const { queries } = await harness()
    expect(() => queries.series({ from: '2026-10-01T00:00:00+08:00', to: '2026-10-23T00:00:00+08:00' }, 'hour'))
      .toThrow(/7 days/u)
  })

  it('fills empty buckets instead of omitting them', async () => {
    const { database, queries } = await harness()
    insert(database, { attemptId: 'a', startedAt: '2026-10-21T02:00:00.000Z' })
    const series = queries.series(WINDOW, 'day')
    expect(series.points).toHaveLength(4)
    expect(series.points.filter(point => point.totals.requestCount !== '0')).toHaveLength(1)
  })
})

describe('requests', () => {
  it('pages without losing or repeating a row that shares a start time', async () => {
    const { database, queries } = await harness()
    for (let index = 0; index < 25; index += 1) {
      insert(database, { attemptId: `attempt-${String(index).padStart(2, '0')}`, startedAt: '2026-10-21T02:00:00.000Z', known: String(index) })
    }
    const filter = { ...parseWindow(WINDOW, Date.parse('2026-10-23T12:00:00.000Z')), usage: 'all' as const }
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 5; page += 1) {
      const result = queries.requests(filter, 10, cursor)
      for (const item of result.items) {
        expect(seen.has(item.attemptId), item.attemptId).toBe(false)
        seen.add(item.attemptId)
      }
      cursor = result.nextCursor ?? undefined
      if (cursor === undefined) break
    }
    expect(seen.size).toBe(25)
  })

  it('refuses a cursor from a different filter', async () => {
    const { database, queries } = await harness()
    for (let index = 0; index < 15; index += 1) {
      insert(database, { attemptId: `a${index}`, startedAt: `2026-10-21T02:00:0${index % 10}.000Z` })
    }
    const filter = { ...parseWindow(WINDOW, Date.parse('2026-10-23T12:00:00.000Z')), usage: 'all' as const }
    const first = queries.requests(filter, 10, undefined)
    expect(first.nextCursor).not.toBeNull()
    expect(() => queries.requests({ ...filter, state: 'failed', usage: 'all' }, 10, first.nextCursor ?? undefined))
      .toThrow(/does not belong/u)
  })

  it('filters by state and by usage presence', async () => {
    const { database, queries } = await harness()
    insert(database, { attemptId: 'ok', startedAt: '2026-10-21T02:00:00.000Z' })
    insert(database, { attemptId: 'bad', startedAt: '2026-10-21T03:00:00.000Z', state: 'failed' })
    insert(database, { attemptId: 'silent', startedAt: '2026-10-21T04:00:00.000Z', usageReported: false })
    const window = parseWindow(WINDOW, Date.parse('2026-10-23T12:00:00.000Z'))
    const failed = queries.requests({ ...window, state: 'failed', usage: 'all' }, 20, undefined)
    expect(failed.items.map(item => item.attemptId)).toEqual(['bad'])
    const missing = queries.requests({ ...window, usage: 'missing' }, 20, undefined)
    expect(missing.items.map(item => item.attemptId)).toEqual(['silent'])
  })
})

describe('node table', () => {
  it('reports null totals for a node that never collected', async () => {
    const { queries } = await harness()
    const page = queries.nodesReport({ ...WINDOW }, 'nodeName', 'asc', 1, 20)
    expect(page.totalItems).toBe(2)
    const beta = page.items.find(item => item.nodeId === 'node-2')
    expect(beta?.totals).toBeNull()
    expect(beta?.collectorState).toBe('unsupported')
    const alpha = page.items.find(item => item.nodeId === 'node-1')
    expect(alpha?.totals).not.toBeNull()
    expect(alpha?.collectorState).toBe('initializing')
  })

  it('refuses an unknown node id', async () => {
    const { queries } = await harness()
    expect(() => queries.summary({ ...WINDOW, nodeId: 'ghost' })).toThrow(/no node/u)
  })
})
