/**
 * The operator API: JSON over the same port the nodes use.
 *
 * Two audiences, one port, no crossover: nodes upgrade to WebSocket at `/node`,
 * browsers use the console and its cookie, and machine clients use the operator
 * bearer token. Keeping them together means there is exactly one thing to bind,
 * firewall, and shut down.
 *
 * Three deliberate properties:
 *
 * - **Failures are data.** A Remote that failed comes back as HTTP 200 with
 *   `{ok: false, error: {code, ...}}`. The node's own codes survive the trip,
 *   because a caller that cannot tell "no such session" from "the node is
 *   overloaded" cannot decide what to do next. Only this service's own boundary
 *   failures and the auth layer get a real HTTP status.
 * - **Nothing is echoed back that could be a credential.** A node's token is
 *   accepted on the way in and never appears in a response.
 * - **Administration is never free.** There is no localhost exemption: a browser
 *   needs a session cookie, a machine needs the bearer token, and a request with
 *   neither gets a 401. The old "loopback means trusted" rule is gone, because the
 *   deployment is reachable from the LAN and loopback is not a property of the
 *   person using the browser.
 *
 * @module dsh-coordinator/http-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuthHttp } from './auth-http.js'
import { isAuthError, type AdminPrincipal } from './auth.js'
import { CoordinatorError, failureOf, type RemoteFailure } from './errors.js'
import { isPlainObject } from './frame-codec.js'
import { DEFAULT_MAX_BODY_BYTES, readJsonBody, redirect, sendAsset, sendHtml, sendJson } from './http-body.js'
import { tokensMatch } from './node-registry.js'
import type { NodeCapabilitySummary, NodeRecord, NodeView } from './protocol.js'
import type { CreateSessionInput, FollowSessionInput, PromptSessionInput } from './sessions.js'
import type { RemoteStream } from './stream-hub.js'
import { parseWindow, type RequestFilter, type UsageQueryParams, type UsageTimezone } from './usage/query.js'
import { isUiAssetPath, isUiPath, LOGIN_PATH, readLoginHtml, readUiAsset, readUiHtml } from './ui.js'

export { DEFAULT_MAX_BODY_BYTES, readJsonBody }

/** The part of the service the HTTP API needs. Structural, so it stays testable. */
export interface HttpApiHost {
  /** Where the service is listening. */
  readonly address: { readonly host: string } | undefined
  listNodes(): readonly NodeView[]
  node(nodeId: string): NodeView | undefined
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
  readonly sessionsEnabled: boolean
  readonly enrollmentOpen: boolean
  readonly stateFile: string | undefined
  setEnrollmentSecret(secret: string | null): void
  listSessions(nodeId: string, request?: unknown): Promise<unknown>
  pageSessions(nodeId: string, request?: unknown): Promise<unknown>
  createSession(nodeId: string, input?: CreateSessionInput): Promise<unknown>
  promptSession(nodeId: string, input: PromptSessionInput): Promise<unknown>
  followSession(
    nodeId: string,
    input?: FollowSessionInput,
    options?: { readonly timeoutMs?: number; readonly maxBufferedValues?: number },
  ): RemoteStream
  revokeNode(nodeId: string): NodeView
  restoreNode(nodeId: string): NodeView
  rotateNodeToken(nodeId: string, token: string): NodeView
  addNode(record: NodeRecord): NodeView
  /** Whether management state is on disk. */
  readonly persistenceEnabled?: boolean
  /** Usage reads, when the database is available. */
  readonly usage?: UsageApiHost | undefined
}

/** The usage read methods the API forwards to. */
export interface UsageApiHost {
  summary(params: UsageQueryParams): unknown
  nodesReport(
    params: UsageQueryParams,
    sort: 'knownTokens' | 'requestCount' | 'nodeName',
    order: 'asc' | 'desc',
    page: number,
    pageSize: number,
  ): unknown
  series(params: UsageQueryParams, grain: 'hour' | 'day'): unknown
  requests(filter: RequestFilter, limit: number, cursor: string | undefined): unknown
  status(nodeId: string | undefined): unknown
}

/** Options for {@link createHttpApi}. */
export interface HttpApiOptions {
  /** Bearer token required for machine clients when set. */
  readonly token?: string
  /** Read the bearer token at request time, for a token configured after startup. */
  readonly getToken?: () => string | undefined
  /** Set the bearer token. */
  readonly setToken?: (token: string) => void
  /** Whether the API is installed at all. Defaults to true. */
  readonly enabled?: boolean
  /** Serve the bundled console at `/ui`. Defaults to true. */
  readonly ui?: boolean
  /** Body ceiling. */
  readonly maxBodyBytes?: number
  /** Diagnostics sink; never receives a request body or a credential. */
  readonly onRequest?: (info: { readonly method: string; readonly path: string; readonly status: number }) => void
  /** Browser authentication. Absent only for an embedder with no database. */
  readonly auth?: AuthHttp
  /** Whether a persistent database backs this service. */
  readonly persistenceEnabled?: boolean
}

/** An HTTP handler plus its own metadata. */
export interface HttpApi {
  handle(request: IncomingMessage, response: ServerResponse): void
  readonly requiresToken: boolean
}

/**
 * Whether a socket address is on this machine.
 *
 * Kept because callers and tests use it for diagnostics, but no longer used to
 * grant access: the console reports it, the authorizer does not consult it.
 * @param address - `request.socket.remoteAddress`.
 * @returns true for any loopback form.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/u, '')
  return normalized === '::1' || normalized === 'localhost' || normalized.startsWith('127.')
}

/**
 * Whether the operator API has a machine credential at all.
 *
 * Retained for the startup banner. It no longer decides whether remote callers are
 * allowed: only a valid credential does.
 * @param options - the configured bearer token, if any.
 * @returns whether a token exists.
 */
export function allowsRemoteApi(options: { readonly token?: string | undefined }): boolean {
  return options.token !== undefined && options.token !== ''
}

/** Which human or machine is calling. */
type ResolvedPrincipal =
  | { readonly kind: 'admin'; readonly principal: AdminPrincipal }
  | { readonly kind: 'operator' }

/**
 * Build the operator API.
 * @param host - the service it drives.
 * @param options - auth, token, size ceiling, and diagnostics hook.
 * @returns the handler.
 */
export function createHttpApi(host: HttpApiHost, options: HttpApiOptions = {}): HttpApi {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const initialToken = options.token === '' ? undefined : options.token
  const getToken = options.getToken ?? (() => initialToken)
  const enabled = options.enabled ?? true
  const ui = (options.ui ?? true) && enabled
  const auth = options.auth

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    void handleAsync(request, response).catch((error: unknown) => {
      const failure = failureOf(error)
      sendJson(response, statusFor(failure), { ok: false, error: failure })
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

    // --- pages ------------------------------------------------------------
    if (method === 'GET' && path === '/') {
      const authenticated = auth?.session(request) !== undefined
      redirect(response, authenticated ? '/ui' : LOGIN_PATH)
      finish(303)
      return
    }
    if (ui && method === 'GET' && path === LOGIN_PATH) {
      if (auth === undefined) {
        /*
          No database means no place to keep an administrator.

          The contract is explicit that this mode must not invent an anonymous
          bootstrap just to make the page work: it says so instead and returns 503,
          which is the same answer `/api/auth/*` gives below.
        */
        response.writeHead(503, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
          + '<meta name="viewport" content="width=device-width, initial-scale=1">'
          + '<title>管理登录不可用 · DSH Coordinator</title>'
          + '<link rel="stylesheet" href="/ui/console.css"></head><body class="u-page">'
          + '<div class="u-login-wrap"><div class="u-login-card">'
          + '<h1>管理登录不可用</h1>'
          + '<p class="u-login-sub">当前 Coordinator 以 --no-state-file 运行。</p>'
          + '<div class="u-alert u-on u-info">管理登录需要持久化数据库：请用 --db-file 启动，'
          + '并在服务器上初始化管理员。此模式只保留显式 Bearer 的机器 API 与临时节点登记。</div>'
          + '</div></div></body></html>',
        )
        finish(503)
        return
      }
      if (auth.session(request) !== undefined) {
        redirect(response, '/ui')
        finish(303)
        return
      }
      await serveFile(response, path, finish)
      return
    }
    if (ui && method === 'GET' && (isUiPath(path) || isUiAssetPath(path))) {
      /*
        The console *page* is administration; its assets are not.

        The sign-in page needs the same stylesheet and the same usage script, and it
        is served anonymously — so gating the assets would mean either a flash of
        unstyled HTML or a second copy of the CSS. Both files are inert without a
        page and contain no data; the page itself still requires a session.
      */
      if (auth !== undefined && isUiPath(path) && auth.session(request) === undefined) {
        redirect(response, LOGIN_PATH)
        finish(303)
        return
      }
      await serveFile(response, path, finish)
      return
    }

    // --- health: anonymous, but says nothing worth knowing -------------------
    if (method === 'GET' && path === '/api/health') {
      sendJson(response, 200, { ok: true, value: { listening: host.address !== undefined } })
      finish(200)
      return
    }

    // --- auth routes --------------------------------------------------------
    if (auth === undefined && path.startsWith('/api/auth/')) {
      sendJson(response, 503, {
        ok: false,
        error: {
          code: 'coordinator/auth-uninitialized',
          message: 'management login needs a persistent database; start with --db-file and run admin init',
          details: {},
        },
      })
      finish(503)
      return
    }
    if (auth !== undefined && path.startsWith('/api/auth/')) {
      try {
        const handled = await auth.handle(request, response, method, path, maxBodyBytes)
        if (handled) finish(response.statusCode)
        return
      } catch (error) {
        const failure = failureOf(error)
        const status = statusFor(failure)
        if (isAuthError(error) && error.retryAfterSeconds !== undefined) {
          response.setHeader('retry-after', String(error.retryAfterSeconds))
        }
        if (status === 401) response.setHeader('www-authenticate', 'Cookie')
        sendJson(response, status, { ok: false, error: failure })
        finish(status)
        return
      }
    }

    // --- authorization ------------------------------------------------------
    /*
      A path outside `/api` that reached this point is not a route at all.

      Answered before the credential check on purpose: a 401 for `/favicon.ico`
      would tell a browser there is something protected at that path.
    */
    if (!path.startsWith('/api/') && path !== '/api') {
      sendJson(response, 404, { ok: false, error: notFound(path) })
      finish(404)
      return
    }

    let principal: ResolvedPrincipal
    try {
      principal = authorize(request, auth, getToken)
    } catch (error) {
      const failure = failureOf(error)
      const status = statusFor(failure)
      if (status === 401) response.setHeader('www-authenticate', 'Bearer')
      sendJson(response, status, { ok: false, error: failure })
      finish(status)
      return
    }

    // A cookie-authenticated write is a browser action, so it needs both an exact
    // Origin and the session's CSRF token. A bearer caller is not a browser and has
    // already proven possession of a secret.
    if (principal.kind === 'admin' && method !== 'GET' && method !== 'HEAD') {
      try {
        auth?.assertCookieWrite(request, principal.principal)
      } catch (error) {
        const failure = failureOf(error)
        const status = statusFor(failure)
        sendJson(response, status, { ok: false, error: failure })
        finish(status)
        return
      }
    }

    try {
      const status = await route(host, request, response, method, path, url, maxBodyBytes, {
        principal,
        getToken,
        // A long-lived stream opened by a browser must stop when that browser's
        // session ends — otherwise "log out" would leave a live feed running in a
        // tab that can no longer administer anything.
        ...(principal.kind === 'admin' && auth !== undefined
          ? { streamGuard: () => auth.sessionAlive(principal.principal.sessionId) }
          : {}),
        ...(options.setToken === undefined ? {} : { setToken: options.setToken }),
      })
      finish(status)
    } catch (error) {
      const failure = failureOf(error)
      // A failure the **node** reported is data, not an HTTP-level error: the call
      // did reach the node, its own code is what the caller has to branch on.
      const status = isBoundaryFailure(failure.code) ? statusFor(failure) : 200
      sendJson(response, status, { ok: false, error: failure })
      finish(status)
    }
  }

  return {
    handle,
    get requiresToken() {
      return normaliseToken(getToken()) !== undefined
    },
  }
}

/** Serve one whitelisted UI file. */
async function serveFile(response: ServerResponse, path: string, finish: (status: number) => void): Promise<void> {
  try {
    if (isUiPath(path)) {
      sendHtml(response, await readUiHtml())
    } else if (path === LOGIN_PATH) {
      sendHtml(response, await readLoginHtml())
    } else {
      sendAsset(response, path, await readUiAsset(path))
    }
    finish(200)
  } catch (error) {
    sendJson(response, 500, { ok: false, error: failureOf(error) })
    finish(500)
  }
}

/**
 * Decide who is calling, or refuse.
 *
 * An `Authorization` header means "machine client" and is never allowed to fall
 * back to the cookie: a caller that presents a bad bearer token has told us which
 * credential it meant to use, and quietly using a different one would hide the bug
 * that produced the bad token.
 */
function authorize(
  request: IncomingMessage,
  auth: AuthHttp | undefined,
  getToken: () => string | undefined,
): ResolvedPrincipal {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.trim() !== '') {
    const token = normaliseToken(getToken())
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
    if (token === undefined || match === null || !tokensMatch(token, (match[1] as string).trim())) {
      throw new CoordinatorError('coordinator/auth-rejected', 'the bearer token is not valid', {})
    }
    return { kind: 'operator' }
  }
  const principal = auth?.session(request)
  if (principal !== undefined) return { kind: 'admin', principal }
  throw new CoordinatorError(
    'coordinator/auth-required',
    auth === undefined
      ? 'this API requires a bearer token'
      : 'sign in at /login, or send a bearer token',
    {},
  )
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
  context: {
    readonly principal: ResolvedPrincipal
    readonly getToken: () => string | undefined
    readonly streamGuard?: () => boolean
    readonly setToken?: (token: string) => void
  },
): Promise<number> {
  const adminOnly = (): void => {
    if (context.principal.kind !== 'admin') {
      throw new CoordinatorError(
        'coordinator/auth-rejected',
        'this route changes management credentials and requires a browser administrator session',
        {},
      )
    }
  }

  // ------------------------------------------------------------- usage reads

  if (path.startsWith('/api/usage/')) {
    const usage = host.usage
    if (usage === undefined) {
      throw new CoordinatorError(
        'coordinator/storage-unavailable',
        'usage reporting needs a persistent database',
        {},
      )
    }
    const params: UsageQueryParams = {
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      timezone: url.searchParams.get('timezone'),
      nodeId: url.searchParams.get('nodeId'),
    }
    if (path === '/api/usage/summary' && method === 'GET') {
      sendJson(response, 200, { ok: true, value: usage.summary(params) })
      return 200
    }
    if (path === '/api/usage/nodes' && method === 'GET') {
      const sort = url.searchParams.get('sort') ?? 'knownTokens'
      if (sort !== 'knownTokens' && sort !== 'requestCount' && sort !== 'nodeName') {
        throw new CoordinatorError('coordinator/invalid-arguments', '"sort" must be knownTokens, requestCount or nodeName', {})
      }
      const order = url.searchParams.get('order') ?? 'desc'
      if (order !== 'asc' && order !== 'desc') {
        throw new CoordinatorError('coordinator/invalid-arguments', '"order" must be asc or desc', {})
      }
      const page = integerParam(url, 'page', 1, 1, 1_000_000)
      const pageSize = integerParam(url, 'pageSize', 20, 1, 100)
      sendJson(response, 200, { ok: true, value: usage.nodesReport(params, sort, order, page, pageSize) })
      return 200
    }
    if (path === '/api/usage/series' && method === 'GET') {
      const grain = url.searchParams.get('grain') ?? 'day'
      if (grain !== 'hour' && grain !== 'day') {
        throw new CoordinatorError('coordinator/invalid-arguments', '"grain" must be hour or day', {})
      }
      sendJson(response, 200, { ok: true, value: usage.series(params, grain) })
      return 200
    }
    if (path === '/api/usage/requests' && method === 'GET') {
      const window = parseWindow(params, Date.now())
      const usageFilter = url.searchParams.get('usage') ?? 'all'
      if (usageFilter !== 'all' && usageFilter !== 'reported' && usageFilter !== 'missing') {
        throw new CoordinatorError('coordinator/invalid-arguments', '"usage" must be all, reported or missing', {})
      }
      const provider = url.searchParams.get('provider')
      const model = url.searchParams.get('model')
      const state = url.searchParams.get('state')
      if (state !== null && !['running', 'completed', 'failed', 'cancelled', 'process_interrupted'].includes(state)) {
        throw new CoordinatorError('coordinator/invalid-arguments', '"state" is not a known attempt state', { state })
      }
      const limit = integerParam(url, 'limit', 20, 1, 100)
      const filter: RequestFilter = {
        ...window,
        ...(params.nodeId === null || params.nodeId === '' ? {} : { nodeId: params.nodeId }),
        ...(provider === null || provider === '' ? {} : { provider }),
        ...(model === null || model === '' ? {} : { model }),
        ...(state === null || state === '' ? {} : { state }),
        usage: usageFilter as 'all' | 'reported' | 'missing',
      }
      const cursor = url.searchParams.get('cursor') ?? undefined
      sendJson(response, 200, { ok: true, value: usage.requests(filter, limit, cursor) })
      return 200
    }
    if (path === '/api/usage/status' && method === 'GET') {
      const nodeId = params.nodeId === null || params.nodeId === '' ? undefined : params.nodeId
      sendJson(response, 200, { ok: true, value: usage.status(nodeId) })
      return 200
    }
    sendJson(response, 405, {
      ok: false,
      error: { code: 'coordinator/invalid-arguments', message: `${path} does not accept ${method}`, details: { path } },
    })
    return 405
  }

  // ---------------------------------------------------------------- reads

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

  // ------------------------------------------------------- operator credential

  if (path === '/api/operator-token') {
    /*
      Both credentials may configure the machine token, but never a password.

      Rotating this token is what a machine client does to itself; changing the
      administrator account is what only a browser session may do, and that is
      enforced on `/api/auth/password`, not here.
    */
    if (method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        value: {
          configured: normaliseToken(context.getToken()) !== undefined,
          persisted: host.persistenceEnabled === true,
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
    if (context.setToken === undefined) {
      sendJson(response, 404, { ok: false, error: notFound(path) })
      return 404
    }
    const body = await readJsonBody(request, maxBodyBytes)
    const token = requireString(body, 'token').trim()
    if (token === '') {
      throw new CoordinatorError('coordinator/invalid-arguments', '"token" must be a non-empty string', {
        field: 'token',
      })
    }
    context.setToken(token)
    sendJson(response, 200, {
      ok: true,
      value: { configured: true, persisted: host.persistenceEnabled === true },
    })
    return 200
  }

  // ------------------------------------------------------------ enrollment

  if (path === '/api/enrollment') {
    if (method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        value: {
          open: host.enrollmentOpen,
          persisted: host.persistenceEnabled === true,
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
    sendJson(response, 200, {
      ok: true,
      value: { open: host.enrollmentOpen, persisted: host.persistenceEnabled === true },
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
    return await streamToClient(host, nodeId, stream, response, context.streamGuard)
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
    return await streamToClient(host, nodeId, stream, response, context.streamGuard)
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
  streamGuard?: () => boolean,
): Promise<number> {
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  })

  let clientGone = false
  response.on('close', () => {
    if (response.writableEnded) return
    clientGone = true
    host.cancelStream(nodeId, stream.streamId, 'the HTTP client disconnected')
  })

  /*
    Check the session independently of the data flow.

    Waiting for the next chunk would leave an idle stream running long after the
    session it belongs to is gone; the check has to be on its own clock.
  */
  const watchdog = streamGuard === undefined
    ? undefined
    : setInterval(() => {
      if (clientGone || streamGuard()) return
      clientGone = true
      host.cancelStream(nodeId, stream.streamId, 'the administrator session ended')
      try {
        response.destroy()
      } catch {
        // Already closed.
      }
    }, 30_000)
  watchdog?.unref?.()

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
    write({ type: 'error', error: failureOf(error), count: stream.count })
  } finally {
    if (watchdog !== undefined) clearInterval(watchdog)
  }
  if (!response.writableEnded) response.end()
  return 200
}

/** Parse one bounded integer query parameter. */
function integerParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${name}" must be an integer between ${min} and ${max}`, {
      field: name,
    })
  }
  return value
}

function normaliseToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined
  const trimmed = token.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Whether a failure code belongs to this service rather than to a node. */
function isBoundaryFailure(code: string): boolean {
  return code.startsWith('coordinator/') || code.startsWith('usage/')
}

/** Map a failure onto an HTTP status. */
function statusFor(failure: { readonly code: string }): number {
  switch (failure.code) {
    case 'coordinator/auth-required':
    case 'coordinator/auth-rejected':
      return 401
    case 'coordinator/auth-uninitialized':
      return 503
    case 'coordinator/auth-rate-limited':
      return 429
    case 'coordinator/auth-invalid-request':
    case 'coordinator/invalid-arguments':
    case 'coordinator/protocol-invalid':
    case 'usage/contract-invalid':
      return 400
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
    case 'coordinator/storage-unavailable':
    case 'coordinator/sqlite-unavailable':
    case 'coordinator/schema-too-new':
      return 500
    case 'usage/collector-fork':
    case 'usage/sequence-gap':
    case 'usage/collector-mismatch':
      return 502
    default:
      return 502
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

/** Read the create-session fields. */
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

/** Timezone type re-exported so callers can build the same filter shape. */
export type { UsageTimezone }
