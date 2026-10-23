/**
 * Idempotent ingestion of what a node's collector sent.
 *
 * This is the module where "the same batch arrived twice" and "the same sequence
 * number now means something else" have to be different outcomes. Both are
 * plausible after an ACK is lost, and only one of them is safe to ignore:
 *
 * - **Replay** — every `(nodeId, collectorId, seq)` already exists with the same
 *   canonical content. Counting it again would double a bill, so it is skipped;
 *   the cursor still advances and the ACK is still safe to send.
 * - **Fork** — a sequence number exists with *different* content. That means the
 *   node's database was restored from a backup, or two collectors are writing the
 *   same sequence space. It is not a duplicate and must never be swallowed by
 *   `INSERT OR IGNORE`: the sync for that collector stops and a human decides.
 *
 * An unexplained hole in the sequence is refused for the same reason. The only
 * gaps that may be skipped are the ones the node named explicitly (`gaps` for a
 * pruned prefix, or a `gap` event with a time range), and even those are recorded
 * so the UI can say "coverage is incomplete here" instead of drawing a zero.
 *
 * @module dsh-coordinator/usage/repository
 */

import { CoordinatorError } from '../errors.js'
import { inTransaction, type SqlDatabase } from '../sqlite.js'
import {
  canonicalUsage,
  decimal,
  knownTokensOf,
  parseDecimal,
  type AttemptSnapshot,
  type ReplayGap,
  type UsageBatch,
  type UsageEvent,
  type UsageStatus,
} from './types.js'

/** One collector's sync state, as stored. */
export interface SyncState {
  readonly nodeId: string
  readonly collectorId: string
  readonly cursorSeq: string
  readonly lastSyncedAt: string | null
  readonly lastError: string | null
  readonly coverage: 'complete' | 'incomplete' | 'unknown'
  readonly pendingCount: string | null
  readonly pendingBytes: string | null
  readonly startedAt: string | null
}

/** What an ingest did. */
export interface IngestResult {
  /** The cursor after the transaction committed. */
  readonly cursorSeq: string
  /** The highest sequence number this call is allowed to acknowledge. */
  readonly ackThroughSeq: string
  readonly inserted: number
  readonly duplicates: number
  readonly gaps: number
}

/** Options for {@link UsageRepository}. */
export interface UsageRepositoryOptions {
  readonly db: SqlDatabase
  readonly now?: () => number
}

/** The row shape of `usage_sync_state`. */
interface SyncStateRow {
  node_id: string
  collector_id: string
  cursor_seq: number | bigint
  last_synced_at: string | null
  last_error: string | null
  coverage: string
  pending_count: number | bigint | null
  pending_bytes: number | bigint | null
  started_at: string | null
}

/**
 * The database side of usage ingestion.
 */
export class UsageRepository {
  readonly #db: SqlDatabase
  readonly #now: () => number

  /** @param options - database and clock. */
  constructor(options: UsageRepositoryOptions) {
    this.#db = options.db
    this.#now = options.now ?? (() => Date.now())
  }

  /** One collector's cursor, or 0 when it has never been seen. */
  getCursor(nodeId: string, collectorId: string): string {
    return this.getState(nodeId, collectorId)?.cursorSeq ?? '0'
  }

  /** One collector's full sync state. */
  getState(nodeId: string, collectorId: string): SyncState | undefined {
    const row = this.#db.prepare(
      `SELECT * FROM usage_sync_state WHERE node_id = ? AND collector_id = ?`,
    ).get(nodeId, collectorId) as SyncStateRow | undefined
    return row === undefined ? undefined : toState(row)
  }

  /** Every collector this Coordinator has ever synced, newest activity first. */
  listStates(nodeId?: string): SyncState[] {
    const rows = nodeId === undefined
      ? this.#db.prepare('SELECT * FROM usage_sync_state ORDER BY last_synced_at DESC').all()
      : this.#db.prepare('SELECT * FROM usage_sync_state WHERE node_id = ? ORDER BY last_synced_at DESC').all(nodeId)
    return (rows as unknown as SyncStateRow[]).map(toState)
  }

  /**
   * Record the collector's non-secret status.
   *
   * Called on every successful `nodeUsage/status`, which is how the UI learns the
   * backlog size and whether the node itself admits its coverage is incomplete.
   * A missing collector id is not an error: it is how `unsupported` and `disabled`
   * arrive.
   * @param nodeId - the authenticated node id.
   * @param status - the node's own status document.
   */
  recordStatus(nodeId: string, status: UsageStatus): void {
    if (status.collectorId === null) return
    this.#ensureState(nodeId, status.collectorId, status)
  }

  /**
   * Record a sync failure without inventing a cursor movement.
   * @param nodeId - the node.
   * @param collectorId - the collector that failed, when known.
   * @param issue - a short, secret-free description.
   */
  recordSyncFailure(nodeId: string, collectorId: string | null, issue: string): void {
    if (collectorId === null) {
      this.#db.prepare(
        `INSERT INTO usage_sync_state (node_id, collector_id, cursor_seq, last_error, coverage)
         VALUES (?, '', 0, ?, 'unknown')
         ON CONFLICT(node_id, collector_id) DO UPDATE SET last_error = excluded.last_error`,
      ).run(nodeId, issue)
      return
    }
    this.#ensureState(nodeId, collectorId, undefined)
    this.#db.prepare(
      'UPDATE usage_sync_state SET last_error = ? WHERE node_id = ? AND collector_id = ?',
    ).run(issue, nodeId, collectorId)
  }

  /**
   * Merge one batch.
   *
   * Everything — events, attempt snapshots, gaps, and the cursor — commits
   * together. If any part fails, the cursor does not move, the caller does not
   * ACK, and the same batch will be offered again.
   * @param nodeId - the node the batch came from, taken from the authenticated
   * connection rather than from the payload.
   * @param batch - a validated batch.
   * @returns the cursor and the highest sequence the caller may acknowledge.
   * @throws CoordinatorError `usage/collector-fork` when a sequence number's content changed.
   * @throws CoordinatorError `usage/sequence-gap` when the batch skips un-explained numbers.
   */
  ingest(nodeId: string, batch: UsageBatch): IngestResult {
    if (batch.status.collectorId !== null && batch.status.collectorId !== batch.collectorId) {
      throw new CoordinatorError(
        'usage/contract-invalid',
        'the batch reports a different collectorId than its status',
        { batch: batch.collectorId, status: batch.status.collectorId },
      )
    }
    const collectorId = batch.collectorId
    const existing = this.getState(nodeId, collectorId)
    let cursor = parseDecimal(existing?.cursorSeq ?? '0') ?? 0n
    const startCursor = cursor

    return inTransaction(this.#db, () => {
      let expected = cursor + 1n
      let gapsRecorded = 0

      // --- explicit replay gaps (the node pruned events we never read) --------
      for (const gap of batch.gaps) {
        const from = requireSeq(gap.fromSeq)
        const through = requireSeq(gap.throughSeq)
        if (from > through) {
          throw new CoordinatorError('usage/contract-invalid', 'a replay gap is inverted', { from: decimal(from), through: decimal(through) })
        }
        if (through < expected) continue
        if (from > expected) {
          throw new CoordinatorError(
            'usage/sequence-gap',
            `the node cannot replay from ${decimal(expected)} and did not name that range as a gap`,
            { nodeId, collectorId, expected: decimal(expected), nextAvailable: decimal(from) },
          )
        }
        this.#insertGap(nodeId, collectorId, from, through, null, null, gap.reason)
        gapsRecorded += 1
        expected = through + 1n
      }

      // --- events ------------------------------------------------------------
      let inserted = 0
      let duplicates = 0
      let lastDelivered = expected - 1n
      for (const event of batch.events) {
        const seq = requireSeq(event.seq)
        if (seq > expected) {
          throw new CoordinatorError(
            'usage/sequence-gap',
            `event ${decimal(seq)} arrived while ${decimal(expected)} was expected, with no gap named`,
            { nodeId, collectorId, expected: decimal(expected), received: decimal(seq) },
          )
        }
        const canonical = canonicalEvent(event)
        const stored = this.#db.prepare(
          'SELECT event_json FROM usage_events WHERE node_id = ? AND collector_id = ? AND seq = ?',
        ).get(nodeId, collectorId, seq)
        if (stored !== undefined) {
          if (String(stored['event_json']) !== canonical) {
            throw new CoordinatorError(
              'usage/collector-fork',
              `sequence ${decimal(seq)} on collector ${collectorId} already exists with different content; restore or reset the collector instead of mixing two histories`,
              { nodeId, collectorId, seq: decimal(seq) },
            )
          }
          duplicates += 1
          if (seq >= expected) {
            expected = seq + 1n
            lastDelivered = seq
          }
          continue
        }
        this.#db.prepare(
          'INSERT INTO usage_events (node_id, collector_id, seq, kind, event_json) VALUES (?, ?, ?, ?, ?)',
        ).run(nodeId, collectorId, seq, event.kind, canonical)
        if (event.kind === 'attempt') {
          this.#upsertAttempt(nodeId, collectorId, seq, event.attempt)
        } else {
          const from = Date.parse(event.fromAt)
          const to = Date.parse(event.toAt)
          this.#insertGap(
            nodeId,
            collectorId,
            null,
            null,
            new Date(from).toISOString(),
            new Date(to).toISOString(),
            event.reason,
          )
          gapsRecorded += 1
        }
        inserted += 1
        expected = seq + 1n
        lastDelivered = seq
      }

      // --- cursor ------------------------------------------------------------
      const proposed = requireSeq(batch.nextSeq)
      const latestIssued = requireSeq(batch.status.latestIssuedSeq)
      if (proposed > latestIssued) {
        throw new CoordinatorError(
          'usage/contract-invalid',
          'the batch cursor is beyond the node\'s latest issued sequence',
          { nextSeq: decimal(proposed), latestIssuedSeq: decimal(latestIssued) },
        )
      }
      if (proposed < lastDelivered) {
        throw new CoordinatorError(
          'usage/contract-invalid',
          'the batch cursor is behind events it contains',
          { nextSeq: decimal(proposed), lastDelivered: decimal(lastDelivered) },
        )
      }
      cursor = proposed > cursor ? proposed : cursor

      this.#ensureState(nodeId, collectorId, batch.status)
      this.#db.prepare(
        `UPDATE usage_sync_state
            SET cursor_seq = ?, last_synced_at = ?, last_error = NULL, coverage = ?,
                pending_count = ?, pending_bytes = ?, started_at = ?
          WHERE node_id = ? AND collector_id = ?`,
      ).run(
        cursor,
        new Date(this.#now()).toISOString(),
        batch.status.coverage,
        requireSeq(batch.status.pendingCount),
        requireSeq(batch.status.pendingBytes),
        batch.status.startedAt,
        nodeId,
        collectorId,
      )

      return {
        cursorSeq: decimal(cursor),
        ackThroughSeq: decimal(cursor),
        inserted,
        duplicates,
        gaps: gapsRecorded,
      }
    })
    // Kept for readability of the transaction body: every returned value above is
    // computed after the last write, so a commit failure cannot leak a cursor that
    // was never stored.
    void startCursor
  }

  /** Insert one attempt snapshot when it is newer than what is stored. */
  #upsertAttempt(nodeId: string, collectorId: string, revisionSeq: bigint, attempt: AttemptSnapshot): void {
    const known = knownTokensOf(attempt.usage)
    const row = this.#db.prepare(
      `SELECT revision_seq, started_at, state FROM usage_attempts
        WHERE node_id = ? AND collector_id = ? AND attempt_id = ?`,
    ).get(nodeId, collectorId, attempt.attemptId)
    if (row !== undefined) {
      const storedRevision = numberOrBigInt(row['revision_seq'])
      if (storedRevision >= revisionSeq) return
      if (String(row['started_at']) !== attempt.startedAt) {
        throw new CoordinatorError(
          'usage/collector-fork',
          `attempt ${attempt.attemptId} changed its start time; the node\'s collector was reset under a committed sequence`,
          { nodeId, collectorId, attemptId: attempt.attemptId },
        )
      }
      const previousState = String(row['state'])
      if (previousState !== 'running' && attempt.state === 'running') {
        // A terminal attempt cannot come back to life; the newer revision is
        // ignored rather than moving a completed call back into "running".
        return
      }
    }
    this.#db.prepare(
      `INSERT INTO usage_attempts
         (node_id, collector_id, attempt_id, revision_seq, started_at, ended_at, provider, model, session_id,
          purpose, state, usage_reported, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
          output_tokens, reasoning_tokens, total_tokens, known_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id, collector_id, attempt_id) DO UPDATE SET
         revision_seq = excluded.revision_seq,
         ended_at = excluded.ended_at,
         provider = excluded.provider,
         model = excluded.model,
         session_id = excluded.session_id,
         purpose = excluded.purpose,
         state = excluded.state,
         usage_reported = excluded.usage_reported,
         uncached_input_tokens = excluded.uncached_input_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         output_tokens = excluded.output_tokens,
         reasoning_tokens = excluded.reasoning_tokens,
         total_tokens = excluded.total_tokens,
         known_tokens = excluded.known_tokens`,
    ).run(
      nodeId,
      collectorId,
      attempt.attemptId,
      revisionSeq,
      attempt.startedAt,
      attempt.endedAt,
      attempt.provider,
      attempt.model,
      attempt.sessionId,
      attempt.purpose,
      attempt.state,
      attempt.usageReported ? 1 : 0,
      toInteger(attempt.usage.uncachedInputTokens),
      toInteger(attempt.usage.cacheReadTokens),
      toInteger(attempt.usage.cacheWriteTokens),
      toInteger(attempt.usage.outputTokens),
      toInteger(attempt.usage.reasoningTokens),
      toInteger(attempt.usage.totalTokens),
      known,
    )
  }

  /** Record one gap, sequence-numbered or time-ranged. */
  #insertGap(
    nodeId: string,
    collectorId: string,
    fromSeq: bigint | null,
    throughSeq: bigint | null,
    fromAt: string | null,
    toAt: string | null,
    reason: string,
  ): void {
    this.#db.prepare(
      `INSERT INTO usage_gaps (node_id, collector_id, from_seq, to_seq, from_at, to_at, reason, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nodeId,
      collectorId,
      fromSeq,
      throughSeq,
      fromAt,
      toAt,
      reason,
      new Date(this.#now()).toISOString(),
    )
  }

  /** Insert the sync row for a collector if it is not there yet. */
  #ensureState(nodeId: string, collectorId: string, status: UsageStatus | undefined): void {
    this.#db.prepare(
      `INSERT INTO usage_sync_state
         (node_id, collector_id, cursor_seq, last_synced_at, last_error, coverage, pending_count, pending_bytes, started_at)
       VALUES (?, ?, 0, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(node_id, collector_id) DO NOTHING`,
    ).run(
      nodeId,
      collectorId,
      status?.coverage ?? 'unknown',
      status === undefined ? null : requireSeq(status.pendingCount),
      status === undefined ? null : requireSeq(status.pendingBytes),
      status?.startedAt ?? null,
    )
  }

  /** The most recent gaps for one node, newest first. */
  gaps(nodeId: string, limit = 50): {
    collectorId: string
    fromSeq: string | null
    throughSeq: string | null
    fromAt: string | null
    toAt: string | null
    reason: string
    detectedAt: string
  }[] {
    const rows = this.#db.prepare(
      `SELECT * FROM usage_gaps WHERE node_id = ? ORDER BY detected_at DESC, id DESC LIMIT ?`,
    ).all(nodeId, Math.max(1, Math.min(200, Math.trunc(limit))))
    return rows.map(row => ({
      collectorId: String(row['collector_id']),
      fromSeq: nullableDecimal(row['from_seq']),
      throughSeq: nullableDecimal(row['to_seq']),
      fromAt: typeof row['from_at'] === 'string' ? row['from_at'] : null,
      toAt: typeof row['to_at'] === 'string' ? row['to_at'] : null,
      reason: String(row['reason']),
      detectedAt: String(row['detected_at']),
    }))
  }

  /** Total number of gap rows, optionally for one node. */
  gapCount(nodeId?: string): number {
    const row = nodeId === undefined
      ? this.#db.prepare('SELECT COUNT(*) AS count FROM usage_gaps').get()
      : this.#db.prepare('SELECT COUNT(*) AS count FROM usage_gaps WHERE node_id = ?').get(nodeId)
    return Number(numberOrBigInt(row?.['count']))
  }
}

/** Canonical JSON for an event, used for the duplicate/fork comparison. */
export function canonicalEvent(event: UsageEvent): string {
  if (event.kind === 'attempt') {
    const attempt = event.attempt
    return JSON.stringify({
      seq: event.seq,
      recordedAt: event.recordedAt,
      kind: 'attempt',
      attempt: {
        attemptId: attempt.attemptId,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        provider: attempt.provider,
        model: attempt.model,
        sessionId: attempt.sessionId,
        purpose: attempt.purpose,
        state: attempt.state,
        usageReported: attempt.usageReported,
        usage: canonicalUsage(attempt.usage),
        source: attempt.source,
      },
    })
  }
  return JSON.stringify({
    seq: event.seq,
    recordedAt: event.recordedAt,
    kind: 'gap',
    fromAt: event.fromAt,
    toAt: event.toAt,
    reason: event.reason,
  })
}

/** Parse a sequence number that must be present. */
function requireSeq(value: string): bigint {
  const parsed = parseDecimal(value)
  if (parsed === undefined) {
    throw new CoordinatorError('usage/contract-invalid', `"${value}" is not a decimal sequence number`, {})
  }
  return parsed
}

/** Convert a contract decimal to the SQLite representation. */
function toInteger(value: string | null): bigint | null {
  if (value === null) return null
  const parsed = parseDecimal(value)
  return parsed === undefined ? null : parsed
}

/** Read a numeric column that may be a number or a bigint. */
function numberOrBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  return 0n
}

/** Render a nullable sequence column. */
function nullableDecimal(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return decimal(numberOrBigInt(value))
}

/** Map a row onto the public state shape. */
function toState(row: SyncStateRow): SyncState {
  return {
    nodeId: row.node_id,
    collectorId: row.collector_id,
    cursorSeq: decimal(numberOrBigInt(row.cursor_seq)),
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    coverage: row.coverage === 'complete' || row.coverage === 'incomplete' ? row.coverage : 'unknown',
    pendingCount: row.pending_count === null ? null : decimal(numberOrBigInt(row.pending_count)),
    pendingBytes: row.pending_bytes === null ? null : decimal(numberOrBigInt(row.pending_bytes)),
    startedAt: row.started_at,
  }
}

/** Re-exported so the sync layer and tests share one definition. */
export type { ReplayGap }
