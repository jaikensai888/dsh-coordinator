/**
 * The operator API: JSON over the same loopback port the nodes use.
 *
 * Two audiences, one port, no crossover: nodes upgrade to WebSocket at
 * `/node`, operators speak JSON under `/api`. Keeping them together means there
 * is exactly one thing to bind, firewall, and shut down.
 *
 * Three deliberate properties:
 *
 * - **Failures are data.** A Remote that failed comes back as HTTP 200 with
 *   `{ok: false, error: {code, ...}}`. The node's own codes survive the trip
 *   (`session/not-found`, `node/backpressure`, …), because a caller that cannot
 *   tell "no such session" from "the node is overloaded" cannot decide what to do
 *   next. Only transport-level problems — unknown route, bad auth, oversized
 *   body — get a real HTTP status.
 * - **Nothing is echoed back that could be a credential.** A node's token is
 *   accepted on the way in (`/api/nodes/add`, `/api/nodes/rotate`) and never
 *   appears in any response, including error responses.
 * - **The surface is disabled unless it is protected.** Loopback-only counts as
 *   protected; a non-loopback bind without a bearer token does not, and the API
 *   is then not installed at all.
 *
 * @module dsh-coordinator/http-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { CoordinatorError, failureOf, type RemoteFailure } from './errors.js'
import { isPlainObject } from './frame-codec.js'
import { tokensMatch } from './node-registry.js'
import type { NodeCapabilitySummary, NodeRecord, NodeView } from './protocol.js'
import type { CreateSessionInput, FollowSessionInput, PromptSessionInput } from './sessions.js'
import type { RemoteStream } from './stream-hub.js'
import { isUiPath, readUiHtml } from './ui.js'

/** Default ceiling on a request body. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** The part of the service the HTTP API needs. Structural, so it stays testable. */
export interface HttpApiHost {
  /** Where the service is listening; used to decide whether a token is required. */
  readonly address: { readonly host: string } | undefined
  listNodes(): readonly NodeView[]
  node(nodeId: string): NodeView | undefined
  /** The capability surface from the node's last `ready`. */
  capabilitiesOf(nodeId: string): NodeCapabilitySummary | undefined
  stats(): unknown
  invoke(
    nodeId: string,
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<unknown>
  openStream(
    nodeId: string,
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly timeoutMs?: number; readonly maxBufferedValues?: number },
  ): RemoteStream
  cancelStream(nodeId: string, streamId: string, reason?: string): void
  /** Whether the session routes are installed. */
  readonly sessionsEnabled: boolean
  /**
   * Whether unknown nodes may enroll right now.
   *
   * A **fact**, never a value. There is deliberately no accessor that returns the
   * secret, so no route can leak one by forgetting to redact it.
   */
  readonly enrollmentOpen: boolean
  /** Where state is persisted, or undefined when it is not. */
  readonly stateFile: string | undefined
  /** Set or clear the enrollment secret. */
  setEnrollmentSecret(secret: string | null): void
  /** Read-only session list; the request object is the node's own. */
  listSessions(nodeId: string, request?: unknown): Promise<unknown>
  /** Read-only session page; the request object is the node's own. */
  pageSessions(nodeId: string, request?: unknown): Promise<unknown>
  /** Create a session on a node. */
  createSession(nodeId: string, input?: CreateSessionInput): Promise<unknown>
  /** Send a message to a session. This really runs a turn on the node. */
  promptSession(nodeId: string, input: PromptSessionInput): Promise<unknown>
  /** Follow a session's events as a stream. */
  followSession(
    nodeId: string,
    input?: FollowSessionInput,
    options?: { readonly timeoutMs?: number; readonly maxBufferedValues?: number },
  ): RemoteStream
  revokeNode(nodeId: string): NodeView
  restoreNode(nodeId: string): NodeView
  rotateNodeToken(nodeId: string, token: string): NodeView
  addNode(record: NodeRecord): NodeView
}

/** Options for {@link createHttpApi}. */
export interface HttpApiOptions {
  /** Bearer token required for every request when set. */
  readonly token?: string
  /** Whether the API is installed at all. Defaults to true. */
  readonly enabled?: boolean
  /** Serve the bundled UI page at `/ui`. Defaults to true. */
  readonly ui?: boolean
  /** Body ceiling. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number
  /** Diagnostics sink; never receives a request body or a credential. */
  readonly onRequest?: (info: { readonly method: string; readonly path: string; readonly status: number }) => void
}

/** An HTTP handler plus its own metadata. */
export interface HttpApi {
  /** Handle one request. Never throws. */
  handle(request: IncomingMessage, response: ServerResponse): void
  /** Whether a bearer token is required. */
  readonly requiresToken: boolean
}

/**
 * Whether a socket address is on this machine.
 *
 * Node reports an IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) when a dual-stack
 * listener accepts an IPv4 connection, so a naive `=== '127.0.0.1'` would treat a
 * local browser as remote and lock the operator out of their own UI.
 * @param address - `request.socket.remoteAddress`.
 * @returns true for any loopback form.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/u, '')
  return normalized === '::1' || normalized === 'localhost' || normalized.startsWith('127.')
}

/**
 * Whether the operator API should be reachable from other machines.
 *
 * The old rule was all-or-nothing: a non-loopback bind without a token did not
 * install the API at all. That conflated two decisions an operator makes
 * separately — "may other machines join as nodes" (a bind-address question) and
 * "may other machines administer this" (a much bigger one) — and the only way to
 * get the first was to accept the second.
 *
 * The rule now: the API is always installed and **fenced to this machine** unless
 * a bearer token exists to protect it. A wildcard bind therefore invites nodes
 * without inviting administrators, which is the shape most deployments want.
 * @param options - the configured bearer token, if any.
 * @returns whether non-loopback callers may use the API.
 */
export function allowsRemoteApi(options: { readonly token?: string | undefined }): boolean {
  return options.token !== undefined && options.token !== ''
}

/**
 * Build the operator API.
 * @param host - the service it drives.
 * @param options - token, size ceiling, and diagnostics hook.
 * @returns the handler.
 */
export function createHttpApi(host: HttpApiHost, options: HttpApiOptions = {}): HttpApi {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const token = options.token === '' ? undefined : options.token
  const enabled = options.enabled ?? true
  const ui = (options.ui ?? true) && enabled

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    void handleAsync(request, response).catch((error: unknown) => {
      // Last line of defence: a bug in a route must not kill the listener.
      sendJson(response, 500, { ok: false, error: failureOf(error) })
    })
  }

  const handleAsync = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname
    const finish = (status: number): void => {
      try {
        options.onRequest?.({ method, path, status })
      } catch {
        // Diagnostics must not affect the answer.
      }
    }

    if (!enabled) {
      sendJson(response, 404, { ok: false, error: notFound(path) })
      finish(404)
      return
    }
    /*
      Fence administration to this machine unless a token protects it.

      This is the counterpart to the `/node` endpoint staying open on every
      interface: joining as a node and administering the Coordinator are different
      privileges, and a wildcard bind should grant only the first. Without a token
      there is nothing to authenticate a remote administrator with, so the honest
      answer is to refuse rather than to serve them.

      **Before the page and before routing.** The page is part of administration —
      serving it to a remote caller would load a console whose every call fails,
      which reads as a broken service rather than a refused one. And checking before
      routing means a remote caller learns nothing about which routes exist; a 404
      per route would leak the surface a little at a time.
    */
    if (!allowsRemoteApi({ token }) && !isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, {
        ok: false,
        error: {
          code: 'coordinator/auth-rejected',
          message: 'the operator API answers only this machine; start the Coordinator with --api-token to administer it remotely',
          details: {},
        },
      })
      finish(403)
      return
    }
    // The page is served **before** the token check, and that is not an oversight:
    // a browser navigation cannot carry an `Authorization` header, so a gated page
    // would simply never load. The page contains no credential; every call it makes
    // back into `/api/*` still has to pass the check below, which is why it asks the
    // operator for the token as soon as one of those calls comes back 401. On a
    // loopback request there is no token to ask for, so it never has to.
    if (ui && method === 'GET' && isUiPath(path)) {
      try {
        const html = await readUiHtml()
        sendHtml(response, html)
        finish(200)
      } catch (error) {
        sendJson(response, 500, { ok: false, error: failureOf(error) })
        finish(500)
      }
      return
    }
    if (token !== undefined && !authorized(request, token)) {
      response.setHeader('www-authenticate', 'Bearer')
      sendJson(response, 401, {
        ok: false,
        error: { code: 'coordinator/auth-rejected', message: 'a bearer token is required', details: {} },
      })
      finish(401)
      return
    }
    if (token !== undefined && !authorized(request, token)) {
      response.setHeader('www-authenticate', 'Bearer')
      sendJson(response, 401, {
        ok: false,
        error: { code: 'coordinator/auth-rejected', message: 'a bearer token is required', details: {} },
      })
      finish(401)
      return
    }

    try {
      const status = await route(host, request, response, method, path, url, maxBodyBytes)
      finish(status)
    } catch (error) {
      const failure = failureOf(error)
      // A failure the **node** reported is data, not an HTTP-level error: the call
      // did reach the node, its own code is what the caller has to branch on, and
      // a 5xx would throw that code away. Only this service's own boundary
      // failures map onto a status.
      const status = failure.code.startsWith('coordinator/') ? statusFor(failure) : 200
      sendJson(response, status, { ok: false, error: failure })
      finish(status)
    }
  }

  return { handle, requiresToken: token !== undefined }
}

/** Route one request. Returns the HTTP status that was sent. */
async function route(
  host: HttpApiHost,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  url: URL,
  maxBodyBytes: number,
): Promise<number> {
  if (method === 'GET' && path === '/api/stats') {
    sendJson(response, 200, { ok: true, value: host.stats() })
    return 200
  }
  if (method === 'GET' && path === '/api/nodes') {
    sendJson(response, 200, { ok: true, value: host.listNodes() })
    return 200
  }
  if (method === 'GET' && path === '/api/node') {
    const nodeId = url.searchParams.get('nodeId') ?? ''
    const view = host.node(nodeId)
    if (view === undefined) throw unknownNode(nodeId)
    sendJson(response, 200, { ok: true, value: view })
    return 200
  }
  if (method === 'GET' && path === '/api/capabilities') {
    const nodeId = url.searchParams.get('nodeId') ?? ''
    const summary = host.capabilitiesOf(nodeId)
    if (summary === undefined) {
      throw new CoordinatorError('coordinator/node-offline', `node "${nodeId}" has not reported a capability surface`, {
        nodeId,
      })
    }
    sendJson(response, 200, { ok: true, value: summary })
    return 200
  }
  if (method === 'GET' && path === '/api/health') {
    sendJson(response, 200, { ok: true, value: { listening: host.address !== undefined } })
    return 200
  }

  // ------------------------------------------------------------ enrollment

  if (path === '/api/enrollment') {
    if (method === 'GET') {
      // `open` plus where it is remembered. Never the secret: a caller that could
      // read it back could not tell a legitimate operator from anyone else who
      // reached this port.
      sendJson(response, 200, {
        ok: true,
        value: {
          open: host.enrollmentOpen,
          persisted: host.stateFile !== undefined,
          ...(host.stateFile === undefined ? {} : { stateFile: host.stateFile }),
        },
      })
      return 200
    }
    if (method !== 'POST') {
      sendJson(response, 405, {
        ok: false,
        error: { code: 'coordinator/invalid-arguments', message: `${path} accepts GET or POST`, details: { path } },
      })
      return 405
    }
    const body = await readJsonBody(request, maxBodyBytes)
    const raw = body['token']
    if (raw !== null && (typeof raw !== 'string' || raw.trim() === '')) {
      throw new CoordinatorError(
        'coordinator/invalid-arguments',
        '"token" must be a non-empty string, or null to close enrollment',
        { field: 'token' },
      )
    }
    host.setEnrollmentSecret(raw as string | null)
    // Answer with the resulting state, not with what was sent.
    sendJson(response, 200, {
      ok: true,
      value: { open: host.enrollmentOpen, persisted: host.stateFile !== undefined },
    })
    return 200
  }

  // ------------------------------------------------------------- sessions

  if (path === '/api/sessions' || path === '/api/session/page') {
    if (!host.sessionsEnabled) {
      sendJson(response, 404, { ok: false, error: notFound(path) })
      return 404
    }
    const call = path === '/api/sessions'
      ? host.listSessions.bind(host)
      : host.pageSessions.bind(host)
    if (method === 'GET') {
      const nodeId = url.searchParams.get('nodeId') ?? ''
      const raw = url.searchParams.get('request')
      const value = await call(nodeId, parseViewRequest(raw))
      sendJson(response, 200, { ok: true, value })
      return 200
    }
    if (method === 'POST') {
      const body = await readJsonBody(request, maxBodyBytes)
      const value = await call(requireString(body, 'nodeId'), optionalObjectOrUndefined(body, 'request'))
      sendJson(response, 200, { ok: true, value })
      return 200
    }
    sendJson(response, 405, {
      ok: false,
      error: { code: 'coordinator/invalid-arguments', message: `${path} accepts GET or POST`, details: { path } },
    })
    return 405
  }

  if (path === '/api/session/create' || path === '/api/session/prompt' || path === '/api/session/follow') {
    if (!host.sessionsEnabled) {
      sendJson(response, 404, { ok: false, error: notFound(path) })
      return 404
    }
    if (method !== 'POST') {
      sendJson(response, 405, {
        ok: false,
        error: { code: 'coordinator/invalid-arguments', message: `${path} only accepts POST`, details: { path } },
      })
      return 405
    }
    const body = await readJsonBody(request, maxBodyBytes)
    const nodeId = requireString(body, 'nodeId')

    if (path === '/api/session/create') {
      sendJson(response, 200, { ok: true, value: await host.createSession(nodeId, createInput(body)) })
      return 200
    }
    if (path === '/api/session/prompt') {
      sendJson(response, 200, { ok: true, value: await host.promptSession(nodeId, promptInput(body)) })
      return 200
    }
    const timeoutMs = optionalNumber(body, 'timeoutMs')
    const maxBufferedValues = optionalNumber(body, 'maxBufferedValues')
    const stream = host.followSession(nodeId, followInput(body), {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxBufferedValues === undefined ? {} : { maxBufferedValues }),
    })
    return await streamToClient(host, nodeId, stream, response)
  }

  if (path.startsWith('/api/') && method !== 'POST') {
    sendJson(response, 405, {
      ok: false,
      error: { code: 'coordinator/invalid-arguments', message: `${path} only accepts POST`, details: { path } },
    })
    return 405
  }

  if (method === 'POST' && path === '/api/invoke') {
    const body = await readJsonBody(request, maxBodyBytes)
    const nodeId = requireString(body, 'nodeId')
    const endpoint = requireString(body, 'endpoint')
    const args = optionalObject(body, 'args')
    const timeoutMs = optionalNumber(body, 'timeoutMs')
    const value = await host.invoke(nodeId, endpoint, args, timeoutMs === undefined ? {} : { timeoutMs })
    sendJson(response, 200, { ok: true, value })
    return 200
  }

  if (method === 'POST' && path === '/api/stream') {
    const body = await readJsonBody(request, maxBodyBytes)
    const nodeId = requireString(body, 'nodeId')
    const endpoint = requireString(body, 'endpoint')
    const args = optionalObject(body, 'args')
    const timeoutMs = optionalNumber(body, 'timeoutMs')
    const maxBufferedValues = optionalNumber(body, 'maxBufferedValues')
    const stream = host.openStream(nodeId, endpoint, args, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxBufferedValues === undefined ? {} : { maxBufferedValues }),
    })
    return await streamToClient(host, nodeId, stream, response)
  }

  if (method === 'POST' && path === '/api/nodes/add') {
    const body = await readJsonBody(request, maxBodyBytes)
    const record: NodeRecord = {
      nodeId: requireString(body, 'nodeId'),
      token: requireString(body, 'token'),
      ...(optionalString(body, 'nodeName') === undefined ? {} : { nodeName: optionalString(body, 'nodeName') as string }),
      ...(optionalString(body, 'role') === undefined ? {} : { role: optionalString(body, 'role') as string }),
    }
    sendJson(response, 200, { ok: true, value: host.addNode(record) })
    return 200
  }

  if (method === 'POST' && path === '/api/nodes/rotate') {
    const body = await readJsonBody(request, maxBodyBytes)
    const view = host.rotateNodeToken(requireString(body, 'nodeId'), requireString(body, 'token'))
    sendJson(response, 200, { ok: true, value: view })
    return 200
  }

  if (method === 'POST' && path === '/api/nodes/revoke') {
    const body = await readJsonBody(request, maxBodyBytes)
    sendJson(response, 200, { ok: true, value: host.revokeNode(requireString(body, 'nodeId')) })
    return 200
  }

  if (method === 'POST' && path === '/api/nodes/restore') {
    const body = await readJsonBody(request, maxBodyBytes)
    sendJson(response, 200, { ok: true, value: host.restoreNode(requireString(body, 'nodeId')) })
    return 200
  }

  if (method === 'POST' && path === '/api/streams/cancel') {
    const body = await readJsonBody(request, maxBodyBytes)
    host.cancelStream(
      requireString(body, 'nodeId'),
      requireString(body, 'streamId'),
      optionalString(body, 'reason') ?? 'cancelled by an operator',
    )
    sendJson(response, 200, { ok: true, value: { cancelled: true } })
    return 200
  }

  sendJson(response, 404, { ok: false, error: notFound(path) })
  return 404
}

/**
 * Stream values to the client as newline-delimited JSON.
 *
 * Streaming rather than buffering is the point: a stream Remote that yields for
 * minutes must not have to finish before the caller sees its first value, and a
 * caller must be able to stop reading without leaving the node producing.
 * @returns the HTTP status that was sent.
 */
async function streamToClient(
  host: HttpApiHost,
  nodeId: string,
  stream: RemoteStream,
  response: ServerResponse,
): Promise<number> {
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  })

  let clientGone = false
  response.on('close', () => {
    if (response.writableEnded) return
    clientGone = true
    // The consumer left; stop the node producing into a socket nobody reads.
    host.cancelStream(nodeId, stream.streamId, 'the HTTP client disconnected')
  })

  const write = (chunk: unknown): boolean => {
    if (clientGone || response.writableEnded) return false
    try {
      response.write(`${JSON.stringify(chunk)}\n`)
      return true
    } catch {
      clientGone = true
      return false
    }
  }

  write({ type: 'open', streamId: stream.streamId, endpoint: stream.endpoint })
  try {
    for await (const value of stream) {
      if (!write({ type: 'data', value })) break
    }
    write({ type: 'end', count: stream.count })
  } catch (error) {
    // A stream failure is reported inside the NDJSON body: the status line is
    // already sent, and a mid-stream failure is not an HTTP-level failure.
    write({ type: 'error', error: failureOf(error), count: stream.count })
  }
  if (!response.writableEnded) response.end()
  return 200
}

/** Read and parse a JSON body, refusing anything oversized or not an object. */
export async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maxBodyBytes) {
      throw new CoordinatorError('coordinator/frame-too-large', `the request body exceeds ${maxBodyBytes} bytes`, {
        maxBodyBytes,
      })
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CoordinatorError('coordinator/invalid-arguments', 'the request body is not valid JSON', {})
  }
  if (!isPlainObject(parsed)) {
    throw new CoordinatorError('coordinator/invalid-arguments', 'the request body must be a JSON object', {})
  }
  return parsed
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (match === null) return false
  return tokensMatch(token, (match[1] as string).trim())
}

/** Map a failure onto an HTTP status. */
function statusFor(failure: RemoteFailure): number {
  switch (failure.code) {
    case 'coordinator/invalid-arguments':
    case 'coordinator/protocol-invalid':
      return 400
    case 'coordinator/auth-rejected':
      return 401
    case 'coordinator/node-unknown':
      return 404
    case 'coordinator/node-offline':
    case 'coordinator/capability-mismatch':
      return 409
    case 'coordinator/frame-too-large':
      return 413
    case 'coordinator/request-timeout':
      return 504
    case 'coordinator/stream-limit':
    case 'coordinator/request-limit':
      return 429
    default:
      return 502
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text, 'utf8'),
    'cache-control': 'no-store',
  })
  response.end(text)
}

function sendHtml(response: ServerResponse, html: string): void {
  if (response.writableEnded) return
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html, 'utf8'),
    // The page is an operator console, not a document: it should never be served
    // from a cache while the service it drives has moved on.
    'cache-control': 'no-store',
  })
  response.end(html)
}

/**
 * Read the create-session fields.
 *
 * Written with local variables rather than repeated reads of the body: the body is
 * `unknown`-valued, so every access needs its own narrowing, and calling the same
 * reader twice per field is how a "present" check and a value end up disagreeing.
 */
function createInput(body: Record<string, unknown>): CreateSessionInput {
  const cwd = optionalString(body, 'cwd')
  const workspaceId = optionalString(body, 'workspaceId')
  const sessionId = optionalString(body, 'sessionId')
  const agentPreset = optionalString(body, 'agentPreset')
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(body['request'] === undefined ? {} : { request: optionalObject(body, 'request') }),
  }
}

/** Read the prompt fields. `text` is the convenience; `content` bypasses it. */
function promptInput(body: Record<string, unknown>): PromptSessionInput {
  const content = body['content']
  if (content !== undefined && !Array.isArray(content)) {
    throw new CoordinatorError('coordinator/invalid-arguments', '"content" must be an array when present', {
      field: 'content',
    })
  }
  const sessionId = optionalString(body, 'sessionId')
  const text = optionalString(body, 'text')
  const mode = optionalString(body, 'mode')
  if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
    throw new CoordinatorError('coordinator/invalid-arguments', '"mode" must be "queue" or "steer"', {
      field: 'mode',
    })
  }
  const requestId = optionalString(body, 'requestId')
  const clientTimeZone = optionalString(body, 'clientTimeZone')
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(text === undefined ? {} : { text }),
    ...(content === undefined ? {} : { content: content as readonly unknown[] }),
    ...(mode === undefined ? {} : { mode }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    ...(body['request'] === undefined ? {} : { request: optionalObject(body, 'request') }),
  }
}

/** Read the follow fields. A pre-built `address` wins over `sessionId`. */
function followInput(body: Record<string, unknown>): FollowSessionInput {
  const maxMessages = optionalNumber(body, 'maxMessages')
  const assistantStream = body['assistantStream']
  if (assistantStream !== undefined && typeof assistantStream !== 'boolean') {
    throw new CoordinatorError('coordinator/invalid-arguments', '"assistantStream" must be a boolean', {
      field: 'assistantStream',
    })
  }
  const sessionId = optionalString(body, 'sessionId')
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(body['address'] === undefined ? {} : { address: optionalObject(body, 'address') }),
    ...(maxMessages === undefined ? {} : { maxMessages }),
    ...(assistantStream === undefined ? {} : { assistantStream }),
    ...(body['request'] === undefined ? {} : { request: optionalObject(body, 'request') }),
  }
}

function notFound(path: string): RemoteFailure {
  return { code: 'coordinator/invalid-arguments', message: `no route for ${path}`, details: { path } }
}

function unknownNode(nodeId: string): CoordinatorError {
  return new CoordinatorError('coordinator/node-unknown', `no node "${nodeId}" is registered`, { nodeId })
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value === '') {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" must be a non-empty string`, { field })
  }
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" must be a string when present`, { field })
  }
  return value
}

function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" must be a finite number when present`, {
      field,
    })
  }
  return value
}

function optionalObject(body: Record<string, unknown>, field: string): Readonly<Record<string, unknown>> {
  const value = body[field]
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" must be a plain object when present`, {
      field,
    })
  }
  return value
}

/** Like {@link optionalObject}, but absence is preserved as `undefined`. */
function optionalObjectOrUndefined(body: Record<string, unknown>, field: string): unknown {
  const value = body[field]
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" must be a plain object when present`, {
      field,
    })
  }
  return value
}

/** Parse an optional `?request=<json>` query parameter. */
function parseViewRequest(raw: string | null): unknown {
  if (raw === null || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new CoordinatorError('coordinator/invalid-arguments', `?request is not valid JSON: ${(error as Error).message}`, {})
  }
  if (!isPlainObject(parsed)) {
    throw new CoordinatorError('coordinator/invalid-arguments', '?request must be a JSON object', {})
  }
  return parsed
}
