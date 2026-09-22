/**
 * One node connection, from the Coordinator's side of the socket.
 *
 * The state machine is the mirror image of the node's connector, and the
 * asymmetry is the whole point: the **node** dials and asks to be admitted, the
 * **Coordinator** decides. So this class owns the admission decision, the
 * connection id it hands out, and the half-open detector — the three things the
 * node cannot do for itself.
 *
 * Two rules encoded here are easy to get wrong and expensive to debug:
 *
 * 1. `hello.ok` must carry `connectionId`. The node treats a `hello.ok` without
 *    one as a **fatal** protocol error and stops retrying (spec §14 item 3).
 * 2. Every outbound frame must carry the node's own `nodeId`. The node drops a
 *    frame that names a different node — silently, from this side's point of
 *    view, which looks exactly like a hung request.
 *
 * @module dsh-coordinator/session
 */

import { CoordinatorError, failureOf, REDACTED, type RemoteFailure } from './errors.js'
import {
  decodeFrame,
  encodeFrame,
  isProtocolVersionFailure,
  parseEndpoint,
  type RawFrameData,
} from './frame-codec.js'
import { silentLogger, type CoordinatorLogger } from './log.js'
import type { AuthOutcome, NodeRegistry } from './node-registry.js'
import { connectionLostFailure, RequestTable } from './request-table.js'
import { StreamHub, type RemoteStream } from './stream-hub.js'
import { systemTimers, type TimerHandle, type TimerSource } from './timers.js'
import {
  PROTOCOL_VERSION,
  type CoordinatorOutboundFrame,
  type HelloFrame,
  type NodeCapabilitySummary,
  type NodeInboundFrame,
  type NodeRecord,
  type ReadyFrame,
} from './protocol.js'

/** WebSocket `readyState` value for an open socket. */
export const WS_OPEN = 1

/** Close codes in the private-use range that mean "your credentials were refused". */
export const WS_CLOSE_UNAUTHORIZED = 4401

/** Missed heartbeat intervals before this side declares the link half-open. */
export const HEARTBEAT_MISSES_ALLOWED = 2

/** How long to wait for a polite socket close before forcing it. */
export const CLOSE_GRACE_MS = 250

/** Cap on peer-supplied text kept for diagnostics. */
export const PEER_TEXT_LIMIT = 256

/** Minimal socket surface, satisfied by `ws` and by test doubles. */
export interface CoordinatorSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  /** `ws`-only escape hatch for a link that will not close politely. */
  terminate?(): void
  on(event: 'message', listener: (data: RawFrameData) => void): unknown
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Observable session lifecycle events. */
export type SessionEvent =
  | {
      readonly type: 'authenticated'
      readonly nodeId: string
      readonly connectionId: string
      readonly enrolled: boolean
      /** True when the accepted credential is also the enrollment secret. */
      readonly enrollmentSecret: boolean
    }
  | {
      readonly type: 'ready'
      readonly nodeId: string
      readonly connectionId: string
      readonly capabilities: NodeCapabilitySummary
      readonly surfaceChanged: boolean
      readonly previousSurfaceHash?: string
      /** The connection this one displaced, when the node reconnected. */
      readonly replacedConnectionId?: string
    }
  | {
      readonly type: 'auth-rejected'
      readonly nodeId: string
      readonly reason: string
    }
  | {
      readonly type: 'protocol-error'
      readonly nodeId?: string
      readonly code: string
      readonly message: string
      readonly details: Record<string, unknown>
    }
  | {
      readonly type: 'closed'
      readonly nodeId?: string
      readonly code: number
      readonly reason: string
      /** Always false: this service never asks a node to reconnect on its behalf. */
      readonly willReconnect: boolean
    }

/** Session wiring and limits. */
export interface SessionOptions {
  /**
   * A key the owner uses to refer to this session before a `connectionId` exists.
   *
   * The connection id is only minted once a `hello` is accepted, but the owner
   * has to file the session the moment the socket is accepted — otherwise the
   * first lifecycle event arrives before there is anywhere to put it.
   */
  readonly sessionKey?: string
  /** The accepted socket. */
  readonly socket: CoordinatorSocket
  /** Where identity and credential decisions are made. */
  readonly registry: NodeRegistry
  /** Deadline for the `hello` frame. */
  readonly handshakeTimeoutMs: number
  /** Ping cadence, also the half-open detection window denominator. */
  readonly heartbeatIntervalMs: number
  /** Largest frame either direction. */
  readonly maxFrameBytes: number
  /** Concurrent unary calls per node. */
  readonly maxInFlightRequests: number
  /** Concurrent streams per node. */
  readonly maxStreams: number
  /** Default unary deadline. */
  readonly requestTimeoutMs: number
  /** Default stream idle deadline. */
  readonly streamIdleTimeoutMs: number
  /** Default per-stream buffer ceiling. */
  readonly maxBufferedValues: number
  /** Injectable clock. */
  readonly timers?: TimerSource
  /** Redacting logger. */
  readonly logger?: CoordinatorLogger
  /** Lifecycle observer. Observers are contained: a throwing one is logged, not propagated. */
  readonly onEvent?: (event: SessionEvent) => void
}

/** The state of this connection, from the Coordinator's side. */
export type SessionState = 'connecting' | 'authenticating' | 'ready' | 'closing' | 'offline'

/**
 * A single node link.
 *
 * Created by the server for every accepted socket; it either becomes `ready` and
 * serves calls, or it is closed. It never retries: reconnection is the node's job
 * (it is the one that dials), and a Coordinator that dialled back would break the
 * "nodes listen on no port" property.
 */
export class NodeSession {
  /** Stable key for the owner's bookkeeping; independent of `connectionId`. */
  readonly sessionKey: string

  readonly #socket: CoordinatorSocket
  readonly #registry: NodeRegistry
  readonly #timers: TimerSource
  readonly #logger: CoordinatorLogger
  readonly #onEvent: ((event: SessionEvent) => void) | undefined
  readonly #handshakeTimeoutMs: number
  readonly #heartbeatIntervalMs: number
  readonly #maxFrameBytes: number

  readonly #requests: RequestTable
  readonly #streams: StreamHub

  #state: SessionState = 'connecting'
  #nodeId: string | undefined
  #connectionId: string | undefined
  #record: NodeRecord | undefined
  #capabilities: NodeCapabilitySummary | undefined
  #lastInboundAt: number
  #lastError: Error | undefined
  #handshakeTimer: TimerHandle | undefined
  #heartbeatTimer: TimerHandle | undefined
  #closeWatchdog: TimerHandle | undefined
  #closed = false
  #requestSeq = 0

  /** @param options - wiring and limits. */
  constructor(options: SessionOptions) {
    this.sessionKey = options.sessionKey ?? `anon-${Math.random().toString(36).slice(2, 10)}`
    this.#socket = options.socket
    this.#registry = options.registry
    this.#timers = options.timers ?? systemTimers
    this.#logger = options.logger ?? silentLogger
    this.#onEvent = options.onEvent
    this.#handshakeTimeoutMs = Math.max(1, options.handshakeTimeoutMs)
    this.#heartbeatIntervalMs = Math.max(10, options.heartbeatIntervalMs)
    this.#maxFrameBytes = Math.max(1_024, options.maxFrameBytes)

    this.#requests = new RequestTable({
      maxInFlight: options.maxInFlightRequests,
      defaultTimeoutMs: options.requestTimeoutMs,
      timers: this.#timers,
      onAbandon: (requestId, reason, failure) => {
        // The node may still be working on the call; tell it to stop. A
        // disconnect is excluded: there is no link left to carry the frame.
        if (reason === 'disconnected') return
        this.#sendFrame({
          type: 'rpc.cancel',
          protocolVersion: PROTOCOL_VERSION,
          nodeId: this.#nodeId ?? '',
          requestId,
          reason: failure.message,
        })
      },
    })
    this.#streams = new StreamHub({
      maxStreams: options.maxStreams,
      defaultTimeoutMs: options.streamIdleTimeoutMs,
      maxBufferedValues: options.maxBufferedValues,
      timers: this.#timers,
      send: (streamId, reason) => this.#sendFrame({
        type: 'stream.cancel',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: this.#nodeId ?? '',
        streamId,
        reason,
      }),
    })

    this.#lastInboundAt = this.#timers.now()
    this.#bindSocket()
    this.#armHandshake()
  }

  // ---------------------------------------------------------------- accessors

  /** Where this link is in the handshake. */
  get state(): SessionState {
    return this.#state
  }

  /** The node this link serves, once `hello` was accepted. */
  get nodeId(): string | undefined {
    return this.#nodeId
  }

  /** The connection id handed to the node in `hello.ok`. */
  get connectionId(): string | undefined {
    return this.#connectionId
  }

  /** The capability surface from the node's `ready`. */
  get capabilities(): NodeCapabilitySummary | undefined {
    return this.#capabilities
  }

  /** Whether any frame has been received since the socket was accepted. */
  get lastInboundAt(): number {
    return this.#lastInboundAt
  }

  /** Unary calls still waiting for `rpc.result`. */
  get inFlightRequests(): number {
    return this.#requests.size
  }

  /** Streams considered open. */
  get activeStreams(): number {
    return this.#streams.size
  }

  // ---------------------------------------------------------------- calls

  /**
   * Call one unary Remote on this node.
   *
   * The carrier is chosen from the node's own capability summary, never guessed:
   * a `unary` endpoint sent as a stream comes back as
   * `gateway/signature-invalid` from the node's Gateway, which reads like a bug
   * in the business call rather than in the carrier choice.
   * @param endpoint - canonical `<namespace>/<method>`.
   * @param args - named arguments object.
   * @param options - deadline and abort signal.
   * @returns the Remote's value.
   * @throws CoordinatorError on any failure, with the node's own code preserved.
   */
  async invoke(
    endpoint: string,
    args: Readonly<Record<string, unknown>> = {},
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.#requireEndpoint(endpoint)
    this.#requireReady()
    this.#registry.resolveCapability(this.#nodeId as string, endpoint, 'unary')

    const requestId = this.#nextRequestId('r')
    const pending = this.#requests.begin(requestId, {
      endpoint,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    this.#syncCounters()

    const sent = this.#sendFrame({
      type: 'rpc.request',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.#nodeId as string,
      requestId,
      endpoint,
      payload: { args },
    })
    if (!sent) {
      this.#requests.settle(requestId, {
        ok: false,
        error: connectionLostFailure(endpoint, 'the socket was not writable'),
      })
    }

    const outcome = await pending
    this.#syncCounters()
    if (!outcome.ok) throw fromFailure(outcome.error)
    return outcome.value
  }

  /**
   * Open one stream Remote on this node.
   *
   * Synchronous on purpose: the stream is registered *before* `stream.open`
   * reaches the socket, so a node that answers immediately cannot produce a value
   * that lands before there is anywhere to put it.
   * @param endpoint - canonical `<namespace>/<method>`.
   * @param args - named arguments object.
   * @param options - idle deadline, buffer ceiling, abort signal.
   * @returns the stream handle.
   */
  openStream(
    endpoint: string,
    args: Readonly<Record<string, unknown>> = {},
    options: {
      readonly timeoutMs?: number
      readonly maxBufferedValues?: number
      readonly signal?: AbortSignal
      readonly requestId?: string
    } = {},
  ): RemoteStream {
    this.#requireEndpoint(endpoint)
    this.#requireReady()
    this.#registry.resolveCapability(this.#nodeId as string, endpoint, 'stream')

    const streamId = this.#streams.nextStreamId()
    const stream = this.#streams.open({
      streamId,
      endpoint,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxBufferedValues === undefined ? {} : { maxBufferedValues: options.maxBufferedValues }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    })
    this.#syncCounters()

    const sent = this.#sendFrame({
      type: 'stream.open',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.#nodeId as string,
      streamId,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      endpoint,
      payload: { args },
    })
    if (!sent) {
      stream.fail(
        {
          code: 'coordinator/connection-lost',
          message: `the socket closed before "${endpoint}" could be opened`,
          details: { endpoint },
        },
        'disconnected',
      )
      this.#syncCounters()
    }
    return stream
  }

  /**
   * Stop producing on one stream and release it.
   * @param streamId - the stream to cancel.
   * @param reason - note carried to the node.
   */
  cancelStream(streamId: string, reason = 'the consumer stopped reading'): void {
    this.#streams.cancel(streamId, reason)
    this.#syncCounters()
  }

  /**
   * Close the link politely.
   *
   * `reconnect: false` is only used for a protocol version this service cannot
   * speak: retrying cannot fix that, and the node would otherwise dial forever.
   * @param code - protocol-level close code, e.g. `node/auth-failed`.
   * @param reason - diagnostics for the node's log.
   * @param options - whether the node should try again.
   */
  close(code: string, reason: string, options: { readonly reconnect?: boolean; readonly wsCode?: number } = {}): void {
    if (this.#closed || this.#state === 'closing') return
    // Before `hello` there is no node id to address a frame to, and the node
    // ignores a frame that names a different node: the socket close carries the
    // message instead.
    if (this.#nodeId !== undefined) {
      this.#sendFrame({
        type: 'close',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: this.#nodeId,
        code,
        reason,
        ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
      })
    }
    this.#requestClose(options.wsCode ?? 1000, reason)
  }

  // ---------------------------------------------------------------- internals

  /** Attach socket listeners. */
  #bindSocket(): void {
    this.#socket.on('message', (data) => { this.#handleMessage(data) })
    this.#socket.on('error', (error) => {
      this.#lastError = error
      this.#logger.warn('coordinator/socket-error', { message: this.#peerText(error.message) })
    })
    this.#socket.on('close', (code, reason) => {
      this.#teardown(typeof code === 'number' ? code : 1006, this.#peerText(reasonText(reason)))
    })
  }

  /** Start the handshake deadline. */
  #armHandshake(): void {
    this.#handshakeTimer = this.#timers.setTimeout(() => {
      this.#handshakeTimer = undefined
      if (this.#state !== 'connecting') return
      this.#logger.warn('coordinator/handshake-failed', {
        reason: `no hello within ${this.#handshakeTimeoutMs} ms`,
      })
      this.#emit({
        type: 'protocol-error',
        code: 'coordinator/handshake-failed',
        message: `no hello frame arrived within ${this.#handshakeTimeoutMs} ms`,
        details: { handshakeTimeoutMs: this.#handshakeTimeoutMs },
      })
      this.close('handshake-timeout', 'no hello frame arrived in time')
    }, this.#handshakeTimeoutMs)
  }

  #handleMessage(data: RawFrameData): void {
    this.#lastInboundAt = this.#timers.now()
    if (this.#closed) return

    let frame: NodeInboundFrame
    try {
      frame = decodeFrame(data, this.#maxFrameBytes)
    } catch (error) {
      const failure = failureOf(error)
      this.#logger.warn('coordinator/protocol-error', { code: failure.code, message: failure.message, ...failure.details })
      this.#emit({
        type: 'protocol-error',
        ...(this.#nodeId === undefined ? {} : { nodeId: this.#nodeId }),
        code: failure.code,
        message: failure.message,
        details: failure.details,
      })
      this.#lastError = new CoordinatorError(failure.code, failure.message, failure.details)
      // Another protocol version can never be retried into compatibility, so tell
      // the node not to bother (spec §6.1); anything else is worth another try.
      const fatal = isProtocolVersionFailure(error)
      if (this.#state === 'ready' && !fatal) return
      this.close(failure.code, failure.message, fatal ? { reconnect: false } : {})
      return
    }

    this.#logger.frame('in', frame)
    this.#handleFrame(frame)
  }

  #handleFrame(frame: NodeInboundFrame): void {
    // Heartbeats are transport-level and legal in every state.
    if (frame.type === 'ping') {
      this.#sendFrame({
        type: 'pong',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: this.#nodeId ?? frame.nodeId,
        ...(frame.messageId === undefined ? {} : { messageId: frame.messageId }),
      })
      return
    }
    if (frame.type === 'pong') return

    if (frame.type === 'close') {
      this.#logger.info('coordinator/node-closing', { reason: this.#peerText(frame.reason ?? frame.code ?? '') })
      this.#requestClose(1000, this.#peerText(frame.reason ?? 'the node closed the connection'))
      return
    }

    if (this.#state === 'connecting') {
      if (frame.type !== 'hello') {
        this.#protocolError(`a ${frame.type} frame arrived before hello`, { type: frame.type })
        this.close('node/protocol-invalid', `${frame.type} is not legal before hello`)
        return
      }
      this.#acceptHello(frame)
      return
    }

    if (this.#state === 'authenticating') {
      if (frame.type !== 'ready') {
        this.#protocolError(`a ${frame.type} frame arrived before ready`, { type: frame.type })
        this.close('node/protocol-invalid', `${frame.type} is not legal before ready`)
        return
      }
      this.#acceptReady(frame)
      return
    }

    if (this.#state !== 'ready' || frame.nodeId !== this.#nodeId) {
      // Either the link is closing, or the frame names another node. Ignoring is
      // the safe reading: the request tables on the live connection are keyed by
      // id, so a misplaced frame cannot settle one of them by accident.
      this.#logger.debug('coordinator/frame-ignored', { type: frame.type, state: this.#state })
      return
    }

    switch (frame.type) {
      case 'rpc.result':
        this.#requests.settle(
          frame.requestId,
          frame.result.ok
            ? { ok: true, value: frame.result.value }
            : { ok: false, error: frame.result.error },
        )
        this.#syncCounters()
        return
      case 'stream.ready':
        this.#streams.onReady(frame.streamId)
        return
      case 'stream.data': {
        const accepted = this.#streams.onData(frame.streamId, frame.seq, frame.value)
        if (!accepted && this.#streams.get(frame.streamId) === undefined) {
          this.#logger.debug('coordinator/frame-ignored', { type: frame.type, reason: 'unknown stream', streamId: frame.streamId })
        }
        return
      }
      case 'stream.end':
        this.#streams.onTerminal(frame.streamId, { ok: true, count: frame.count })
        this.#syncCounters()
        return
      case 'stream.error':
        this.#streams.onTerminal(frame.streamId, { ok: false, error: frame.error, count: frame.count })
        this.#syncCounters()
        return
      default:
        this.#protocolError(`a ${frame.type} frame is not legal after ready`, { type: frame.type })
        return
    }
  }

  /** Validate the `hello` and either admit the node or refuse it. */
  #acceptHello(frame: HelloFrame): void {
    this.#clearHandshake()
    let outcome: AuthOutcome
    try {
      // The display metadata rides along so an enrolled record is not anonymous.
      // It takes no part in the decision: `authenticate` compares only the id and
      // the token, per spec §9.2.
      outcome = this.#registry.authenticate({
        nodeId: frame.nodeId,
        token: frame.auth.token,
        ...(frame.nodeName === undefined ? {} : { nodeName: frame.nodeName }),
        ...(frame.role === undefined ? {} : { role: frame.role }),
      })
    } catch (error) {
      const failure = failureOf(error)
      const reason = typeof failure.details['reason'] === 'string' ? failure.details['reason'] : 'rejected'
      this.#logger.warn('coordinator/auth-rejected', { nodeId: frame.nodeId, reason })
      this.#emit({ type: 'auth-rejected', nodeId: frame.nodeId, reason })
      this.#nodeId = frame.nodeId
      // Refuse with the node's own auth vocabulary *and* the WebSocket 4401 code,
      // so the node takes its slow, bounded credential path rather than a hot
      // reconnect loop. The wire reason is deliberately identical for "unknown
      // node" and "wrong token": the handshake must not be an enumeration oracle.
      this.close('node/auth-failed', 'the Coordinator refused this node credential', {
        wsCode: WS_CLOSE_UNAUTHORIZED,
        // Explicit rather than omitted: a node that defaulted a missing
        // `reconnect` to false would stop for good on a wrong token, which is a
        // trap for an operator who is about to fix exactly that token.
        reconnect: true,
      })
      return
    }

    this.#record = outcome.record
    this.#nodeId = frame.nodeId
    this.#connectionId = `${frame.nodeId}:${this.#timers.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
    this.#state = 'authenticating'
    this.#emit({
      type: 'authenticated',
      nodeId: frame.nodeId,
      connectionId: this.#connectionId,
      enrolled: outcome.enrolled,
      enrollmentSecret: outcome.enrollmentSecret,
    })
    if (outcome.enrollmentSecret) {
      this.#logger.warn('coordinator/enrollment-secret-in-use', {
        nodeId: frame.nodeId,
        hint: 'issue a per-node token and rotate it; the enrollment secret admits any unknown node',
      })
    }

    // Order matters: `hello.ok` first, then anything else. The node treats a
    // non-`hello.ok` frame during the handshake as a protocol error.
    const sent = this.#sendFrame({
      type: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: frame.nodeId,
      connectionId: this.#connectionId,
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      maxFrameBytes: this.#maxFrameBytes,
      acceptedMode: frame.mode,
    })
    if (!sent) {
      this.#requestClose(1011, 'hello.ok could not be sent')
    }
  }

  /** Register the capability surface and become dispatchable. */
  #acceptReady(frame: ReadyFrame): void {
    const nodeId = this.#nodeId as string
    const connectionId = this.#connectionId as string
    if (frame.connectionId !== undefined && frame.connectionId !== connectionId) {
      this.#protocolError('ready echoes a different connectionId', {
        expected: connectionId,
        received: frame.connectionId,
      })
      this.close('node/protocol-invalid', 'ready echoed a connectionId this Coordinator did not issue')
      return
    }

    const at = new Date(this.#timers.now()).toISOString()
    const replaced = this.#registry.bind(nodeId, connectionId, at)
    const binding = this.#registry.setCapabilities(nodeId, connectionId, frame.capabilities, at)
    this.#capabilities = frame.capabilities
    this.#state = 'ready'
    this.#syncCounters()

    if (replaced.replaced !== undefined) {
      // Two `ready` connections for one node is a state this service must never
      // present: the server closes the older socket when it sees this event.
      this.#logger.warn('coordinator/connection-replaced', {
        nodeId,
        replacedConnectionId: replaced.replaced,
        connectionId,
      })
    }
    this.#logger.info('coordinator/node-ready', {
      nodeId,
      connectionId,
      remotes: frame.capabilities.remotes.length,
      surfaceChanged: binding.changed,
    })
    this.#emit({
      type: 'ready',
      nodeId,
      connectionId,
      capabilities: frame.capabilities,
      surfaceChanged: binding.changed,
      ...(binding.previousHash === undefined ? {} : { previousSurfaceHash: binding.previousHash }),
      ...(replaced.replaced === undefined ? {} : { replacedConnectionId: replaced.replaced }),
    })
    this.#startHeartbeat()
  }

  /** Ping on a cadence and declare the link half-open when nothing comes back. */
  #startHeartbeat(): void {
    this.#heartbeatTimer?.cancel()
    const tick = (): void => {
      if (this.#closed || this.#state === 'offline' || this.#state === 'closing') return
      const now = this.#timers.now()
      if (now - this.#lastInboundAt > this.#heartbeatIntervalMs * HEARTBEAT_MISSES_ALLOWED) {
        this.#logger.warn('coordinator/heartbeat-lost', {
          nodeId: this.#nodeId,
          silentForMs: now - this.#lastInboundAt,
        })
        this.#heartbeatTimer = undefined
        this.close('heartbeat-timeout', 'no frame from the node within the heartbeat window')
        return
      }
      this.#sendFrame({
        type: 'ping',
        protocolVersion: PROTOCOL_VERSION,
        nodeId: this.#nodeId ?? '',
      })
      this.#heartbeatTimer = this.#timers.setTimeout(tick, this.#heartbeatIntervalMs)
    }
    this.#heartbeatTimer = this.#timers.setTimeout(tick, this.#heartbeatIntervalMs)
  }

  /** Send a `close` frame and close the socket, with a forced-close watchdog. */
  #requestClose(wsCode: number, reason: string): void {
    if (this.#closed) return
    const wasReady = this.#state === 'ready'
    this.#state = 'closing'
    if (wasReady && this.#nodeId !== undefined && this.#connectionId !== undefined) {
      this.#registry.setState(this.#nodeId, this.#connectionId, 'closing')
    }
    const socket = this.#socket
    // Arm the watchdog before closing: `close()` may emit `close` synchronously,
    // and a watchdog armed afterwards would outlive the teardown it was watching.
    const watchdog = this.#timers.setTimeout(() => {
      try {
        socket.terminate?.()
      } catch {
        // Nothing left to terminate.
      }
      this.#teardown(1006, 'forced close')
    }, CLOSE_GRACE_MS)
    this.#closeWatchdog = watchdog
    try {
      socket.close(wsCode, this.#peerText(reason))
    } catch {
      // Already closing.
    }
  }

  /** Final teardown. Idempotent. */
  #teardown(code: number, reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#state = 'offline'
    this.#clearHandshake()
    this.#heartbeatTimer?.cancel()
    this.#heartbeatTimer = undefined
    this.#closeWatchdog?.cancel()
    this.#closeWatchdog = undefined

    const detail = this.#lastError === undefined ? reason : `${reason} (${this.#lastError.message})`
    const failure: RemoteFailure = {
      code: 'coordinator/connection-lost',
      message: `the node connection ended: ${detail}`,
      details: { closeCode: code },
    }
    // No frame can be sent now, so the tables settle locally and the node's own
    // teardown fails its side. Nothing is replayed (spec §1.1 item 8).
    this.#requests.failAll(failure)
    this.#streams.failAll(failure, 'disconnected', false)

    const nodeId = this.#nodeId
    const connectionId = this.#connectionId
    if (nodeId !== undefined && connectionId !== undefined) {
      this.#registry.unbind(nodeId, connectionId)
    }
    this.#logger.info('coordinator/connection-closed', { nodeId, closeCode: code, reason })
    this.#emit({
      type: 'closed',
      ...(nodeId === undefined ? {} : { nodeId }),
      code,
      reason,
      willReconnect: false,
    })
  }

  /** Send one frame, refusing to emit anything over the negotiated size. */
  #sendFrame(frame: CoordinatorOutboundFrame): boolean {
    if (this.#closed || this.#socket.readyState !== WS_OPEN) return false
    let text: string
    try {
      text = encodeFrame(frame, this.#maxFrameBytes)
    } catch (error) {
      // A frame this service cannot legally send is a bug here, not a node
      // problem: report it and drop the frame rather than corrupting the stream.
      this.#logger.error('coordinator/frame-rejected', { type: frame.type, message: (error as Error).message })
      return false
    }
    this.#logger.frame('out', frame)
    try {
      this.#socket.send(text)
      return true
    } catch (error) {
      this.#lastError = error as Error
      return false
    }
  }

  #protocolError(message: string, details: Record<string, unknown>): void {
    this.#logger.warn('coordinator/protocol-error', { message, ...details })
    this.#emit({
      type: 'protocol-error',
      ...(this.#nodeId === undefined ? {} : { nodeId: this.#nodeId }),
      code: 'coordinator/protocol-invalid',
      message,
      details,
    })
  }

  #requireEndpoint(endpoint: string): void {
    if (parseEndpoint(endpoint) === undefined) {
      throw new CoordinatorError(
        'coordinator/invalid-arguments',
        `"${endpoint}" is not a <namespace>/<method> endpoint`,
        { endpoint },
      )
    }
  }

  #requireReady(): void {
    if (this.#state !== 'ready' || this.#nodeId === undefined) {
      throw new CoordinatorError(
        'coordinator/node-offline',
        `the node connection is ${this.#state}, not ready`,
        { state: this.#state },
      )
    }
  }

  #syncCounters(): void {
    if (this.#nodeId === undefined || this.#connectionId === undefined) return
    this.#registry.setCounters(this.#nodeId, this.#connectionId, {
      inFlightRequests: this.#requests.size,
      activeStreams: this.#streams.size,
    })
  }

  #clearHandshake(): void {
    this.#handshakeTimer?.cancel()
    this.#handshakeTimer = undefined
  }

  #nextRequestId(prefix: string): string {
    this.#requestSeq += 1
    return `${prefix}-${this.#requestSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /** Make peer-supplied text safe to log: no credential, no unbounded length. */
  #peerText(text: string): string {
    const policy = this.#registry.enrollmentPolicy
    const secrets = [this.#record?.token ?? '', policy.kind === 'shared-secret' ? policy.token : '']
    let scrubbed = text
    for (const secret of secrets) {
      if (secret !== '') scrubbed = scrubbed.split(secret).join(REDACTED)
    }
    return scrubbed.length > PEER_TEXT_LIMIT ? `${scrubbed.slice(0, PEER_TEXT_LIMIT)}…` : scrubbed
  }

  /** Notify the observer, containing its failures. */
  #emit(event: SessionEvent): void {
    if (this.#onEvent === undefined) return
    try {
      this.#onEvent(event)
    } catch (error) {
      this.#logger.error('coordinator/observer-failed', { message: (error as Error).message })
    }
  }
}

/** Turn a wire failure into the error thrown to callers. */
export function fromFailure(failure: RemoteFailure): CoordinatorError {
  return new CoordinatorError(failure.code, failure.message, failure.details)
}

/** Best-effort text from a WebSocket close reason. */
export function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason instanceof Error) return reason.message
  if (reason === undefined || reason === null) return ''
  if (typeof reason === 'object' && 'toString' in reason) return String(reason as { toString(): string })
  return String(reason)
}
