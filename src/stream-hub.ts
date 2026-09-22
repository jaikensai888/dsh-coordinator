/**
 * Outbound stream Remotes: open, consume, and terminate exactly once.
 *
 * Three protocol facts shape this file:
 *
 * 1. **There is no flow-control frame.** The only lever over a node that is
 *    producing faster than this service consumes is `stream.cancel`. So the
 *    buffer is bounded, and overflowing it is a *deliberate* failure
 *    (`coordinator/backpressure`) rather than unbounded growth — a Coordinator
 *    that runs out of memory takes every other node down with it (spec §4.4).
 * 2. **`seq` starts at 1 and steps by 1 per stream.** A gap or a repeat means the
 *    frame stream is not what the protocol says it is; that is a protocol error
 *    here, not something to paper over by appending values.
 * 3. **Exactly one terminal frame.** `stream.end` and `stream.error` are both
 *    terminal, and the first one to arrive decides; a second is ignored.
 *
 * @module dsh-coordinator/stream-hub
 */

import { CoordinatorError, type RemoteFailure } from './errors.js'
import { clampDuration, systemTimers, type TimerHandle, type TimerSource } from './timers.js'

/** Default ceiling on buffered values per stream. */
export const DEFAULT_MAX_BUFFERED_VALUES = 256

/** Default idle deadline: no frame at all for this long fails the stream. */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000

/** How a stream ended. */
export type StreamTermination =
  | { readonly ok: true; readonly count: number; readonly reason: 'end' }
  | { readonly ok: false; readonly error: RemoteFailure; readonly count: number; readonly reason: StreamAbandonReason }

/** Why a stream was abandoned before the node terminated it. */
export type StreamAbandonReason =
  /** No frame arrived within the idle deadline. */
  | 'timeout'
  /** The caller aborted, or called `cancel()`. */
  | 'cancelled'
  /** The link dropped. */
  | 'disconnected'
  /** A consumer fell further behind than the buffer allows. */
  | 'backpressure'
  /** The node sent frames this protocol does not allow. */
  | 'protocol'

/** Options for {@link StreamHub.open}. */
export interface OpenStreamOptions {
  /** Stream id to put in `stream.open`; must be unique among open streams. */
  readonly streamId: string
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /**
   * Idle deadline in milliseconds. Defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}.
   *
   * The hub deliberately does not take the arguments object: it never sends a
   * frame, so accepting arguments it does nothing with would suggest it does.
   */
  readonly timeoutMs?: number
  /** Buffered-value ceiling. Defaults to {@link DEFAULT_MAX_BUFFERED_VALUES}. */
  readonly maxBufferedValues?: number
  /** Abort signal; aborting cancels the stream on the node. */
  readonly signal?: AbortSignal
  /** Correlation id echoed by the node, when the caller has one. */
  readonly requestId?: string
}

/** Options for {@link StreamHub}. */
export interface StreamHubOptions {
  /** Maximum concurrently open streams. */
  readonly maxStreams: number
  /** Default idle deadline. */
  readonly defaultTimeoutMs: number
  /** Default buffer ceiling. */
  readonly maxBufferedValues: number
  /** Sends one `stream.cancel` for a stream id. Returns false when the link is gone. */
  readonly send: (streamId: string, reason: string) => boolean
  /** Injectable clock. */
  readonly timers?: TimerSource
}

/**
 * One stream this service opened, from the consumer's side.
 *
 * Implements `AsyncIterable`, so the common case is `for await (const value of
 * stream)`. The structured outcome is available from {@link RemoteStream.closed}
 * for callers that would rather branch than catch.
 */
export class RemoteStream implements AsyncIterable<unknown> {
  readonly streamId: string
  readonly endpoint: string

  readonly #queue: unknown[] = []
  readonly #waiters: (() => void)[] = []
  readonly #maxBufferedValues: number
  readonly #onTerminate: (streamId: string) => void
  readonly #onAbandon: (streamId: string, reason: string) => void
  readonly #timerFactory: () => TimerHandle
  #timer: TimerHandle | undefined
  #terminal: StreamTermination | undefined
  #values = 0
  #expectedSeq = 1
  #ready = false
  #resolveClosed!: (termination: StreamTermination) => void

  /** Resolves with the structured outcome once the stream terminates. */
  readonly closed: Promise<StreamTermination>

  /**
   * @param options - stream identity and limits.
   * @param onTerminate - called once when the stream reaches a terminal state.
   * @param timerFactory - arms a fresh idle deadline; called on every frame.
   * @param onAbandon - called when this side stops the stream, so the transport
   * can send `stream.cancel`. Without it a dropped stream would leave the node
   * producing into a socket nobody reads.
   */
  constructor(
    options: {
      readonly streamId: string
      readonly endpoint: string
      readonly maxBufferedValues: number
      readonly timeoutMs: number
      readonly onIdle: (streamId: string) => void
    },
    onTerminate: (streamId: string) => void,
    timerFactory: (callback: () => void, ms: number) => TimerHandle = (callback, ms) => systemTimers.setTimeout(callback, ms),
    onAbandon: (streamId: string, reason: string) => void = () => {},
  ) {
    this.streamId = options.streamId
    this.endpoint = options.endpoint
    this.#maxBufferedValues = Math.max(1, options.maxBufferedValues)
    this.#onTerminate = onTerminate
    this.#onAbandon = onAbandon
    this.#timerFactory = () => timerFactory(() => { options.onIdle(this.streamId) }, options.timeoutMs)
    this.closed = new Promise<StreamTermination>(resolve => { this.#resolveClosed = resolve })
    this.#timer = this.#timerFactory()
  }

  /** Values delivered so far. */
  get count(): number {
    return this.#values
  }

  /** Whether a terminal frame or a local failure has settled this stream. */
  get terminated(): boolean {
    return this.#terminal !== undefined
  }

  /** Whether the node has acknowledged the open with `stream.ready`. */
  get ready(): boolean {
    return this.#ready
  }

  /** Values still waiting to be consumed. */
  get buffered(): number {
    return this.#queue.length
  }

  // ---------------------------------------------------------------- inbound

  /**
   * `stream.ready` arrived.
   * @throws CoordinatorError `coordinator/stream-closed` when already terminal.
   */
  markReady(): void {
    if (this.#terminal !== undefined) {
      throw new CoordinatorError('coordinator/stream-closed', `stream "${this.streamId}" is already closed`, {
        streamId: this.streamId,
      })
    }
    this.#ready = true
    this.#rearm()
  }

  /**
   * `stream.data` arrived.
   * @param seq - the node's sequence number, starting at 1.
   * @param value - the yielded value.
   * @returns false when the frame was dropped because the stream already ended.
   */
  push(seq: number, value: unknown): boolean {
    if (this.#terminal !== undefined) return false
    if (!Number.isInteger(seq) || seq !== this.#expectedSeq) {
      // Out of order, duplicated, or skipped. The protocol gives `seq` exactly
      // so this is detectable; continuing would silently corrupt the value
      // sequence a consumer is reconstructing.
      this.abandon(
        'coordinator/protocol-invalid',
        `stream "${this.streamId}" expected seq ${this.#expectedSeq} but received ${String(seq)}`,
        'protocol',
        { expected: this.#expectedSeq, received: seq },
      )
      return false
    }
    this.#expectedSeq += 1
    this.#values += 1
    this.#queue.push(value)
    this.#rearm()
    if (this.#queue.length > this.#maxBufferedValues) {
      this.abandon(
        'coordinator/backpressure',
        `a consumer left more than ${this.#maxBufferedValues} values unread on "${this.endpoint}"`,
        'backpressure',
        { buffered: this.#queue.length },
      )
      return false
    }
    this.#wake()
    return true
  }

  /**
   * `stream.end` arrived: normal completion.
   * @param count - the node's own count of yielded values.
   */
  end(count: number): void {
    if (this.#terminal !== undefined) return
    this.#finish({ ok: true, count, reason: 'end' })
  }

  /**
   * The stream ended for a reason **on this side**, or on the node's terms.
   *
   * Terminating locally is not enough for the cases that matter: when this
   * service stops consuming, the node has no way to learn that except through
   * `stream.cancel`, and it would otherwise keep producing into a socket nobody
   * reads for the life of the connection. {@link abandon} is the version that
   * tells the transport; `fail` is for "the node already ended it" (a terminal
   * frame) and "there is no link left to tell" (a disconnect).
   * @param error - the failure to report.
   * @param reason - why the stream ended.
   */
  fail(error: RemoteFailure, reason: StreamAbandonReason = 'disconnected'): void {
    if (this.#terminal !== undefined) return
    this.#finish({ ok: false, error, count: this.#values, reason })
  }

  // ---------------------------------------------------------------- outbound

  /**
   * Stop the stream, tell the consumer, and **notify the node**.
   *
   * The terminal state is set before the notification, so a `close` racing the
   * cancellation cannot turn one termination into two, and a notify callback that
   * throws cannot leave the stream half-open.
   * @param code - failure code to report to the consumer.
   * @param message - human-readable diagnosis.
   * @param reason - how the stream was abandoned.
   * @param details - extra non-sensitive context for the failure.
   * @returns the failure the consumer will observe.
   */
  abandon(
    code: string,
    message: string,
    reason: StreamAbandonReason,
    details: Record<string, unknown> = {},
  ): RemoteFailure {
    const failure: RemoteFailure = {
      code,
      message,
      details: { streamId: this.streamId, endpoint: this.endpoint, ...details },
    }
    const wasOpen = this.#terminal === undefined
    this.fail(failure, reason)
    if (wasOpen) {
      try {
        this.#onAbandon(this.streamId, message)
      } catch {
        // Telling the node is best-effort: the stream is already terminal, and a
        // broken notifier must not resurrect it.
      }
    }
    return failure
  }

  // ---------------------------------------------------------------- internals

  #rearm(): void {
    this.#timer?.cancel()
    this.#timer = this.#timerFactory()
  }

  #finish(termination: StreamTermination): void {
    this.#terminal = termination
    this.#timer?.cancel()
    this.#timer = undefined
    this.#wake()
    this.#onTerminate(this.streamId)
    this.#resolveClosed(termination)
  }

  #wake(): void {
    const waiters = this.#waiters.splice(0, this.#waiters.length)
    for (const wake of waiters) wake()
  }

  #wait(): Promise<void> {
    return new Promise<void>(resolve => { this.#waiters.push(resolve) })
  }

  /** @returns an async iterator over the stream's values. */
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        for (;;) {
          // `queue.shift()` may legitimately return `undefined` as a value, so
          // the emptiness test is the length, not the shifted value.
          if (this.#queue.length > 0) return { value: this.#queue.shift(), done: false }
          const terminal = this.#terminal
          if (terminal !== undefined) {
            if (terminal.ok) return { value: undefined, done: true }
            throw new CoordinatorError(terminal.error.code, terminal.error.message, terminal.error.details)
          }
          await this.#wait()
        }
      },
      return: async (): Promise<IteratorResult<unknown>> => {
        // A consumer that breaks out of `for await` (or whose loop body threw)
        // must not leave the node producing into a buffer nobody reads: the
        // iterator contract gives this side of the stream exactly one chance to
        // say so, and this is it.
        this.abandon(
          'coordinator/stream-closed',
          `the consumer stopped reading "${this.endpoint}"`,
          'cancelled',
        )
        return { value: undefined, done: true }
      },
    }
  }
}

/**
 * Opens streams, routes their frames, and keeps the "exactly one terminal"
 * invariant for all of them.
 */
export class StreamHub {
  readonly #streams = new Map<string, RemoteStream>()
  readonly #maxStreams: number
  readonly #defaultTimeoutMs: number
  readonly #maxBufferedValues: number
  readonly #send: (streamId: string, reason: string) => boolean
  readonly #timers: TimerSource
  #nextId = 0

  /** @param options - hub configuration, including the frame sink. */
  constructor(options: StreamHubOptions) {
    this.#maxStreams = Math.max(1, options.maxStreams)
    this.#defaultTimeoutMs = Math.max(1, options.defaultTimeoutMs)
    this.#maxBufferedValues = Math.max(1, options.maxBufferedValues)
    this.#send = options.send
    this.#timers = options.timers ?? systemTimers
  }

  /** How many streams are open. */
  get size(): number {
    return this.#streams.size
  }

  /** One open stream, if it is still open. */
  get(streamId: string): RemoteStream | undefined {
    return this.#streams.get(streamId)
  }

  /** Ids of every open stream, oldest first. */
  ids(): string[] {
    return [...this.#streams.keys()]
  }

  /** A stream id that has never been used by this hub. */
  nextStreamId(prefix = 's'): string {
    this.#nextId += 1
    return `${prefix}-${this.#nextId.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Register a stream and let the caller send `stream.open`.
   * @param options - stream identity, arguments, and limits.
   * @returns the stream handle, already waiting for frames.
   * @throws CoordinatorError `coordinator/stream-limit` or `invalid-arguments`.
   */
  open(options: OpenStreamOptions): RemoteStream {
    if (options.streamId === '') {
      throw new CoordinatorError('coordinator/invalid-arguments', 'a stream id is required', {})
    }
    if (this.#streams.has(options.streamId)) {
      throw new CoordinatorError('coordinator/invalid-arguments', `stream id "${options.streamId}" is already open`, {
        streamId: options.streamId,
      })
    }
    if (this.#streams.size >= this.#maxStreams) {
      throw new CoordinatorError(
        'coordinator/stream-limit',
        `the node already has ${this.#maxStreams} streams open`,
        { maxStreams: this.#maxStreams, endpoint: options.endpoint },
      )
    }

    const timeoutMs = clampDuration(options.timeoutMs, this.#defaultTimeoutMs, 1, 24 * 60 * 60 * 1000)
    const stream = new RemoteStream(
      {
        streamId: options.streamId,
        endpoint: options.endpoint,
        maxBufferedValues: clampDuration(options.maxBufferedValues, this.#maxBufferedValues, 1, 1_000_000),
        timeoutMs,
        onIdle: (streamId) => { this.#onIdle(streamId) },
      },
      (streamId) => { this.#streams.delete(streamId) },
      (callback, ms) => this.#timers.setTimeout(callback, ms),
      (streamId, reason) => { this.#send(streamId, reason) },
    )
    this.#streams.set(options.streamId, stream)

    const signal = options.signal
    if (signal !== undefined) {
      const onAbort = (): void => {
        this.cancel(options.streamId, 'the caller aborted')
      }
      if (signal.aborted) {
        // Never handed to the node, so there is nothing to cancel; the stream is
        // failed locally and never reaches `stream.open`.
        this.#streams.delete(options.streamId)
        stream.fail(
          {
            code: 'coordinator/request-aborted',
            message: `the caller aborted "${options.endpoint}" before it opened`,
            details: { endpoint: options.endpoint },
          },
          'cancelled',
        )
        return stream
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void stream.closed.then(() => { signal.removeEventListener('abort', onAbort) })
    }

    return stream
  }

  /**
   * Route `stream.ready` to its stream.
   * @param streamId - the stream named by the frame.
   * @returns false when no such stream is open.
   */
  onReady(streamId: string): boolean {
    const stream = this.#streams.get(streamId)
    if (stream === undefined) return false
    stream.markReady()
    return true
  }

  /**
   * Route `stream.data` to its stream.
   * @param streamId - the stream named by the frame.
   * @param seq - the frame's sequence number.
   * @param value - the yielded value.
   * @returns false when no such stream is open.
   */
  onData(streamId: string, seq: number, value: unknown): boolean {
    const stream = this.#streams.get(streamId)
    if (stream === undefined) return false
    return stream.push(seq, value)
  }

  /**
   * Route a terminal frame to its stream.
   * @param streamId - the stream named by the frame.
   * @param outcome - `end`, or the node's failure.
   * @returns false when no such stream is open (a late frame after a cancel).
   */
  onTerminal(streamId: string, outcome: { readonly ok: true; readonly count: number } | { readonly ok: false; readonly error: RemoteFailure; readonly count: number }): boolean {
    const stream = this.#streams.get(streamId)
    if (stream === undefined) return false
    if (outcome.ok) stream.end(outcome.count)
    else stream.fail(outcome.error, 'protocol')
    return true
  }

  /**
   * Abandon one stream and tell the node to stop.
   *
   * The `stream.cancel` frame is sent by the stream's own abandon notification,
   * so there is exactly one place that decides "this side stopped consuming" —
   * a second `#send` here would produce two cancels for one termination.
   * @param streamId - the stream to cancel.
   * @param reason - note carried in `stream.cancel`.
   * @returns the failure the consumer will observe, or undefined if unknown.
   */
  cancel(streamId: string, reason: string): RemoteFailure | undefined {
    const stream = this.#streams.get(streamId)
    if (stream === undefined) return undefined
    return stream.abandon(
      'coordinator/stream-closed',
      `stream "${streamId}" was cancelled: ${reason}`,
      'cancelled',
    )
  }

  /**
   * Fail every open stream.
   * @param failure - the failure each consumer receives.
   * @param reason - how the streams were abandoned.
   * @param notifyNode - whether to send `stream.cancel` for each; false when the
   * link is already gone.
   * @returns how many streams were terminated.
   */
  failAll(failure: RemoteFailure, reason: StreamAbandonReason = 'disconnected', notifyNode = false): number {
    const entries = [...this.#streams.entries()]
    for (const [streamId, stream] of entries) {
      // The stream leaves the map through its own terminal callback, so the map
      // is mutated while iterating a copy, never the live one. `fail`, not
      // `abandon`: the caller decides whether the node can still be told.
      stream.fail(failure, reason)
      if (notifyNode) this.#send(streamId, failure.message)
    }
    return entries.length
  }

  /** The idle deadline fired for a stream. */
  #onIdle(streamId: string): void {
    const stream = this.#streams.get(streamId)
    if (stream === undefined) return
    stream.abandon(
      'coordinator/request-timeout',
      `"${stream.endpoint}" produced nothing for too long`,
      'timeout',
    )
  }
}
