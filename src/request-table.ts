/**
 * In-flight unary calls, keyed by `requestId`.
 *
 * The whole point of this table is the **single-settlement gate**: a unary call
 * settles exactly once, whether the outcome arrives as `rpc.result`, as a
 * deadline, as a caller abort, or as a disconnect. Every one of those paths goes
 * through {@link RequestTable.settle}, so "exactly one" is enforced in one place
 * instead of being a property four code paths have to remember.
 *
 * Timeouts live here rather than at the node because the node's own
 * `requestTimeoutMs` is a *local* safety net; "this call gets 30 seconds through
 * the Coordinator" is the Coordinator's promise to its caller (spec §4.2).
 *
 * @module dsh-coordinator/request-table
 */

import { CoordinatorError, type RemoteFailure } from './errors.js'
import { clampDuration, systemTimers, type TimerHandle, type TimerSource } from './timers.js'

/** Why a request stopped waiting before a result arrived. */
export type AbandonReason = 'timeout' | 'aborted' | 'disconnected'

/** What the caller of {@link RequestTable.begin} receives. Never rejects. */
export type RequestOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: RemoteFailure }

/** Options for {@link RequestTable.begin}. */
export interface BeginOptions {
  /** Canonical `<namespace>/<method>` endpoint, for diagnostics and audit. */
  readonly endpoint: string
  /** Deadline in milliseconds. Defaults to the table's `defaultTimeoutMs`. */
  readonly timeoutMs?: number
  /** Abort signal; aborting settles the call as aborted. */
  readonly signal?: AbortSignal
}

/** Options for {@link RequestTable}. */
export interface RequestTableOptions {
  /** Maximum concurrent calls. Calls over the limit fail immediately. */
  readonly maxInFlight: number
  /** Deadline applied when a call does not state one. */
  readonly defaultTimeoutMs: number
  /** Injectable clock. */
  readonly timers?: TimerSource
  /**
   * Called when a call is abandoned while it may still be running on the node,
   * so the transport can send `rpc.cancel`. Not called for a disconnect: there is
   * no link left to cancel over.
   */
  readonly onAbandon?: (requestId: string, reason: AbandonReason, failure: RemoteFailure) => void
}

/** One waiting call. */
interface Pending {
  readonly requestId: string
  readonly endpoint: string
  readonly startedAt: number
  /** Mutable: armed after the entry is registered, cancelled on settlement. */
  timer: TimerHandle | undefined
  removeAbortListener: (() => void) | undefined
  settle(outcome: RequestOutcome): void
}

/** Failures this table raises on its own behalf. */
export function requestTimeoutFailure(endpoint: string, timeoutMs: number): RemoteFailure {
  return {
    code: 'coordinator/request-timeout',
    message: `"${endpoint}" did not answer within ${timeoutMs} ms`,
    details: { endpoint, timeoutMs },
  }
}

/** The failure used when the caller aborts. */
export function requestAbortedFailure(endpoint: string): RemoteFailure {
  return {
    code: 'coordinator/request-aborted',
    message: `the caller aborted "${endpoint}"`,
    details: { endpoint },
  }
}

/** The failure used when the link drops under an in-flight call. */
export function connectionLostFailure(endpoint: string, detail: string): RemoteFailure {
  return {
    code: 'coordinator/connection-lost',
    message: `the node connection was lost while "${endpoint}" was in flight: ${detail}`,
    details: { endpoint },
  }
}

/**
 * Tracks unary calls that are waiting for a `rpc.result`.
 */
export class RequestTable {
  readonly #pending = new Map<string, Pending>()
  readonly #maxInFlight: number
  readonly #defaultTimeoutMs: number
  readonly #timers: TimerSource
  readonly #onAbandon: RequestTableOptions['onAbandon']

  /** @param options - table configuration. */
  constructor(options: RequestTableOptions) {
    this.#maxInFlight = Math.max(1, options.maxInFlight)
    this.#defaultTimeoutMs = Math.max(1, options.defaultTimeoutMs)
    this.#timers = options.timers ?? systemTimers
    this.#onAbandon = options.onAbandon
  }

  /** Number of calls still waiting. */
  get size(): number {
    return this.#pending.size
  }

  /** Whether a request id is still waiting. */
  has(requestId: string): boolean {
    return this.#pending.has(requestId)
  }

  /** Every waiting request id, oldest first. */
  ids(): string[] {
    return [...this.#pending.keys()]
  }

  /**
   * Register a call and start its deadline.
   *
   * @param requestId - id to put in `rpc.request`; must not already be in flight.
   * @param options - endpoint, deadline, abort signal.
   * @returns a promise for the single outcome of this call.
   * @throws CoordinatorError `coordinator/request-limit` when full, or
   * `coordinator/invalid-arguments` on a duplicate id.
   */
  begin(requestId: string, options: BeginOptions): Promise<RequestOutcome> {
    if (requestId === '') {
      throw new CoordinatorError('coordinator/invalid-arguments', 'a request id is required', {})
    }
    if (this.#pending.has(requestId)) {
      throw new CoordinatorError('coordinator/invalid-arguments', `request id "${requestId}" is already in flight`, {
        requestId,
      })
    }
    if (this.#pending.size >= this.#maxInFlight) {
      throw new CoordinatorError(
        'coordinator/request-limit',
        `the node already has ${this.#maxInFlight} calls in flight`,
        { maxInFlight: this.#maxInFlight, endpoint: options.endpoint },
      )
    }

    const timeoutMs = clampDuration(options.timeoutMs, this.#defaultTimeoutMs, 1, 24 * 60 * 60 * 1000)
    let settle!: (outcome: RequestOutcome) => void
    const promise = new Promise<RequestOutcome>(resolve => { settle = resolve })

    const entry: Pending = {
      requestId,
      endpoint: options.endpoint,
      startedAt: this.#timers.now(),
      timer: undefined,
      removeAbortListener: undefined,
      settle: (outcome) => {
        // The gate: first settlement wins, and the entry is gone before the
        // caller resumes, so a later frame cannot reach it.
        if (this.#pending.get(requestId) !== entry) return
        this.#pending.delete(requestId)
        entry.timer?.cancel()
        entry.removeAbortListener?.()
        settle(outcome)
      },
    }
    // Register before scheduling anything: `settle` decides "first settlement
    // wins" by identity against the map, so the entry must already be in it.
    this.#pending.set(requestId, entry)

    const signal = options.signal
    if (signal?.aborted === true) {
      entry.settle({ ok: false, error: requestAbortedFailure(options.endpoint) })
      return promise
    }

    entry.timer = this.#timers.setTimeout(() => {
      const failure = requestTimeoutFailure(options.endpoint, timeoutMs)
      this.#onAbandon?.(requestId, 'timeout', failure)
      entry.settle({ ok: false, error: failure })
    }, timeoutMs)

    if (signal !== undefined) {
      const onAbort = (): void => {
        const failure = requestAbortedFailure(options.endpoint)
        this.#onAbandon?.(requestId, 'aborted', failure)
        entry.settle({ ok: false, error: failure })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.removeAbortListener = () => { signal.removeEventListener('abort', onAbort) }
    }

    return promise
  }

  /**
   * Deliver the node's answer.
   * @param requestId - the id from `rpc.result`.
   * @param outcome - the result or failure.
   * @returns true when this settlement was the first one.
   */
  settle(requestId: string, outcome: RequestOutcome): boolean {
    const entry = this.#pending.get(requestId)
    if (entry === undefined) return false
    entry.settle(outcome)
    return true
  }

  /**
   * Fail every waiting call, e.g. because the link dropped.
   * @param failure - the failure to hand to each caller.
   * @param reason - how the calls were abandoned.
   * @returns how many callers were settled.
   */
  failAll(failure: RemoteFailure, reason: AbandonReason = 'disconnected'): number {
    const entries = [...this.#pending.values()]
    for (const entry of entries) {
      if (reason !== 'disconnected') this.#onAbandon?.(entry.requestId, reason, failure)
      entry.settle({ ok: false, error: failure })
    }
    return entries.length
  }

  /** In-flight calls with their start time, for status displays. */
  snapshot(): readonly { readonly requestId: string; readonly endpoint: string; readonly startedAt: number }[] {
    return [...this.#pending.values()].map(entry => ({
      requestId: entry.requestId,
      endpoint: entry.endpoint,
      startedAt: entry.startedAt,
    }))
  }
}
