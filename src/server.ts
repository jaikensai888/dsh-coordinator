/**
 * The Coordinator service: a WebSocket listener for nodes, plus the call surface.
 *
 * Only nodes dial in. This service never dials a node, and it never asks a node to
 * listen on a port — spec §14 item 6 is a property of the whole design, not just
 * of the node's implementation.
 *
 * Binding is loopback-only unless TLS is fronted by something else: a node token
 * is a bearer credential for **full DSH access on that machine**, and putting it
 * on a plaintext interface because "the token is random" would be a mistake worth
 * refusing at startup rather than documenting in a comment (spec §7).
 *
 * @module dsh-coordinator/server
 */

import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { CoordinatorError, type RemoteFailure } from './errors.js'
import { parseEndpoint, type RawFrameData } from './frame-codec.js'
import { allowsRemoteApi, createHttpApi, DEFAULT_MAX_BODY_BYTES, isLoopbackAddress, type HttpApi } from './http-api.js'
import { createLogger, type CoordinatorLogger } from './log.js'
import { NodeRegistry, type EnrollmentPolicy } from './node-registry.js'
import { NodeSession, type CoordinatorSocket, type SessionEvent } from './session.js'
import {
  buildCreateRequest,
  buildFollowRequest,
  buildPromptRequest,
  resolveSessionsOptions,
  type CreateSessionInput,
  type FollowSessionInput,
  type PromptSessionInput,
  type ResolvedSessionsOptions,
  type SessionsOptions,
} from './sessions.js'
import { DEFAULT_MAX_BUFFERED_VALUES, type RemoteStream } from './stream-hub.js'
import { describeState, readStateFile, resolveStateFile, writeStateFile } from './state-file.js'
import { systemTimers, type TimerSource } from './timers.js'
import type { NodeCapabilitySummary, NodeRecord, NodeView } from './protocol.js'

/** Default TCP port. Deliberately not the node's fake-coordinator port (39471). */
export const DEFAULT_PORT = 39472

/** Default upgrade path, matching the node's default `coordinatorUrl` path. */
export const DEFAULT_PATH = '/node'

/** Default bind address. */
export const DEFAULT_HOST = '127.0.0.1'

/** Default deadline for the `hello` frame. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

/** Default ping cadence. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

/** Default frame ceiling, both directions. */
export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Default concurrent unary calls per node. */
export const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 32

/** Default concurrent streams per node. */
export const DEFAULT_MAX_STREAMS = 16

/** Default unary deadline. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Default stream idle deadline. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000

/** Default per-stream buffer ceiling, re-exported so callers need one import. */
export { DEFAULT_MAX_BUFFERED_VALUES }

/** How long `stop()` waits for nodes to close politely before terminating them. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 1_000

/**
 * Below this length, setting an enrollment secret logs a warning.
 *
 * A shared secret is the right to turn a machine into a node, and every node
 * token is full access to that machine, so a short one is a real weakness. It is
 * a *warning* and not a rejection because this service also has to be usable for
 * exactly what it is being used for right now — a loopback test on one machine —
 * and a validator that refuses the operator's chosen value is how a safety
 * feature gets switched off entirely instead of used carefully.
 */
export const ENROLLMENT_SECRET_WARN_LENGTH = 16

/**
 * The session Remotes this service knows by name.
 *
 * Kept in `sessions.ts` and re-exported here so that a caller who only imports the
 * server does not have to learn a second module to find the defaults. The reasoning
 * behind the concession — and the argument names, which really are different per
 * endpoint — lives there.
 */
export * from './sessions.js'

/** Options for {@link Coordinator}. */
export interface CoordinatorOptions {
  /** TCP port. 0 asks the OS for a free one, which is what tests use. */
  readonly port?: number
  /** Bind address. Defaults to {@link DEFAULT_HOST}. */
  readonly host?: string
  /** WebSocket upgrade path. Defaults to {@link DEFAULT_PATH}. */
  readonly path?: string
  /** Pre-approved nodes. */
  readonly records?: readonly NodeRecord[]
  /** An already-built registry, when the embedder wants to own it. */
  readonly registry?: NodeRegistry
  /** How unknown nodes are handled. Defaults to closed. */
  readonly enrollment?: EnrollmentPolicy
  /**
   * Where to persist the registry and the enrollment secret.
   *
   * `undefined` means "no persistence" — the embedder owns it. A string is a path,
   * resolved by {@link resolveStateFile}. Persistence is what makes a secret set in
   * the UI survive a restart; see `state-file.ts` for how the file is protected.
   */
  readonly stateFile?: string
  /**
   * True when {@link enrollment} came from an explicit command-line flag.
   *
   * The distinction matters on restore: a stored secret normally wins, because the
   * point of persistence is to set it once. But a secret typed at launch is the
   * operator deliberately saying "this value, now", so it wins *and* replaces the
   * stored one rather than silently disagreeing with it.
   */
  readonly enrollmentFromCli?: boolean
  /** Allow a non-loopback bind without TLS. Off by default. */
  readonly allowInsecureBind?: boolean
  /** Bearer token for the operator API. Required when the bind is not loopback. */
  readonly apiToken?: string
  /** Install the operator API at all. Defaults to true. */
  readonly enableApi?: boolean
  /** Ceiling on an operator API request body. */
  readonly maxBodyBytes?: number
  /** Serve the bundled single-page UI at `/ui`. Defaults to true when the API is on. */
  readonly enableUi?: boolean
  /** Session Remotes. Installed by default; see {@link SessionsOptions}. */
  readonly sessions?: SessionsOptions
  readonly handshakeTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly maxFrameBytes?: number
  readonly maxInFlightRequests?: number
  readonly maxStreams?: number
  readonly requestTimeoutMs?: number
  readonly streamIdleTimeoutMs?: number
  readonly maxBufferedValues?: number
  /** Injectable clock, so tests can drive handshakes and heartbeats. */
  readonly timers?: TimerSource
  /** Redacting logger. */
  readonly logger?: CoordinatorLogger
  /** Lifecycle observer, receiving every session event. */
  readonly onEvent?: (event: SessionEvent) => void
  /** How long `stop()` waits before forcing sockets closed. */
  readonly shutdownGraceMs?: number
}

/** A resolved, validated option set. */
interface ResolvedOptions {
  port: number
  host: string
  path: string
  allowInsecureBind: boolean
  handshakeTimeoutMs: number
  heartbeatIntervalMs: number
  maxFrameBytes: number
  maxInFlightRequests: number
  maxStreams: number
  requestTimeoutMs: number
  streamIdleTimeoutMs: number
  maxBufferedValues: number
  shutdownGraceMs: number
  apiToken: string | undefined
  enableApi: boolean
  enableUi: boolean
  maxBodyBytes: number
  /** Absolute path, or undefined when persistence is off. */
  stateFile: string | undefined
  enrollmentFromCli: boolean
  sessions: ResolvedSessionsOptions
}

/** Where the server is listening, once it is. */
export interface CoordinatorAddress {
  readonly host: string
  readonly port: number
  readonly path: string
  /** The URL a node should be configured with. */
  readonly url: string
}

/** A snapshot of service health, without any credential. */
export interface CoordinatorStats {
  readonly listening: boolean
  readonly url?: string
  readonly nodes: number
  readonly ready: number
  readonly revoked: boolean | number
  readonly sessions: number
  readonly inFlightRequests: number
  readonly activeStreams: number
}

/**
 * A running Coordinator.
 *
 * One instance owns one listener, one registry, and the sessions that are live
 * right now. It is deliberately not a singleton: a process can host two, which is
 * how the tests exercise two nodes at once.
 */
export class Coordinator {
  readonly #options: ResolvedOptions
  /** Runtime operator credential; unlike the CLI option, this can be set from the UI. */
  #apiToken: string | undefined
  readonly #registry: NodeRegistry
  readonly #logger: CoordinatorLogger
  readonly #timers: TimerSource
  readonly #onEvent: ((event: SessionEvent) => void) | undefined
  /** Live sessions by the key this service assigned them. */
  readonly #sessions = new Map<string, NodeSession>()
  /** connection id (issued in `hello.ok`) -> session key. */
  readonly #byConnection = new Map<string, string>()
  /** node id -> session key currently serving it. */
  readonly #byNode = new Map<string, string>()
  #server: WebSocketServer | undefined
  #httpServer: Server | undefined
  #api: HttpApi | undefined
  #address: CoordinatorAddress | undefined
  #starting: Promise<CoordinatorAddress> | undefined
  #sessionSeq = 0
  #promptSeq = 0
  /** Serialises state-file writes; see {@link Coordinator.flushState}. */
  #persistChain: Promise<void> = Promise.resolve()
  /** True while a save is queued and has not yet read the registry. */
  #persistQueued = false

  /** @param options - listener, registry, and limits. */
  constructor(options: CoordinatorOptions = {}) {
    this.#options = resolveOptions(options)
    this.#apiToken = this.#options.apiToken
    this.#timers = options.timers ?? systemTimers
    this.#registry = options.registry ?? new NodeRegistry({
      ...(options.records === undefined ? {} : { records: options.records }),
      ...(options.enrollment === undefined ? {} : { enrollment: options.enrollment }),
      // Wired here rather than after `start()`: a record can be added by a
      // handshake, and a save that only ran once the listener was up would miss
      // the very enrollment it exists to remember.
      onStateChanged: () => { this.#persist() },
    })
    const secrets = (): readonly string[] => {
      const policy = this.#registry.enrollmentPolicy
      return [
        ...this.#registry.records().map(record => record.token),
        ...(policy.kind === 'shared-secret' ? [policy.token] : []),
        ...(this.#apiToken === undefined ? [] : [this.#apiToken]),
      ]
    }
    this.#logger = options.logger ?? createLogger({ level: 'info', secrets })
    this.#onEvent = options.onEvent
  }

  /** The registry, for embedders that manage records themselves. */
  get registry(): NodeRegistry {
    return this.#registry
  }

  /** Where this service is listening, or undefined before `start()`. */
  get address(): CoordinatorAddress | undefined {
    return this.#address
  }

  /**
   * Whether unknown nodes may enroll right now.
   *
   * Exposed as a **fact**, never as a value: there is no getter for the secret on
   * this class, so an operator API route cannot leak it by accident.
   */
  get enrollmentOpen(): boolean {
    return this.#registry.enrollmentOpen
  }

  /** Where the state file is, or undefined when persistence is off. */
  get stateFile(): string | undefined {
    return this.#options.stateFile
  }

  /** Whether the operator API currently has a bearer token configured. */
  get operatorTokenConfigured(): boolean {
    return this.#apiToken !== undefined
  }

  /**
   * Set the operator API bearer token.
   *
   * The value is kept in memory immediately and persisted through the same
   * serialised state queue as node records and the enrollment rule. It is never
   * returned to the caller or written to a log field.
   */
  setOperatorToken(token: string): void {
    const trimmed = token.trim()
    if (trimmed === '') {
      throw new CoordinatorError('coordinator/invalid-arguments', 'an operator token must be a non-empty string', {})
    }
    this.#apiToken = trimmed
    this.#persist()
    this.#logger.info('coordinator/operator-token-set', { length: trimmed.length, persisted: this.#options.stateFile !== undefined })
  }

  /**
   * Set or clear the enrollment secret.
   *
   * Takes effect on the next handshake. Persisted when a state file is configured,
   * so "set it once in the UI" survives a restart — which is the whole point.
   * @param secret - the new shared secret, or null to close enrollment.
   * @throws CoordinatorError `coordinator/invalid-arguments` on an unusable secret.
   */
  setEnrollmentSecret(secret: string | null): void {
    if (secret === null) {
      this.#registry.setEnrollment({ kind: 'closed' })
      this.#logger.info('coordinator/enrollment-closed', {})
      return
    }
    const trimmed = secret.trim()
    if (trimmed === '') {
      throw new CoordinatorError(
        'coordinator/invalid-arguments',
        'an enrollment secret must not be empty (clear it to close enrollment instead)',
        {},
      )
    }
    this.#registry.setEnrollment({ kind: 'shared-secret', token: trimmed })
    // The length is reported, the value never is.
    this.#logger.info('coordinator/enrollment-opened', { length: trimmed.length })
    if (trimmed.length < ENROLLMENT_SECRET_WARN_LENGTH) {
      this.#logger.warn('coordinator/enrollment-secret-short', {
        length: trimmed.length,
        hint: `anyone who can reach this port and guess this secret can enroll a machine as a node; ${ENROLLMENT_SECRET_WARN_LENGTH}+ random characters is the production answer`,
      })
    }
  }

  /**
   * Queue a save of the current state, if persistence is configured.
   *
   * **Serialised, and coalesced.** Every state change calls this — a node enrolling,
   * a token rotating, the secret being set — and those arrive in bursts. Two saves
   * in flight at once is how a state file gets torn, so saves run one at a time;
   * and because a queued save reads the registry *when it runs*, a burst collapses
   * into the single write that matters instead of one write per change.
   *
   * Deliberately not awaited by its callers: a save is a side effect of a state
   * change, and making a handshake wait on a disk write would trade a real latency
   * cost for no correctness gain.
   */
  #persist(): void {
    const file = this.#options.stateFile
    if (file === undefined) return
    if (this.#persistQueued) return
    this.#persistQueued = true
    this.#persistChain = this.#persistChain.then(async () => {
      // Cleared before the write, not after: a change arriving mid-write must be
      // able to queue a follow-up, or it would be lost to a snapshot that had
      // already been taken.
      this.#persistQueued = false
      try {
        await writeStateFile(file, {
          ...(this.#apiToken === undefined ? {} : { apiToken: this.#apiToken }),
          nodes: this.#registry.records(),
          enrollment: this.#registry.enrollmentPolicy,
        })
      } catch (error) {
        // A failed save must not take the service down, but it must not be silent
        // either: an operator who thinks a secret is persisted when it is not will
        // discover it after a restart, at the worst possible moment.
        this.#logger.error('coordinator/state-save-failed', {
          file,
          message: (error as Error).message,
        })
      }
    })
  }

  /** Wait for every queued save to finish. Used by `stop()` and by tests. */
  async flushState(): Promise<void> {
    await this.#persistChain
  }

  /** Load the persisted state, if there is one, before the listener opens. */
  async #restore(): Promise<void> {
    const file = this.#options.stateFile
    if (file === undefined) return
    const read = await readStateFile(file)
    if (read.error !== undefined) {
      this.#logger.warn('coordinator/state-unreadable', { file, reason: read.error })
      return
    }
    if (read.state === undefined) {
      this.#logger.info('coordinator/state-absent', { file, hint: 'a new state file will be written on the first change' })
      if (this.#apiToken !== undefined) {
        this.#persist()
        await this.flushState()
      }
      return
    }

    const storedApiToken = read.state.apiToken
    const tokenWasOverridden = this.#apiToken !== undefined && storedApiToken !== this.#apiToken
    if (this.#apiToken === undefined && storedApiToken !== undefined) this.#apiToken = storedApiToken

    for (const record of read.state.nodes) {
      // The CLI is the bootstrap: a record given at launch is the operator saying
      // "this is what I mean right now", so a stored record does not overwrite it.
      if (this.#registry.record(record.nodeId) === undefined) this.#registry.addRecord(record)
    }
    // Same rule for the enrollment rule, with one addition: a secret passed on the
    // command line deliberately wins *and replaces* the stored one, so `--enroll-token`
    // stays a usable reset rather than a value that silently disagrees with the file.
    if (read.state.enrollment !== undefined && this.#options.enrollmentFromCli !== true) {
      this.#registry.setEnrollment(read.state.enrollment)
    }
    this.#logger.info('coordinator/state-loaded', { file, ...describeState(read.state) })
    if ((this.#options.enrollmentFromCli === true && read.state.enrollment !== undefined) || tokenWasOverridden) {
      this.#persist()
      await this.flushState()
    }
  }

  /**
   * Start listening.
   *
   * Idempotent: concurrent or repeated calls share one promise, so a caller
   * cannot end up with two listeners on the same port.
   * @returns the bound address.
   * @throws CoordinatorError `coordinator/internal` when the port is unusable.
   */
  start(): Promise<CoordinatorAddress> {
    if (this.#address !== undefined) return Promise.resolve(this.#address)
    if (this.#starting !== undefined) return this.#starting
    this.#starting = this.#listen()
    return this.#starting
  }

  /**
   * Restore persisted state, then bind.
   *
   * In that order, and not lazily on the first change: a node that dials in
   * between the listener opening and the restore finishing would be judged
   * against an empty allowlist, and a legitimate node would be refused for a
   * reason that has nothing to do with it.
   */
  async #listen(): Promise<CoordinatorAddress> {
    await this.#restore()
    return await new Promise<CoordinatorAddress>((resolve, reject) => {
      const httpServer = createServer((request, response) => {
        if (this.#api === undefined) {
          response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: { code: 'coordinator/invalid-arguments', message: 'the operator API is not installed', details: {} } }))
          return
        }
        this.#api.handle(request, response)
      })
      this.#httpServer = httpServer

      /*
        The operator API is always installed; who may reach it is the separate
        question, answered inside the handler.

        It used to be all-or-nothing: a wildcard bind with no token did not install
        the API at all. That forced an operator who wanted other machines to join as
        *nodes* to also expose *administration*, because the only other option was a
        second credential to protect it. Those are different privileges, and the
        fence in `http-api.ts` keeps them apart — a wildcard bind now invites nodes
        without inviting administrators.
      */
      const apiEnabled = this.#options.enableApi ?? true
      this.#api = createHttpApi(this, {
        enabled: apiEnabled,
        // The page only knows how to talk about sessions, so a service told not to
        // know about them should not serve it.
        ui: this.#options.enableUi && this.#options.sessions.enabled,
        getToken: () => this.#apiToken,
        setToken: token => { this.setOperatorToken(token) },
        ...(this.#options.maxBodyBytes === undefined ? {} : { maxBodyBytes: this.#options.maxBodyBytes }),
        onRequest: info => { this.#logger.debug('coordinator/api-request', info) },
      })
      if (!apiEnabled) {
        this.#logger.warn('coordinator/api-disabled', { reason: 'disabled by configuration' })
      } else if (
        !allowsRemoteApi({ ...(this.#apiToken === undefined ? {} : { token: this.#apiToken }) }) &&
        !isLoopback(this.#options.host)
      ) {
        // Said once, at startup, because the symptom of getting this wrong is a
        // 403 from another machine that looks like a firewall problem.
        this.#logger.info('coordinator/api-fenced', {
          host: this.#options.host,
          hint: 'the operator API answers only this machine; pass --api-token to allow remote administration',
        })
      }

      const server = new WebSocketServer({
        server: httpServer,
        path: this.#options.path,
        // A second line of defence above the codec: `ws` refuses an oversized
        // frame before this service ever parses it.
        maxPayload: this.#options.maxFrameBytes,
        perMessageDeflate: false,
      })
      this.#server = server

      const onError = (error: Error): void => {
        this.#starting = undefined
        httpServer.removeListener('listening', onListening)
        reject(new CoordinatorError('coordinator/internal', `the listener failed: ${error.message}`, {
          host: this.#options.host,
          port: this.#options.port,
        }))
      }
      const onListening = (): void => {
        httpServer.removeListener('error', onError)
        const bound = httpServer.address()
        const port = typeof bound === 'object' && bound !== null ? bound.port : this.#options.port
        const address: CoordinatorAddress = {
          host: this.#options.host,
          port,
          path: this.#options.path,
          url: `ws://${formatHost(this.#options.host)}:${port}${this.#options.path}`,
        }
        this.#address = address
        this.#logger.info('coordinator/listening', {
          url: address.url,
          api: apiEnabled ? `http://${formatHost(this.#options.host)}:${port}/api` : 'disabled',
        })
        // A later socket error must not crash the process.
        httpServer.on('error', (error: Error) => {
          this.#logger.error('coordinator/listener-error', { message: error.message })
        })
        resolve(address)
      }

      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      server.on('connection', (socket: WebSocket) => { this.#onConnection(socket) })
      httpServer.listen({ host: this.#options.host, port: this.#options.port })
    })
  }

  /**
   * Stop listening and disconnect every node.
   *
   * Nodes are told `reconnect: true` on the way out: a Coordinator restart is
   * routine, and a node that gives up permanently because its peer restarted
   * would need a human every time.
   */
  async stop(): Promise<void> {
    // A queued save that never ran is a secret the operator thinks is persisted.
    // Flushing first also means no write can start after the listeners are gone.
    await this.flushState()
    const server = this.#server
    const httpServer = this.#httpServer
    this.#server = undefined
    this.#httpServer = undefined
    for (const session of this.#sessions.values()) {
      session.close('coordinator/shutdown', 'the Coordinator is shutting down', { reconnect: true })
    }
    if (server === undefined || httpServer === undefined) {
      this.#address = undefined
      this.#starting = undefined
      return
    }

    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      // Force the stragglers closed: both `ws.close()` and `http.close()` wait for
      // every client, and a half-open node would otherwise hold the process open.
      const watchdog = this.#timers.setTimeout(() => {
        for (const client of server.clients) {
          try {
            client.terminate()
          } catch {
            // Already gone.
          }
        }
        httpServer.closeAllConnections?.()
        finish()
      }, this.#options.shutdownGraceMs)
      server.close(() => {
        httpServer.close(() => {
          watchdog.cancel()
          finish()
        })
      })
    })

    this.#address = undefined
    this.#starting = undefined
    this.#api = undefined
    this.#logger.info('coordinator/stopped', { nodes: this.#registry.list().length })
  }

  // ---------------------------------------------------------------- node API

  /** Every registered node with its connection state. Never includes a token. */
  listNodes(): NodeView[] {
    return this.#registry.list()
  }

  /** One node's view. */
  node(nodeId: string): NodeView | undefined {
    return this.#registry.view(nodeId)
  }

  /** The capability surface a node advertised on its current connection. */
  capabilitiesOf(nodeId: string): NodeCapabilitySummary | undefined {
    return this.#registry.capabilitiesOf(nodeId)
  }

  /** Approve a node, or replace its record. */
  addNode(record: NodeRecord): NodeView {
    this.#registry.addRecord(record)
    return this.#requireView(record.nodeId)
  }

  /** Replace a node's token. */
  rotateNodeToken(nodeId: string, token: string): NodeView {
    this.#registry.rotateToken(nodeId, token)
    return this.#requireView(nodeId)
  }

  /** Re-approve a revoked node. */
  restoreNode(nodeId: string): NodeView {
    this.#registry.restore(nodeId)
    return this.#requireView(nodeId)
  }

  /**
   * Refuse a node and drop its live connection.
   *
   * The node is told `node/auth-failed`, so it takes its slow, bounded credential
   * path instead of hammering this service.
   * @param nodeId - the node to revoke.
   * @returns the revoked node's view.
   */
  revokeNode(nodeId: string): NodeView {
    this.#registry.revoke(nodeId)
    this.sessionOf(nodeId)?.close('node/auth-failed', 'the node was revoked by an operator', {
      reconnect: false,
      wsCode: WS_UNAUTHORIZED,
    })
    return this.#requireView(nodeId)
  }

  // ---------------------------------------------------------------- calls

  /**
   * Call one unary Remote on a node.
   * @param nodeId - the node to call.
   * @param endpoint - canonical `<namespace>/<method>`.
   * @param args - named arguments object.
   * @param options - deadline and abort signal.
   * @returns the Remote's value.
   * @throws CoordinatorError: this service's codes, or the node's own, preserved.
   */
  invoke(
    nodeId: string,
    endpoint: string,
    args: Readonly<Record<string, unknown>> = {},
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return this.#requireSession(nodeId).invoke(endpoint, args, options)
  }

  /**
   * Open one stream Remote on a node.
   * @param nodeId - the node to call.
   * @param endpoint - canonical `<namespace>/<method>`.
   * @param args - named arguments object.
   * @param options - idle deadline, buffer ceiling, abort signal.
   * @returns the stream handle.
   */
  openStream(
    nodeId: string,
    endpoint: string,
    args: Readonly<Record<string, unknown>> = {},
    options: {
      readonly timeoutMs?: number
      readonly maxBufferedValues?: number
      readonly signal?: AbortSignal
      readonly requestId?: string
    } = {},
  ): RemoteStream {
    return this.#requireSession(nodeId).openStream(endpoint, args, options)
  }

  /** Cancel one stream on a node. */
  cancelStream(nodeId: string, streamId: string, reason = 'the consumer stopped reading'): void {
    this.#requireSession(nodeId).cancelStream(streamId, reason)
  }

  // ------------------------------------------------------- read-only views

  /**
   * List a node's sessions.
   *
   * Read-only by construction: it forwards one unary call and returns whatever the
   * node answered, without interpreting a single field.
   * @param nodeId - the node to ask.
   * @param request - the Remote's own request object, passed through verbatim.
   * @returns the node's answer.
   * @throws CoordinatorError `coordinator/invalid-arguments` when the session routes
   * are disabled or the request is not a plain object, plus whatever the call raises.
   */
  listSessions(nodeId: string, request?: unknown): Promise<unknown> {
    return this.#callView('listEndpoint', 'listRequestArgument', nodeId, request)
  }

  /**
   * Read one page of a session.
   *
   * Its wrapper argument is **not** the list's: `session/list` takes `_request` and
   * `session/page` takes `request`. Sharing one name is what made this route fail on
   * a real node while every unit test passed.
   * @param nodeId - the node to ask.
   * @param request - the Remote's own request object (the session id lives here).
   * @returns the node's answer.
   */
  pageSessions(nodeId: string, request?: unknown): Promise<unknown> {
    return this.#callView('pageEndpoint', 'pageRequestArgument', nodeId, request)
  }

  /**
   * Create a session on a node.
   * @param nodeId - the node to ask.
   * @param input - working directory, preset, or a verbatim request object.
   * @returns the node's answer, which carries the new `sessionId`.
   * @throws CoordinatorError `coordinator/invalid-arguments` on an unusable input.
   */
  createSession(nodeId: string, input: CreateSessionInput = {}): Promise<unknown> {
    return this.#callSession('createEndpoint', nodeId, buildCreateRequest(input))
  }

  /**
   * Send a message to a session.
   *
   * This one mutates: the node will really run a turn. It is deliberately not
   * hidden behind a "test" flag — the caller is the one who knows whether the node
   * it is talking to is disposable.
   * @param nodeId - the node to ask.
   * @param input - the message, or a verbatim request object.
   * @returns the node's answer.
   */
  promptSession(nodeId: string, input: PromptSessionInput): Promise<unknown> {
    const request = buildPromptRequest(input, {
      defaultMode: this.#options.sessions.promptMode,
      generateRequestId: () => this.#nextRequestId('p'),
    })
    return this.#callSession('promptEndpoint', nodeId, request)
  }

  /**
   * Follow a session's events.
   *
   * The returned stream carries a `snapshot` frame with the history first, then one
   * `event` frame per change — so a caller can render a transcript and then keep it
   * live without a second call.
   * @param nodeId - the node to ask.
   * @param input - which session, and how much history.
   * @param options - idle deadline, buffer ceiling, abort signal.
   * @returns the stream handle. Consume it with `for await`.
   */
  followSession(
    nodeId: string,
    input: FollowSessionInput = {},
    options: { readonly timeoutMs?: number; readonly maxBufferedValues?: number; readonly signal?: AbortSignal } = {},
  ): RemoteStream {
    const settings = this.#options.sessions
    this.#requireSessions()
    // Fail before opening a stream the node cannot serve; the node stays the
    // authority for everything else.
    this.#requireSession(nodeId)
    const timeoutMs = options.timeoutMs ?? settings.followIdleTimeoutMs
    const maxBufferedValues = options.maxBufferedValues ?? settings.followMaxBufferedValues
    return this.openStream(nodeId, settings.followEndpoint, { [settings.requestArgument]: buildFollowRequest(input) }, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxBufferedValues === undefined ? {} : { maxBufferedValues }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  /** Whether the session routes are installed. */
  get sessionsEnabled(): boolean {
    return this.#options.sessions.enabled
  }

  /** How the session Remotes are named and wrapped. */
  get sessionsOptions(): ResolvedSessionsOptions {
    return this.#options.sessions
  }

  /** Forward one read-only view call, wrapping under that view's own argument. */
  async #callView(
    endpointField: 'listEndpoint' | 'pageEndpoint',
    argumentField: 'listRequestArgument' | 'pageRequestArgument',
    nodeId: string,
    request: unknown,
  ): Promise<unknown> {
    this.#requireSessions()
    return this.#callSession(endpointField, nodeId, normaliseViewRequest(request), argumentField)
  }

  /** Forward one session call whose request object is already built. */
  async #callSession(
    endpointField: 'listEndpoint' | 'pageEndpoint' | 'createEndpoint' | 'promptEndpoint',
    nodeId: string,
    request: Readonly<Record<string, unknown>>,
    argumentField: 'requestArgument' | 'listRequestArgument' | 'pageRequestArgument' = 'requestArgument',
  ): Promise<unknown> {
    this.#requireSessions()
    // Fail before a frame is sent when the node cannot serve the call at all; the
    // node stays the authority for everything else.
    this.#requireSession(nodeId)
    return this.invoke(nodeId, this.#options.sessions[endpointField], {
      [this.#options.sessions[argumentField]]: request,
    })
  }

  /** Refuse a session call when the routes were turned off at construction. */
  #requireSessions(): void {
    if (!this.#options.sessions.enabled) {
      throw new CoordinatorError('coordinator/invalid-arguments', 'the session routes are disabled', {})
    }
  }

  /**
   * Mint a prompt correlation id.
   *
   * `session/prompt` requires one, and a caller who only wants to send a line of
   * text should not have to invent a unique value — making it optional in the API
   * and required on the wire is this service's job.
   */
  #nextRequestId(prefix: string): string {
    this.#promptSeq += 1
    return `${prefix}-${this.#promptSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /** The live session serving a node, if it has one. */
  sessionOf(nodeId: string): NodeSession | undefined {
    const key = this.#byNode.get(nodeId)
    return key === undefined ? undefined : this.#sessions.get(key)
  }

  /** Every live session, oldest first. */
  sessions(): NodeSession[] {
    return [...this.#sessions.values()]
  }

  /** Service health without credentials. */
  stats(): CoordinatorStats {
    const nodes = this.#registry.list()
    let inFlightRequests = 0
    let activeStreams = 0
    for (const session of this.#sessions.values()) {
      inFlightRequests += session.inFlightRequests
      activeStreams += session.activeStreams
    }
    return {
      listening: this.#address !== undefined,
      ...(this.#address === undefined ? {} : { url: this.#address.url }),
      nodes: nodes.length,
      ready: nodes.filter(node => node.state === 'ready').length,
      revoked: nodes.filter(node => node.revoked).length,
      sessions: this.#sessions.size,
      inFlightRequests,
      activeStreams,
    }
  }

  // ---------------------------------------------------------------- internals

  /** Accept one node socket and hand it to a session. */
  #onConnection(socket: WebSocket): void {
    this.#sessionSeq += 1
    const key = `c${this.#sessionSeq}`
    const session = new NodeSession({
      sessionKey: key,
      socket: fromWebSocket(socket),
      registry: this.#registry,
      handshakeTimeoutMs: this.#options.handshakeTimeoutMs,
      heartbeatIntervalMs: this.#options.heartbeatIntervalMs,
      maxFrameBytes: this.#options.maxFrameBytes,
      maxInFlightRequests: this.#options.maxInFlightRequests,
      maxStreams: this.#options.maxStreams,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      streamIdleTimeoutMs: this.#options.streamIdleTimeoutMs,
      maxBufferedValues: this.#options.maxBufferedValues,
      timers: this.#timers,
      logger: this.#logger,
      onEvent: (event) => { this.#handleSessionEvent(key, event) },
    })
    this.#sessions.set(key, session)
    this.#logger.debug('coordinator/socket-accepted', { sessionKey: key })
  }

  /** Track sessions and enforce the one-connection-per-node rule. */
  #handleSessionEvent(key: string, event: SessionEvent): void {
    if (event.type === 'ready') {
      this.#byConnection.set(event.connectionId, key)
      const previous = this.#byNode.get(event.nodeId)
      this.#byNode.set(event.nodeId, key)
      if (previous !== undefined && previous !== key) {
        // Two live connections for one node would make every call's target
        // ambiguous, so the older one is closed on purpose (spec §3.2).
        this.#logger.warn('coordinator/duplicate-connection-closed', {
          nodeId: event.nodeId,
          sessionKey: previous,
        })
        this.#sessions.get(previous)?.close('node/protocol-invalid', 'a newer connection replaced this one', {
          reconnect: false,
        })
      }
    } else if (event.type === 'closed') {
      this.#forgetSession(key, event.nodeId)
    }
    try {
      this.#onEvent?.(event)
    } catch (error) {
      // An observer must never be able to break the connection it observes.
      this.#logger.error('coordinator/observer-failed', { message: (error as Error).message })
    }
  }

  /** Drop a session's bookkeeping once it closed. */
  #forgetSession(key: string, nodeId: string | undefined): void {
    const session = this.#sessions.get(key)
    const connectionId = session?.connectionId
    if (connectionId !== undefined) this.#byConnection.delete(connectionId)
    if (nodeId !== undefined && this.#byNode.get(nodeId) === key) this.#byNode.delete(nodeId)
    this.#sessions.delete(key)
  }

  #requireSession(nodeId: string): NodeSession {
    if (this.#registry.record(nodeId) === undefined) {
      throw new CoordinatorError('coordinator/node-unknown', `no node "${nodeId}" is registered`, { nodeId })
    }
    const session = this.sessionOf(nodeId)
    if (session === undefined || session.state !== 'ready') {
      throw new CoordinatorError('coordinator/node-offline', `node "${nodeId}" has no ready connection`, {
        nodeId,
        state: session?.state ?? 'offline',
      })
    }
    return session
  }

  #requireView(nodeId: string): NodeView {
    const view = this.#registry.view(nodeId)
    if (view === undefined) {
      throw new CoordinatorError('coordinator/node-unknown', `no node "${nodeId}" is registered`, { nodeId })
    }
    return view
  }
}

/** The close code in the private-use range that means "credentials refused". */
export const WS_UNAUTHORIZED = 4401

/** Options resolution, with every value bounded: this service's limits are its safety. */
function resolveOptions(options: CoordinatorOptions): ResolvedOptions {
  const host = options.host ?? DEFAULT_HOST
  const allowInsecureBind = options.allowInsecureBind ?? false
  if (!allowInsecureBind && !isLoopback(host)) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      `refusing to bind "${host}": a node token grants full access to that machine, so a non-loopback bind needs TLS behind a proxy (pass allowInsecureBind to override)`,
      { host },
    )
  }
  const path = options.path ?? DEFAULT_PATH
  if (!path.startsWith('/')) {
    throw new CoordinatorError('coordinator/invalid-arguments', `the upgrade path must start with "/": "${path}"`, {
      path,
    })
  }
  return {
    port: bound(options.port, DEFAULT_PORT, 0, 65_535),
    host,
    path,
    allowInsecureBind,
    handshakeTimeoutMs: bound(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 1, 600_000),
    heartbeatIntervalMs: bound(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS, 10, 600_000),
    maxFrameBytes: bound(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 1_024, 64 * 1024 * 1024),
    maxInFlightRequests: bound(options.maxInFlightRequests, DEFAULT_MAX_IN_FLIGHT_REQUESTS, 1, 10_000),
    maxStreams: bound(options.maxStreams, DEFAULT_MAX_STREAMS, 1, 10_000),
    requestTimeoutMs: bound(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1, 24 * 60 * 60 * 1000),
    streamIdleTimeoutMs: bound(options.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS, 1, 24 * 60 * 60 * 1000),
    maxBufferedValues: bound(options.maxBufferedValues, DEFAULT_MAX_BUFFERED_VALUES, 1, 1_000_000),
    shutdownGraceMs: bound(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS, 1, 60_000),
    apiToken: options.apiToken === '' ? undefined : options.apiToken,
    enableApi: options.enableApi ?? true,
    enableUi: options.enableUi ?? true,
    maxBodyBytes: bound(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1_024, 64 * 1024 * 1024),
    stateFile: options.stateFile === undefined ? undefined : resolveStateFile(options.stateFile),
    enrollmentFromCli: options.enrollmentFromCli ?? false,
    sessions: resolveSessionsOptions(options.sessions),
  }
}

/** A view's request must be a plain object (or absent, which means "no filters"). */
function normaliseViewRequest(request: unknown): Readonly<Record<string, unknown>> {
  if (request === undefined || request === null) return {}
  if (typeof request !== 'object' || Array.isArray(request)) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      'a session view request must be a plain object',
      { received: Array.isArray(request) ? 'array' : typeof request },
    )
  }
  return request as Readonly<Record<string, unknown>>
}

function bound(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Whether an address stays inside this machine. */
export function isLoopback(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || normalized.startsWith('127.')
}

/**
 * Whether an address means "every interface".
 *
 * Worth telling apart from loopback because the two produce opposite problems from
 * the same symptom: a wildcard bind listens everywhere, yet the literal string
 * `0.0.0.0` is not an address any **other** machine can dial. Printing it as the
 * node URL hands an operator a configuration that cannot work, and the failure
 * looks like a firewall rather than a wrong address.
 * @param host - the configured bind address.
 * @returns true for `0.0.0.0`, `::`, and the empty host.
 */
export function isWildcardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === '' || normalized === '0.0.0.0' || normalized === '::' || normalized === '*'
}

/**
 * Render a host for a URL: a bare IPv6 literal has to be bracketed, and
 * `http://::1:39494/` is not a URL a terminal can paste anywhere.
 * @param host - the configured bind address.
 * @returns the host as it belongs in a URL.
 */
export function formatHost(host: string): string {
  const normalized = host.trim().replace(/^\[|\]$/g, '')
  return normalized.includes(':') ? `[${normalized}]` : normalized
}

/** Listener type for the socket adapter below. */
type AnyListener = (...args: never[]) => void

/**
 * Adapt a `ws` socket to the service's minimal socket surface.
 *
 * Explicit rather than structural: `ws` types its listeners with `RawData` and
 * `Buffer`, and relying on overload bivariance to accept them would make a
 * type-level change in `ws` show up as a wiring error here instead.
 * @param socket - the accepted `ws` socket.
 * @returns the narrow surface {@link NodeSession} needs.
 */
export function fromWebSocket(socket: WebSocket): CoordinatorSocket {
  return {
    get readyState(): number {
      return socket.readyState
    },
    send: (data: string) => { socket.send(data) },
    close: (code?: number, reason?: string) => { socket.close(code, reason) },
    terminate: () => { socket.terminate() },
    on: (event: 'message' | 'close' | 'error', listener: AnyListener): unknown => {
      if (event === 'message') {
        socket.on('message', (data) => { (listener as (data: RawFrameData) => void)(data as RawFrameData) })
      } else if (event === 'close') {
        socket.on('close', (code, reason: unknown) => {
          (listener as (code: number, reason: unknown) => void)(code, reason)
        })
      } else {
        socket.on('error', (error) => { (listener as (error: Error) => void)(error) })
      }
      return socket
    },
  }
}

/** Re-exported for embedders that build their own failure objects. */
export type { RemoteFailure }
