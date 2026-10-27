/**
 * Read-side usage queries: totals, per-node tables, trends, request pages, status.
 *
 * Two constraints shape everything here:
 *
 * - **Precision is not optional.** Token counts are 64-bit; JavaScript numbers are
 *   exact only to 2^53. Every aggregate is accumulated as `bigint` from rows read
 *   in bounded keyset pages, and only then rendered as decimal strings. `SUM()` in
 *   SQLite would be one overflow away from a wrong bill with no error.
 * - **Unknown is not zero.** A bucket that no provider reported is `null` in the
 *   database, contributes nothing to a sum, and is counted separately so the UI can
 *   say "known total" instead of "total". A missing usage report and a missing
 *   transfer are also different things, so `unknownUsageCount` (no sample) and
 *   `coverage` (sync completeness) are reported separately.
 *
 * The aggregation reads `usage_attempts`, which holds the newest revision of each
 * attempt. It deliberately does not maintain a daily rollup table: one source of
 * truth that is occasionally slow beats two that disagree.
 *
 * @module dsh-coordinator/usage/query
 */

import { createHash } from 'node:crypto'
import { CoordinatorError } from '../errors.js'
import { inTransaction, type SqlDatabase } from '../sqlite.js'
import { decimal, parseDecimal, type UsageTotals } from './types.js'
import type { SyncState, UsageRepository } from './repository.js'

/** The timezones the first phase supports. */
export const SUPPORTED_TIMEZONES = ['Asia/Shanghai', 'UTC'] as const

/** One supported timezone. */
export type UsageTimezone = (typeof SUPPORTED_TIMEZONES)[number]

/** The widest range a query may span. */
export const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000

/** The largest page of attempts a caller may request. */
export const MAX_REQUEST_PAGE = 100

/** The default page of attempts. */
export const DEFAULT_REQUEST_PAGE = 20

/** The most model groups a summary returns before folding the rest into "other". */
export const MAX_MODEL_GROUPS = 50

/** Shanghai's fixed offset. China has observed no DST since 1991. */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** A resolved query window. */
export interface UsageWindow {
  /** Inclusive, UTC milliseconds. */
  readonly fromMs: number
  /** Exclusive, UTC milliseconds. */
  readonly toMs: number
  readonly timezone: UsageTimezone
}

/** Raw query parameters, straight from the URL. */
export interface UsageQueryParams {
  readonly from?: string | null
  readonly to?: string | null
  readonly timezone?: string | null
  readonly nodeId?: string | null
}

/** The filter the request page adds. */
export interface RequestFilter extends UsageWindow {
  readonly nodeId?: string
  readonly provider?: string
  readonly model?: string
  readonly state?: string
  readonly usage?: 'all' | 'reported' | 'missing'
}

/** One model's share. */
export interface ModelShare {
  readonly provider: string | null
  readonly model: string | null
  readonly knownTokens: string
  readonly requestCount: string
  readonly isOther: boolean
}

/** One series point. */
export interface SeriesPoint {
  readonly from: string
  readonly to: string
  readonly totals: UsageTotals
}

/** One attempt row as the API returns it. */
export interface RequestItem {
  readonly attemptId: string
  readonly startedAt: string
  readonly endedAt: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly sessionId: string | null
  readonly purpose: string
  readonly state: string
  readonly usageReported: boolean
  readonly usage: {
    readonly uncachedInputTokens: string | null
    readonly cacheReadTokens: string | null
    readonly cacheWriteTokens: string | null
    readonly outputTokens: string | null
    readonly reasoningTokens: string | null
    readonly totalTokens: string | null
  }
  readonly source: 'runtime'
  readonly nodeId: string
  readonly collectorId: string
  readonly revisionSeq: string
  readonly knownTokens: string
}

/** One node row in the usage table. */
export interface NodeUsageRow {
  readonly nodeId: string
  readonly nodeName: string | null
  readonly connectionState: string
  readonly collectorState: string
  readonly totals: UsageTotals | null
  readonly lastSyncedAt: string | null
  readonly startedAt: string | null
  readonly coverage: 'complete' | 'incomplete' | 'unknown'
  readonly pendingCount: string | null
}

/** What the query layer needs to know about registered nodes. */
export interface NodeCatalog {
  /** The connected node advertises nodeUsage, even before its first successful sync. */
  supportsUsage?(nodeId: string): boolean
  /** Every registered node, revoked included. */
  list(): readonly { readonly nodeId: string; readonly nodeName?: string; readonly state: string; readonly revoked: boolean }[]
}

/** Options for {@link UsageQueries}. */
export interface UsageQueriesOptions {
  readonly db: SqlDatabase
  readonly repository: UsageRepository
  readonly nodes: NodeCatalog
  readonly now?: () => number
}

/** Accumulator for one window. */
interface TotalsAcc {
  requestCount: bigint
  runningCount: bigint
  completedCount: bigint
  failedCount: bigint
  cancelledCount: bigint
  interruptedCount: bigint
  usageReportedCount: bigint
  unknownUsageCount: bigint
  totalUnknownCount: bigint
  knownTokens: bigint
  uncachedInputTokens: bigint
  cacheReadTokens: bigint
  cacheWriteTokens: bigint
  outputTokens: bigint
  inputUnknown: bigint
  cacheReadUnknown: bigint
  cacheWriteUnknown: bigint
  outputUnknown: bigint
}

/** A row as the scan returns it. */
interface AttemptRow {
  node_id: string
  collector_id: string
  attempt_id: string
  revision_seq: number | bigint
  started_at: string
  ended_at: string | null
  provider: string | null
  model: string | null
  session_id: string | null
  purpose: string
  state: string
  usage_reported: number | bigint
  uncached_input_tokens: number | bigint | null
  cache_read_tokens: number | bigint | null
  cache_write_tokens: number | bigint | null
  output_tokens: number | bigint | null
  reasoning_tokens: number | bigint | null
  total_tokens: number | bigint | null
  known_tokens: number | bigint
}

/** How many rows one keyset page holds. */
const SCAN_PAGE = 2000

/** An empty accumulator. */
function emptyAcc(): TotalsAcc {
  return {
    requestCount: 0n,
    runningCount: 0n,
    completedCount: 0n,
    failedCount: 0n,
    cancelledCount: 0n,
    interruptedCount: 0n,
    usageReportedCount: 0n,
    unknownUsageCount: 0n,
    totalUnknownCount: 0n,
    knownTokens: 0n,
    uncachedInputTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    outputTokens: 0n,
    inputUnknown: 0n,
    cacheReadUnknown: 0n,
    cacheWriteUnknown: 0n,
    outputUnknown: 0n,
  }
}

/** Add one row to the accumulator. */
function accumulate(acc: TotalsAcc, row: AttemptRow): void {
  acc.requestCount += 1n
  switch (row.state) {
    case 'running': acc.runningCount += 1n; break
    case 'completed': acc.completedCount += 1n; break
    case 'failed': acc.failedCount += 1n; break
    case 'cancelled': acc.cancelledCount += 1n; break
    case 'process_interrupted': acc.interruptedCount += 1n; break
    default: break
  }
  const reported = Number(row.usage_reported) === 1
  if (row.state !== 'running') {
    if (reported) acc.usageReportedCount += 1n
    else acc.unknownUsageCount += 1n
  }
  const total = num(row.total_tokens)
  const input = num(row.uncached_input_tokens)
  const cacheRead = num(row.cache_read_tokens)
  const cacheWrite = num(row.cache_write_tokens)
  const output = num(row.output_tokens)
  if (total === null && (input === null || cacheRead === null || cacheWrite === null || output === null)) {
    acc.totalUnknownCount += 1n
  }
  acc.knownTokens += num(row.known_tokens) ?? 0n
  if (input === null) acc.inputUnknown += 1n
  else acc.uncachedInputTokens += input
  if (cacheRead === null) acc.cacheReadUnknown += 1n
  else acc.cacheReadTokens += cacheRead
  if (cacheWrite === null) acc.cacheWriteUnknown += 1n
  else acc.cacheWriteTokens += cacheWrite
  if (output === null) acc.outputUnknown += 1n
  else acc.outputTokens += output
}

/** Render an accumulator as the contract shape. */
function totalsOf(acc: TotalsAcc): UsageTotals {
  return {
    requestCount: decimal(acc.requestCount),
    runningCount: decimal(acc.runningCount),
    completedCount: decimal(acc.completedCount),
    failedCount: decimal(acc.failedCount),
    cancelledCount: decimal(acc.cancelledCount),
    interruptedCount: decimal(acc.interruptedCount),
    usageReportedCount: decimal(acc.usageReportedCount),
    unknownUsageCount: decimal(acc.unknownUsageCount),
    totalUnknownCount: decimal(acc.totalUnknownCount),
    knownTokens: decimal(acc.knownTokens),
    uncachedInputTokens: decimal(acc.uncachedInputTokens),
    cacheReadTokens: decimal(acc.cacheReadTokens),
    cacheWriteTokens: decimal(acc.cacheWriteTokens),
    outputTokens: decimal(acc.outputTokens),
    bucketUnknownCounts: {
      input: decimal(acc.inputUnknown),
      cacheRead: decimal(acc.cacheReadUnknown),
      cacheWrite: decimal(acc.cacheWriteUnknown),
      output: decimal(acc.outputUnknown),
    },
  }
}

/**
 * Parse the public time window.
 * @param params - raw query parameters.
 * @param now - current time in milliseconds.
 * @returns the resolved window.
 * @throws CoordinatorError `coordinator/invalid-arguments` on a bad range or timezone.
 */
export function parseWindow(params: UsageQueryParams, now: number): UsageWindow {
  const timezone = parseTimezone(params.timezone)
  const toMs = params.to === undefined || params.to === null || params.to === ''
    ? startOfNextDay(now, timezone)
    : parseExplicitTime(params.to, 'to')
  const fromMs = params.from === undefined || params.from === null || params.from === ''
    ? startOfDay(toMs - 7 * 24 * 60 * 60 * 1000, timezone)
    : parseExplicitTime(params.from, 'from')
  if (fromMs >= toMs) {
    throw new CoordinatorError('coordinator/invalid-arguments', '"from" must be earlier than "to"', {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    })
  }
  if (toMs - fromMs > MAX_RANGE_MS) {
    throw new CoordinatorError('coordinator/invalid-arguments', 'the time range may span at most 90 days', {
      days: (toMs - fromMs) / (24 * 60 * 60 * 1000),
    })
  }
  return { fromMs, toMs, timezone }
}

/** Parse the timezone parameter, defaulting to Asia/Shanghai. */
export function parseTimezone(raw: string | null | undefined): UsageTimezone {
  const value = raw === undefined || raw === null || raw === '' ? 'Asia/Shanghai' : raw
  if (value === 'Asia/Shanghai' || value === 'UTC') return value
  throw new CoordinatorError('coordinator/invalid-arguments', `the timezone must be one of ${SUPPORTED_TIMEZONES.join(', ')}`, {
    timezone: value,
  })
}

/** Require an ISO-8601 timestamp that carries an explicit offset. */
function parseExplicitTime(raw: string, field: string): number {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw)) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      `"${field}" must be an ISO-8601 time with an explicit offset`,
      { field },
    )
  }
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" is not a parseable time`, { field })
  }
  return parsed
}

/** The UTC instant at which the local day containing `ms` starts. */
export function startOfDay(ms: number, timezone: UsageTimezone): number {
  if (timezone === 'UTC') return Math.floor(ms / 86_400_000) * 86_400_000
  return Math.floor((ms + SHANGHAI_OFFSET_MS) / 86_400_000) * 86_400_000 - SHANGHAI_OFFSET_MS
}

/** The UTC instant at which the local day after `ms` starts. */
function startOfNextDay(ms: number, timezone: UsageTimezone): number {
  const day = startOfDay(ms, timezone)
  return startOfDay(day + 86_400_000 + 3_600_000, timezone)
}

/** The start of the hour containing `ms`. */
function startOfHour(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000
}

/** Convert a nullable SQLite integer. */
function num(value: number | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) return null
  return typeof value === 'bigint' ? value : BigInt(Math.trunc(value))
}

/**
 * The read side of the usage API.
 */
export class UsageQueries {
  readonly #db: SqlDatabase
  readonly #repository: UsageRepository
  readonly #nodes: NodeCatalog
  readonly #now: () => number

  /** @param options - database, repository, node catalog, clock. */
  constructor(options: UsageQueriesOptions) {
    this.#db = options.db
    this.#repository = options.repository
    this.#nodes = options.nodes
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Walk every attempt in the window, newest page by page.
   *
   * Keyset pagination rather than `OFFSET`: the filter includes rows that are
   * being inserted while the scan runs, and an offset would skip or repeat rows
   * when that happens.
   */
  #scan(filter: RequestFilter, visit: (row: AttemptRow) => void): void {
    let cursor: { startedAt: string; nodeId: string; collectorId: string; attemptId: string } | undefined
    for (;;) {
      const clauses: string[] = ['started_at >= ?', 'started_at < ?']
      const params: (string | number)[] = [
        new Date(filter.fromMs).toISOString(),
        new Date(filter.toMs).toISOString(),
      ]
      if (filter.nodeId !== undefined) {
        clauses.push('node_id = ?')
        params.push(filter.nodeId)
      }
      if (filter.provider !== undefined) {
        clauses.push('provider = ?')
        params.push(filter.provider)
      }
      if (filter.model !== undefined) {
        clauses.push('model = ?')
        params.push(filter.model)
      }
      if (filter.state !== undefined) {
        clauses.push('state = ?')
        params.push(filter.state)
      }
      if (filter.usage === 'reported') clauses.push('usage_reported = 1')
      if (filter.usage === 'missing') clauses.push('usage_reported = 0')
      if (cursor !== undefined) {
        // Strictly "older than the cursor" in the same total order the API sorts
        // by, so a page boundary can neither repeat nor skip a row.
        clauses.push(
          `(started_at < ? OR (started_at = ? AND (node_id < ? OR (node_id = ? AND
            (collector_id < ? OR (collector_id = ? AND attempt_id < ?))))))`,
        )
        params.push(
          cursor.startedAt, cursor.startedAt,
          cursor.nodeId, cursor.nodeId,
          cursor.collectorId, cursor.collectorId,
          cursor.attemptId,
        )
      }
      const rows = this.#db.prepare(
        `SELECT * FROM usage_attempts WHERE ${clauses.join(' AND ')}
          ORDER BY started_at DESC, node_id DESC, collector_id DESC, attempt_id DESC LIMIT ?`,
        { bigint: true },
      ).all(...params, SCAN_PAGE) as unknown as AttemptRow[]
      for (const row of rows) visit(row)
      if (rows.length < SCAN_PAGE) return
      const last = rows[rows.length - 1]
      if (last === undefined) return
      cursor = {
        startedAt: last.started_at,
        nodeId: last.node_id,
        collectorId: last.collector_id,
        attemptId: last.attempt_id,
      }
    }
  }

  /** The filter for one window and optional node. */
  #filter(window: UsageWindow, nodeId?: string): RequestFilter {
    return {
      ...window,
      ...(nodeId === undefined || nodeId === '' ? {} : { nodeId }),
    }
  }

  /**
   * The summary: totals, per-model shares, coverage and sync freshness.
   * @param params - window and optional node filter.
   * @returns the contract summary payload.
   */
  summary(params: UsageQueryParams): {
    from: string
    to: string
    timezone: UsageTimezone
    totals: UsageTotals
    byModel: ModelShare[]
    coverage: 'complete' | 'incomplete' | 'unknown'
    lastSyncedAt: string | null
    onlineCollectorCount: number
    supportedNodeCount: number
    totalNodeCount: number
    gapCount: number
  } {
    const window = parseWindow(params, this.#now())
    const nodeId = params.nodeId === undefined || params.nodeId === null || params.nodeId === '' ? undefined : params.nodeId
    if (nodeId !== undefined) this.#requireNode(nodeId)
    const filter = this.#filter(window, nodeId)

    const acc = emptyAcc()
    const byModel = new Map<string, { provider: string | null; model: string | null; knownTokens: bigint; requestCount: bigint }>()
    this.#scan(filter, row => {
      accumulate(acc, row)
      const key = JSON.stringify([row.provider, row.model])
      const entry = byModel.get(key) ?? {
        provider: row.provider,
        model: row.model,
        knownTokens: 0n,
        requestCount: 0n,
      }
      entry.knownTokens += num(row.known_tokens) ?? 0n
      entry.requestCount += 1n
      byModel.set(key, entry)
    })

    const sorted = [...byModel.values()].sort((left, right) => {
      if (left.knownTokens !== right.knownTokens) return left.knownTokens > right.knownTokens ? -1 : 1
      const leftKey = `${left.provider ?? ''}\u0000${left.model ?? ''}`
      const rightKey = `${right.provider ?? ''}\u0000${right.model ?? ''}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    const shares: ModelShare[] = sorted.slice(0, MAX_MODEL_GROUPS).map(entry => ({
      provider: entry.provider,
      model: entry.model,
      knownTokens: decimal(entry.knownTokens),
      requestCount: decimal(entry.requestCount),
      isOther: false,
    }))
    if (sorted.length > MAX_MODEL_GROUPS) {
      // 49 named groups plus one aggregate, per the contract: the cut is chosen so
      // that the visible list stays at the promised maximum.
      const named = shares.slice(0, MAX_MODEL_GROUPS - 1)
      const rest = sorted.slice(MAX_MODEL_GROUPS - 1)
      let known = 0n
      let requests = 0n
      for (const entry of rest) {
        known += entry.knownTokens
        requests += entry.requestCount
      }
      named.push({
        provider: null,
        model: null,
        knownTokens: decimal(known),
        requestCount: decimal(requests),
        isOther: true,
      })
      return this.#summaryPayload(window, totalsOf(acc), named, nodeId)
    }
    return this.#summaryPayload(window, totalsOf(acc), shares, nodeId)
  }

  /** Assemble the summary's coverage fields. */
  #summaryPayload(
    window: UsageWindow,
    totals: UsageTotals,
    byModel: ModelShare[],
    nodeId: string | undefined,
  ): {
    from: string
    to: string
    timezone: UsageTimezone
    totals: UsageTotals
    byModel: ModelShare[]
    coverage: 'complete' | 'incomplete' | 'unknown'
    lastSyncedAt: string | null
    onlineCollectorCount: number
    supportedNodeCount: number
    totalNodeCount: number
    gapCount: number
  } {
    const nodes = this.#nodes.list()
    const states = this.#repository.listStates(nodeId)
    const activeIds = new Set(states.map(state => state.collectorId))
    void activeIds
    const coverage = combineCoverage(states, nodeId === undefined ? undefined : nodeId)
    const lastSyncedAt = states.reduce<string | null>(
      (latest, state) => (state.lastSyncedAt !== null && (latest === null || state.lastSyncedAt > latest) ? state.lastSyncedAt : latest),
      null,
    )
    const supportedIds = new Set(states.filter(state => state.collectorId !== '').map(state => state.nodeId))
    for (const node of nodes) {
      if ((nodeId === undefined || node.nodeId === nodeId) && this.#nodes.supportsUsage?.(node.nodeId)) supportedIds.add(node.nodeId)
    }
    const supportedNodeCount = supportedIds.size
    return {
      from: new Date(window.fromMs).toISOString(),
      to: new Date(window.toMs).toISOString(),
      timezone: window.timezone,
      totals,
      byModel,
      coverage,
      lastSyncedAt,
      onlineCollectorCount: nodes.filter(node => node.state === 'ready' && node.revoked !== true).length,
      supportedNodeCount,
      totalNodeCount: nodeId === undefined ? nodes.length : 1,
      gapCount: this.#repository.gapCount(nodeId),
    }
  }

  /**
   * Per-node usage, with sorting and pagination.
   * @param params - window and node filter.
   * @param sort - the column to sort by.
   * @param order - direction.
   * @param page - 1-based page number.
   * @param pageSize - page size, 1..100.
   * @returns the contract page.
   */
  nodesReport(
    params: UsageQueryParams,
    sort: 'knownTokens' | 'requestCount' | 'nodeName',
    order: 'asc' | 'desc',
    page: number,
    pageSize: number,
  ): { items: NodeUsageRow[]; page: number; pageSize: number; totalItems: number } {
    const window = parseWindow(params, this.#now())
    const nodeIdFilter = params.nodeId === undefined || params.nodeId === null || params.nodeId === '' ? undefined : params.nodeId
    if (nodeIdFilter !== undefined) this.#requireNode(nodeIdFilter)
    const catalog = this.#nodes.list().filter(node => nodeIdFilter === undefined || node.nodeId === nodeIdFilter)

    const rows: NodeUsageRow[] = []
    for (const node of catalog) {
      const states = this.#repository.listStates(node.nodeId)
      const collectorId = states[0]?.collectorId
      const supported = states.some(state => state.collectorId !== '') || this.#nodes.supportsUsage?.(node.nodeId) === true
      let totals: UsageTotals | null = null
      if (supported && collectorId !== undefined) {
        const acc = emptyAcc()
        this.#scan({ ...window, nodeId: node.nodeId }, row => { accumulate(acc, row) })
        totals = totalsOf(acc)
      }
      rows.push({
        nodeId: node.nodeId,
        nodeName: node.nodeName ?? null,
        connectionState: node.state,
        collectorState: collectorStateOf(states, supported),
        totals,
        lastSyncedAt: states[0]?.lastSyncedAt ?? null,
        startedAt: states[0]?.startedAt ?? null,
        coverage: states[0]?.coverage ?? 'unknown',
        pendingCount: states[0]?.pendingCount ?? null,
      })
    }

    rows.sort((left, right) => {
      let comparison: number
      if (sort === 'nodeName') {
        const a = left.nodeName ?? left.nodeId
        const b = right.nodeName ?? right.nodeId
        comparison = a < b ? -1 : a > b ? 1 : 0
      } else {
        const a = BigInt(left.totals?.[sort] ?? '0')
        const b = BigInt(right.totals?.[sort] ?? '0')
        comparison = a < b ? -1 : a > b ? 1 : 0
      }
      if (comparison === 0) comparison = left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0
      return order === 'asc' ? comparison : -comparison
    })

    const size = Math.max(1, Math.min(100, Math.trunc(pageSize)))
    const index = Math.max(1, Math.trunc(page))
    const start = (index - 1) * size
    return {
      items: rows.slice(start, start + size),
      page: index,
      pageSize: size,
      totalItems: rows.length,
    }
  }

  /**
   * A filled trend series.
   * @param params - window.
   * @param grain - `hour` or `day`.
   * @returns the contract series payload.
   */
  series(params: UsageQueryParams, grain: 'hour' | 'day'): {
    from: string
    to: string
    timezone: UsageTimezone
    grain: 'hour' | 'day'
    points: SeriesPoint[]
    coverage: 'complete' | 'incomplete' | 'unknown'
  } {
    const window = parseWindow(params, this.#now())
    if (grain === 'hour' && window.toMs - window.fromMs > 7 * 86_400_000) {
      throw new CoordinatorError('coordinator/invalid-arguments', 'hourly series are limited to 7 days', {})
    }
    const nodeId = params.nodeId === undefined || params.nodeId === null || params.nodeId === '' ? undefined : params.nodeId
    if (nodeId !== undefined) this.#requireNode(nodeId)

    const buckets: { from: number; to: number; acc: TotalsAcc }[] = []
    for (let start = grainStart(window.fromMs, grain, window.timezone); start < window.toMs;) {
      const end = grain === 'hour'
        ? start + 3_600_000
        : startOfDay(start + 86_400_000, window.timezone)
      buckets.push({ from: start, to: end, acc: emptyAcc() })
      start = end
    }
    const index = new Map<number, TotalsAcc>()
    for (const bucket of buckets) index.set(bucket.from, bucket.acc)
    this.#scan(this.#filter(window, nodeId), row => {
      const started = Date.parse(row.started_at)
      if (!Number.isFinite(started)) return
      const key = grainStart(started, grain, window.timezone)
      const acc = index.get(key)
      if (acc !== undefined) accumulate(acc, row)
    })

    const states = this.#repository.listStates(nodeId)
    return {
      from: new Date(window.fromMs).toISOString(),
      to: new Date(window.toMs).toISOString(),
      timezone: window.timezone,
      grain,
      points: buckets.map(bucket => ({
        from: new Date(bucket.from).toISOString(),
        to: new Date(bucket.to).toISOString(),
        totals: totalsOf(bucket.acc),
      })),
      coverage: combineCoverage(states, nodeId),
    }
  }

  /**
   * One page of attempts, newest first.
   * @param filter - window and row filters.
   * @param limit - page size.
   * @param cursor - opaque cursor from the previous page.
   * @returns the contract page.
   */
  requests(
    filter: RequestFilter,
    limit: number,
    cursor: string | undefined,
  ): { items: RequestItem[]; nextCursor: string | null } {
    const size = Math.max(1, Math.min(MAX_REQUEST_PAGE, Math.trunc(limit)))
    if (filter.nodeId !== undefined) this.#requireNode(filter.nodeId)
    const filterHash = hashFilter(filter)
    const position = cursor === undefined ? undefined : decodeCursor(cursor, filterHash)

    const clauses: string[] = ['started_at >= ?', 'started_at < ?']
    const params: (string | number)[] = [
      new Date(filter.fromMs).toISOString(),
      new Date(filter.toMs).toISOString(),
    ]
    if (filter.nodeId !== undefined) {
      clauses.push('node_id = ?')
      params.push(filter.nodeId)
    }
    if (filter.provider !== undefined) {
      clauses.push('provider = ?')
      params.push(filter.provider)
    }
    if (filter.model !== undefined) {
      clauses.push('model = ?')
      params.push(filter.model)
    }
    if (filter.state !== undefined) {
      clauses.push('state = ?')
      params.push(filter.state)
    }
    if (filter.usage === 'reported') clauses.push('usage_reported = 1')
    if (filter.usage === 'missing') clauses.push('usage_reported = 0')
    if (position !== undefined) {
      clauses.push(
        `(started_at < ? OR (started_at = ? AND (node_id < ? OR (node_id = ? AND
          (collector_id < ? OR (collector_id = ? AND attempt_id < ?))))))`,
      )
      params.push(
        position.startedAt, position.startedAt,
        position.nodeId, position.nodeId,
        position.collectorId, position.collectorId,
        position.attemptId,
      )
    }

    const rows = this.#db.prepare(
      `SELECT * FROM usage_attempts WHERE ${clauses.join(' AND ')}
        ORDER BY started_at DESC, node_id DESC, collector_id DESC, attempt_id DESC LIMIT ?`,
      { bigint: true },
    ).all(...params, size + 1) as unknown as AttemptRow[]

    const hasMore = rows.length > size
    const page = hasMore ? rows.slice(0, size) : rows
    const last = page[page.length - 1]
    return {
      items: page.map(row => toRequestItem(row)),
      nextCursor: hasMore && last !== undefined
        ? encodeCursor({
          v: 1,
          filterHash,
          startedAt: last.started_at,
          nodeId: last.node_id,
          collectorId: last.collector_id,
          attemptId: last.attempt_id,
        })
        : null,
    }
  }

  /**
   * Collection status for every node, or one node.
   * @param nodeId - optional node filter.
   * @returns the contract status payload.
   */
  status(nodeId: string | undefined): {
    persistenceEnabled: boolean
    items: {
      nodeId: string
      collectorState: string
      connectionState: string
      activeCollectorId: string | null
      startedAt: string | null
      lastSyncedAt: string | null
      pendingCount: string | null
      pendingBytes: string | null
      coverage: 'complete' | 'incomplete' | 'unknown'
      issueCode: string | null
      gaps: {
        collectorId: string
        fromSeq: string | null
        throughSeq: string | null
        fromAt: string | null
        toAt: string | null
        reason: string
        detectedAt: string
      }[]
      gapsTruncated: boolean
    }[]
  } {
    const catalog = this.#nodes.list().filter(node => nodeId === undefined || node.nodeId === nodeId)
    if (nodeId !== undefined) this.#requireNode(nodeId)
    return {
      persistenceEnabled: true,
      items: catalog.map(node => {
        const states = this.#repository.listStates(node.nodeId)
        const active = states[0]
        const gaps = this.#repository.gaps(node.nodeId, 51)
        const truncated = gaps.length > 50
        return {
          nodeId: node.nodeId,
          collectorState: collectorStateOf(states, states.some(state => state.collectorId !== '') || this.#nodes.supportsUsage?.(node.nodeId) === true),
          connectionState: node.state,
          activeCollectorId: active?.collectorId ?? null,
          startedAt: active?.startedAt ?? null,
          lastSyncedAt: active?.lastSyncedAt ?? null,
          pendingCount: active?.pendingCount ?? null,
          pendingBytes: active?.pendingBytes ?? null,
          coverage: active?.coverage ?? 'unknown',
          issueCode: active?.lastError ?? null,
          gaps: truncated ? gaps.slice(0, 50) : gaps,
          gapsTruncated: truncated,
        }
      }),
    }
  }

  /** Refuse a node id that is not registered, with the status the contract names. */
  #requireNode(nodeId: string): void {
    if (!this.#nodes.list().some(node => node.nodeId === nodeId)) {
      throw new CoordinatorError('coordinator/node-unknown', `no node "${nodeId}" is registered`, { nodeId })
    }
  }
}

/** The start of the bucket containing `ms`. */
function grainStart(ms: number, grain: 'hour' | 'day', timezone: UsageTimezone): number {
  return grain === 'hour' ? startOfHour(ms) : startOfDay(ms, timezone)
}

/** Derive the per-node collector state from the stored sync rows. */
function collectorStateOf(states: readonly SyncState[], supported: boolean): string {
  if (!supported) return 'unsupported'
  const active = states[0]
  if (active === undefined) return 'initializing'
  if (active.lastError !== null) return 'degraded'
  if (active.pendingCount !== null && BigInt(active.pendingCount) > 0n) return 'pending'
  if (BigInt(active.cursorSeq) > 0n) return 'synced'
  return 'initializing'
}

/** Combine per-node coverage into one answer. */
function combineCoverage(states: readonly SyncState[], nodeId: string | undefined): 'complete' | 'incomplete' | 'unknown' {
  const relevant = nodeId === undefined ? states : states.filter(state => state.nodeId === nodeId)
  if (relevant.length === 0) return 'unknown'
  if (relevant.some(state => state.coverage === 'incomplete')) return 'incomplete'
  if (relevant.every(state => state.coverage === 'complete')) return 'complete'
  return 'unknown'
}

/** A stable hash of the row-level filter, so a cursor cannot cross filters. */
function hashFilter(filter: RequestFilter): string {
  return createHash('sha256').update(JSON.stringify([
    filter.fromMs,
    filter.toMs,
    filter.timezone,
    filter.nodeId ?? null,
    filter.provider ?? null,
    filter.model ?? null,
    filter.state ?? null,
    filter.usage ?? 'all',
  ]), 'utf8').digest('base64url').slice(0, 22)
}

/** Encode a page position. */
function encodeCursor(value: {
  v: 1
  filterHash: string
  startedAt: string
  nodeId: string
  collectorId: string
  attemptId: string
}): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** Decode a page position, refusing anything that does not match the filter. */
function decodeCursor(raw: string, filterHash: string): {
  startedAt: string
  nodeId: string
  collectorId: string
  attemptId: string
} {
  if (raw.length > 2048) {
    throw new CoordinatorError('coordinator/invalid-arguments', 'the cursor is too long', {})
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new CoordinatorError('coordinator/invalid-arguments', 'the cursor is not valid', {})
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CoordinatorError('coordinator/invalid-arguments', 'the cursor is not valid', {})
  }
  const value = parsed as Record<string, unknown>
  if (value['v'] !== 1 || value['filterHash'] !== filterHash) {
    throw new CoordinatorError('coordinator/invalid-arguments', 'the cursor does not belong to this filter', {})
  }
  for (const field of ['startedAt', 'nodeId', 'collectorId', 'attemptId'] as const) {
    if (typeof value[field] !== 'string') {
      throw new CoordinatorError('coordinator/invalid-arguments', 'the cursor is not valid', { field })
    }
  }
  return {
    startedAt: value['startedAt'] as string,
    nodeId: value['nodeId'] as string,
    collectorId: value['collectorId'] as string,
    attemptId: value['attemptId'] as string,
  }
}

/** Map one stored attempt row onto the API shape. */
function toRequestItem(row: AttemptRow): RequestItem {
  return {
    attemptId: row.attempt_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    provider: row.provider,
    model: row.model,
    sessionId: row.session_id,
    purpose: row.purpose,
    state: row.state,
    usageReported: Number(row.usage_reported) === 1,
    usage: {
      uncachedInputTokens: stringOrNull(row.uncached_input_tokens),
      cacheReadTokens: stringOrNull(row.cache_read_tokens),
      cacheWriteTokens: stringOrNull(row.cache_write_tokens),
      outputTokens: stringOrNull(row.output_tokens),
      reasoningTokens: stringOrNull(row.reasoning_tokens),
      totalTokens: stringOrNull(row.total_tokens),
    },
    source: 'runtime',
    nodeId: row.node_id,
    collectorId: row.collector_id,
    revisionSeq: decimal(num(row.revision_seq) ?? 0n),
    knownTokens: decimal(num(row.known_tokens) ?? 0n),
  }
}

/** Render a nullable stored integer as a contract decimal. */
function stringOrNull(value: number | bigint | null): string | null {
  const parsed = num(value)
  return parsed === null ? null : decimal(parsed)
}

/** Run a read inside a transaction when several statements must agree. */
export { inTransaction }

/** Re-export the decimal parser for callers that validate their own input. */
export { parseDecimal }
