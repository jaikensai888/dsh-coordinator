/**
 * Pulling usage out of a node, one page at a time, without ever double-counting.
 *
 * The loop is deliberately boring: ask the node for its status, read from
 * `min(our cursor, its acknowledged cursor)`, store the page in one transaction,
 * and only then acknowledge it. Every interesting behaviour comes from that order:
 *
 * - **A lost ACK is harmless.** The next read starts from the node's acknowledged
 *   cursor, which is behind ours by exactly the unacknowledged page; the repository
 *   recognises the replay by sequence number and content and does not count it
 *   twice.
 * - **A failed transaction is not acknowledged.** The node keeps the data and
 *   offers it again.
 * - **A fork stops the loop.** Two different events under one sequence number mean
 *   a restored backup or two writers; continuing would silently pick a history.
 *
 * Polling is per node and independent: one node being offline or unsupported does
 * not delay another, and the UI's own refresh interval has nothing to do with this
 * clock.
 *
 * @module dsh-coordinator/usage/sync
 */

import { CoordinatorError, isCoordinatorError } from '../errors.js'
import type { CoordinatorLogger } from '../log.js'
import { systemTimers, type TimerHandle, type TimerSource } from '../timers.js'
import type { UsageRepository } from './repository.js'
import { parseUsageBatch, parseUsageStatus, type UsageBatch, type UsageStatus } from './types.js'

/** How often a healthy node is polled. */
export const DEFAULT_SYNC_INTERVAL_MS = 10_000

/** The largest page the contract allows. */
export const MAX_SYNC_BATCH = 200

/** The largest page in bytes the contract allows. */
export const MAX_SYNC_BYTES = 262_144

/** The first retry delay after a failure. */
export const DEFAULT_RETRY_MS = 5_000

/** The longest retry delay. */
export const MAX_RETRY_MS = 60_000

/** The endpoint names, fixed by the contract. */
export const USAGE_STATUS_ENDPOINT = 'nodeUsage/status'
export const USAGE_READ_ENDPOINT = 'nodeUsage/read'
export const USAGE_ACK_ENDPOINT = 'nodeUsage/ack'

/** Why one node's sync is idle. */
export interface UsageSyncState {
  readonly state: 'idle' | 'running' | 'waiting' | 'unsupported' | 'stopped' | 'forked'
  readonly collectorId: string | null
  readonly lastError: string | null
  readonly consecutiveFailures: number
  readonly lastSyncAt: string | null
}

/** Options for {@link UsageSync}. */
export interface UsageSyncOptions {
  readonly repository: UsageRepository
  /** Call one Remote on a node; the Coordinator's own `invoke`. */
  readonly invoke: (nodeId: string, endpoint: string, args: Record<string, unknown>) => Promise<unknown>
  /** Whether the node currently has a ready connection. */
  readonly isReady: (nodeId: string) => boolean
  readonly timers?: TimerSource
  readonly logger?: CoordinatorLogger
  readonly intervalMs?: number
  readonly retryMs?: number
  readonly maxRetryMs?: number
  readonly batchLimit?: number
  readonly maxBytes?: number
  /** The clock, for the `lastSyncAt` stamp. */
  readonly now?: () => number
}

/** Internal per-node bookkeeping. */
interface NodeLoop {
  stopped: boolean
  timer: TimerHandle | undefined
  running: boolean
  consecutiveFailures: number
  state: UsageSyncState['state']
  collectorId: string | null
  lastError: string | null
  lastSyncAt: string | null
}

/**
 * The per-node polling loop.
 */
export class UsageSync {
  readonly #options: UsageSyncOptions
  readonly #repository: UsageRepository
  readonly #timers: TimerSource
  readonly #loops = new Map<string, NodeLoop>()
  /** In-flight sync calls, awaited by {@link dispose}. */
  readonly #inFlight = new Set<Promise<void>>()
  #disposed = false

  /** @param options - repository, transport, and timing. */
  constructor(options: UsageSyncOptions) {
    this.#options = options
    this.#repository = options.repository
    this.#timers = options.timers ?? systemTimers
  }

  /** Whether a node is currently being polled. */
  isRunning(nodeId: string): boolean {
    return this.#loops.has(nodeId) && !this.#loops.get(nodeId)?.stopped
  }

  /** Current state for one node. */
  stateOf(nodeId: string): UsageSyncState {
    const loop = this.#loops.get(nodeId)
    return {
      state: loop?.state ?? 'idle',
      collectorId: loop?.collectorId ?? null,
      lastError: loop?.lastError ?? null,
      consecutiveFailures: loop?.consecutiveFailures ?? 0,
      lastSyncAt: loop?.lastSyncAt ?? null,
    }
  }

  /**
   * Begin polling a node.
   *
   * Idempotent: calling it twice does not create a second loop, which is what
   * keeps a reconnect storm from multiplying requests to one node.
   * @param nodeId - the node to poll.
   */
  startNode(nodeId: string): void {
    if (this.#disposed) return
    const existing = this.#loops.get(nodeId)
    if (existing !== undefined && !existing.stopped) {
      // A reconnect is a good moment to try immediately rather than wait out the
      // current delay.
      this.#kick(nodeId)
      return
    }
    const loop: NodeLoop = {
      stopped: false,
      timer: undefined,
      running: false,
      consecutiveFailures: 0,
      state: 'idle',
      collectorId: null,
      lastError: null,
      lastSyncAt: null,
    }
    this.#loops.set(nodeId, loop)
    this.#kick(nodeId)
  }

  /**
   * Stop polling a node.
   * @param nodeId - the node.
   */
  stopNode(nodeId: string): void {
    const loop = this.#loops.get(nodeId)
    if (loop === undefined) return
    loop.stopped = true
    loop.state = 'stopped'
    loop.timer?.cancel()
    loop.timer = undefined
    this.#loops.delete(nodeId)
  }

  /** Try immediately, e.g. because the node just became ready. */
  notifyReady(nodeId: string): void {
    this.startNode(nodeId)
  }

  /** The current collector id for a node, when one has been synced. */
  collectorIdOf(nodeId: string): string | null {
    return this.#loops.get(nodeId)?.collectorId ?? null
  }

  /**
   * Stop every loop and wait for in-flight work.
   *
   * Waiting matters: `stop()` closes the database, and an ingest that lands after
   * that would be an unhandled failure at shutdown.
   */
  async dispose(): Promise<void> {
    this.#disposed = true
    for (const nodeId of [...this.#loops.keys()]) this.stopNode(nodeId)
    await Promise.allSettled([...this.#inFlight])
  }

  /** Schedule one immediate pass if the loop is idle. */
  #kick(nodeId: string): void {
    const loop = this.#loops.get(nodeId)
    if (loop === undefined || loop.stopped || loop.running) return
    loop.timer?.cancel()
    loop.timer = undefined
    const run = this.#tick(nodeId)
    this.#inFlight.add(run)
    void run.finally(() => { this.#inFlight.delete(run) })
  }

  /** One pass: sync, then schedule the next. */
  async #tick(nodeId: string): Promise<void> {
    const loop = this.#loops.get(nodeId)
    if (loop === undefined || loop.stopped) return
    loop.running = true
    loop.state = 'running'
    let delay = this.#options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS
    try {
      await this.#syncOnce(nodeId, loop)
      loop.consecutiveFailures = 0
      loop.lastError = null
      loop.state = 'waiting'
      loop.lastSyncAt = new Date(this.#options.now?.() ?? this.#timers.now()).toISOString()
    } catch (error) {
      if (loop.stopped || this.#disposed) return
      if (error instanceof SyncPause) {
        loop.state = error.state
        loop.lastError = error.message
        delay = error.retryMs
      } else {
        loop.consecutiveFailures += 1
        loop.lastError = messageOf(error)
        loop.state = 'waiting'
        delay = this.#backoff(loop.consecutiveFailures)
        this.#options.logger?.warn('coordinator/usage-sync-failed', {
          nodeId,
          attempt: loop.consecutiveFailures,
          code: isCoordinatorError(error) ? error.code : 'unknown',
          message: loop.lastError,
        })
        // A fork or a reset is terminal for this generation: retrying would keep
        // re-reading the same conflicting sequence numbers.
        if (isCoordinatorError(error) && (error.code === 'usage/collector-fork' || error.code === 'usage/collector-reset-required')) {
          loop.state = error.code === 'usage/collector-fork' ? 'forked' : 'stopped'
          this.#repository.recordSyncFailure(nodeId, loop.collectorId, messageOf(error))
          loop.stopped = true
          this.#loops.delete(nodeId)
          return
        }
      }
    } finally {
      loop.running = false
    }
    if (loop.stopped || this.#disposed) return
    loop.timer = this.#timers.setTimeout(() => { this.#kick(nodeId) }, delay)
  }

  /** Exponential backoff, capped. */
  #backoff(failures: number): number {
    const base = this.#options.retryMs ?? DEFAULT_RETRY_MS
    const max = this.#options.maxRetryMs ?? MAX_RETRY_MS
    return Math.min(max, base * 2 ** Math.max(0, failures - 1))
  }

  /** Read and store every available page for one node. */
  async #syncOnce(nodeId: string, loop: NodeLoop): Promise<void> {
    if (!this.#options.isReady(nodeId)) {
      throw new SyncPause('waiting', 'the node is offline; usage stays queued on its side', this.#options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS)
    }
    const status = await this.#status(nodeId)
    loop.collectorId = status.collectorId
    this.#repository.recordStatus(nodeId, status)
    if (!status.enabled || status.state === 'disabled') {
      throw new SyncPause('unsupported', 'usage collection is disabled on this node', MAX_RETRY_MS)
    }
    if (status.state === 'unsupported') {
      throw new SyncPause('unsupported', 'this node does not support usage collection', MAX_RETRY_MS)
    }
    if (status.collectorId === null) {
      throw new SyncPause('unsupported', 'the node reported no collector', MAX_RETRY_MS)
    }

    const collectorId = status.collectorId
    const cursor = BigInt(this.#repository.getCursor(nodeId, collectorId))
    const acked = parseSeq(status.ackedThroughSeq)
    /*
      A node whose newest sequence is behind what we already stored has lost its
      queue (a restored backup, a reset directory). Reading on would either replay a
      different history under the same ids or silently stop advancing; the contract
      asks for an explicit stop and a human decision instead.
    */
    if (BigInt(status.latestIssuedSeq) < cursor) {
      throw new CoordinatorError(
        'usage/collector-reset-required',
        'the node\'s sequence is behind what this Coordinator already stored; reset or re-enable the node collector with a new collector id',
        { nodeId, cursor: cursor.toString(10), latestIssuedSeq: status.latestIssuedSeq },
      )
    }
    // Read from the lower of the two. The node may have delivered a page we stored
    // but never acknowledged; starting from its watermark re-offers that page,
    // which the repository recognises as a replay.
    let afterSeq = cursor < acked ? cursor : acked
    const limit = Math.min(MAX_SYNC_BATCH, this.#options.batchLimit ?? MAX_SYNC_BATCH)
    const maxBytes = Math.min(MAX_SYNC_BYTES, this.#options.maxBytes ?? MAX_SYNC_BYTES)

    for (;;) {
      if (loop.stopped || this.#disposed) return
      const batch = await this.#read(nodeId, { collectorId, afterSeq, limit, maxBytes })
      if (batch.collectorId !== collectorId) {
        throw new CoordinatorError(
          'usage/collector-mismatch',
          'the node answered for a different collector than the one requested',
          { nodeId, expected: collectorId, received: batch.collectorId },
        )
      }
      const result = this.#repository.ingest(nodeId, batch)
      // Only now is the data durable. The ACK is cumulative and idempotent, so a
      // retry after a lost ACK is harmless.
      await this.#ack(nodeId, { collectorId, throughSeq: result.ackThroughSeq })
      afterSeq = BigInt(result.ackThroughSeq)
      if (batch.events.length === 0 && batch.gaps.length === 0) return
      if (!batch.hasMore) return
      // Yield between pages so a large backlog cannot monopolise the event loop
      // while the API serves requests.
      await new Promise<void>(resolve => { setImmediate(resolve) })
    }
  }

  /** Ask for the node's collector status. */
  async #status(nodeId: string): Promise<UsageStatus> {
    try {
      const value = await this.#options.invoke(nodeId, USAGE_STATUS_ENDPOINT, {})
      return parseUsageStatus(value)
    } catch (error) {
      throw this.#translate(error)
    }
  }

  /** Ask for one page. */
  async #read(
    nodeId: string,
    request: { collectorId: string; afterSeq: bigint; limit: number; maxBytes: number },
  ): Promise<UsageBatch> {
    try {
      const value = await this.#options.invoke(nodeId, USAGE_READ_ENDPOINT, {
        request: {
          collectorId: request.collectorId,
          afterSeq: request.afterSeq.toString(10),
          limit: request.limit,
          maxBytes: request.maxBytes,
        },
      })
      return parseUsageBatch(value)
    } catch (error) {
      throw this.#translate(error)
    }
  }

  /** Acknowledge a stored prefix. */
  async #ack(nodeId: string, request: { collectorId: string; throughSeq: string }): Promise<void> {
    try {
      await this.#options.invoke(nodeId, USAGE_ACK_ENDPOINT, { request })
    } catch (error) {
      // A failed ACK is not a failed ingest: the data is committed, and the node
      // will re-offer the page on the next read. Surfacing it as an error would
      // make the loop look broken while it is doing exactly the right thing.
      this.#options.logger?.warn('coordinator/usage-ack-failed', {
        nodeId,
        collectorId: request.collectorId,
        message: messageOf(error),
      })
    }
  }

  /** Map "this node has no such capability" onto a pause rather than an error storm. */
  #translate(error: unknown): unknown {
    /*
      The code may arrive on a `CoordinatorError` (this service's own boundary) or on
      the failure object the node reported, which is a plain object once it has
      crossed the RPC boundary. Reading it structurally covers both.
    */
    const code = isCoordinatorError(error)
      ? error.code
      : typeof (error as { code?: unknown }).code === 'string'
        ? String((error as { code: string }).code)
        : undefined
    if (code === undefined) return error
    if (
      code === 'node/capability-unavailable' ||
      code === 'gateway/invocation-unavailable' ||
      code === 'gateway/method-unavailable' ||
      code === 'gateway/service-unavailable'
    ) {
      return new SyncPause('unsupported', 'this node does not expose nodeUsage', MAX_RETRY_MS)
    }
    if (code === 'usage/collector-fork' || code === 'usage/collector-reset-required') {
      return new CoordinatorError(code, messageOf(error), {})
    }
    return error
  }
}

/** A condition that pauses the loop instead of counting as a failure. */
class SyncPause extends Error {
  readonly state: UsageSyncState['state']
  readonly retryMs: number

  constructor(state: UsageSyncState['state'], message: string, retryMs: number) {
    super(message)
    this.name = 'SyncPause'
    this.state = state
    this.retryMs = retryMs
  }
}

/** Parse a sequence string defensively. */
function parseSeq(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

/** A short, secret-free error message. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
