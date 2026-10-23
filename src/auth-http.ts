/**
 * The browser-facing half of authentication: cookies, exact Origin checks, CSRF,
 * and the `/api/auth/*` routes.
 *
 * Four decisions worth stating out loud:
 *
 * - **The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/` and has no `Secure` bit on
 *   plain HTTP.** The deployment is a LAN address over HTTP; setting `Secure` would
 *   silently stop the cookie from being stored, and the login page would appear to
 *   succeed and then forget the session. `secureCookies` flips it for an HTTPS
 *   front end.
 * - **Origin is compared exactly, and a missing Origin is a refusal.** That is how
 *   a cross-site form post is rejected before it reaches a password check, and it
 *   is why the login route is JSON-only: a plain HTML form cannot set either header.
 * - **Every cookie-authenticated write needs `X-CSRF-Token`.** SameSite reduces the
 *   risk but does not remove it; the derived token does, and it lives only in the
 *   page's memory.
 * - **`X-Forwarded-*` is never consulted.** There is no trusted proxy in this
 *   deployment, so a header anyone can set is not evidence of anything.
 *
 * @module dsh-coordinator/auth-http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuthError, SESSION_COOKIE_NAME, type AdminPrincipal, type AuthService, type LoginResult } from './auth.js'
import { CoordinatorError } from './errors.js'
import { readJsonBody } from './http-api.js'

/** Options for {@link AuthHttp}. */
export interface AuthHttpOptions {
  readonly auth: AuthService
  /** The origin browsers are expected to use, when it is not the request's own Host. */
  readonly publicOrigin?: string
  /** Extra origins that may be treated as same-site (e.g. a loopback alias). */
  readonly allowedOrigins?: readonly string[]
  /** Set `Secure` on the session cookie. Only for an HTTPS front end. */
  readonly secureCookies?: boolean
  /** Whether a persistent database is behind the service. */
  readonly persistenceEnabled: boolean
}

/** The request-level facts a cookie-authenticated route needs. */
export interface CookieWriteCheck {
  readonly principal: AdminPrincipal
  readonly csrfToken: string | undefined
}

/**
 * Cookie authentication for the management console.
 */
export class AuthHttp {
  readonly #auth: AuthService
  readonly #publicOrigin: string | undefined
  readonly #allowedOrigins: ReadonlySet<string>
  readonly #secureCookies: boolean
  readonly #persistenceEnabled: boolean

  /** @param options - the service and origin policy. */
  constructor(options: AuthHttpOptions) {
    this.#auth = options.auth
    this.#publicOrigin = options.publicOrigin
    this.#allowedOrigins = new Set(options.allowedOrigins ?? [])
    this.#secureCookies = options.secureCookies === true
    this.#persistenceEnabled = options.persistenceEnabled
  }

  /** Whether browser login is possible. */
  get loginAvailable(): boolean {
    return this.#persistenceEnabled
  }

  /** The origin this deployment publishes, when configured. */
  get publicOrigin(): string | undefined {
    return this.#publicOrigin
  }

  /**
   * Handle one `/api/auth/*` route.
   * @param request - the HTTP request.
   * @param response - the HTTP response.
   * @param method - the request method.
   * @param path - the URL pathname.
   * @param maxBodyBytes - body ceiling.
   * @returns true when the route was handled.
   */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    path: string,
    maxBodyBytes: number,
  ): Promise<boolean> {
    if (!path.startsWith('/api/auth/')) return false
    if (path === '/api/auth/me') {
      if (method !== 'GET') {
        sendJson(response, 405, failure('coordinator/invalid-arguments', `${path} only accepts GET`))
        return true
      }
      this.#me(request, response)
      return true
    }
    if (method !== 'POST') {
      sendJson(response, 405, failure('coordinator/invalid-arguments', `${path} only accepts POST`))
      return true
    }
    if (path === '/api/auth/login') {
      await this.#login(request, response, maxBodyBytes)
      return true
    }
    if (path === '/api/auth/logout') {
      await this.#logout(request, response)
      return true
    }
    if (path === '/api/auth/password') {
      await this.#password(request, response, maxBodyBytes)
      return true
    }
    if (path === '/api/auth/activity') {
      await this.#activity(request, response)
      return true
    }
    sendJson(response, 404, failure('coordinator/invalid-arguments', `no route for ${path}`))
    return true
  }

  /** Resolve the session cookie, if one is present and live. */
  session(request: IncomingMessage): AdminPrincipal | undefined {
    return this.#auth.authenticate(readCookie(request, SESSION_COOKIE_NAME))
  }

  /** The raw cookie token, for deriving CSRF where needed. */
  cookieToken(request: IncomingMessage): string | undefined {
    return readCookie(request, SESSION_COOKIE_NAME)
  }

  /**
   * Whether a session is still usable.
   *
   * Long-lived streams poll this: a stream opened while signed in must stop when
   * the session is revoked or expires, not keep delivering to a browser that can no
   * longer manage anything.
   * @param sessionId - the session's primary key.
   * @returns whether the session is still live.
   */
  sessionAlive(sessionId: string): boolean {
    return this.#auth.sessionAlive(sessionId)
  }

  /**
   * Enforce Origin and CSRF for a cookie-authenticated write.
   * @param request - the request.
   * @param principal - the session the cookie resolved to.
   * @throws AuthError `coordinator/auth-invalid-request` when either check fails.
   */
  assertCookieWrite(request: IncomingMessage, principal: AdminPrincipal): void {
    this.assertOrigin(request)
    const header = request.headers['x-csrf-token']
    const token = Array.isArray(header) ? header[0] : header
    if (!this.#auth.verifyCsrf(principal, token)) {
      throw new AuthError('coordinator/auth-invalid-request', 'the CSRF token is missing or does not match this session')
    }
  }

  /**
   * Require an exact same-origin request.
   *
   * A browser sets `Origin` on every cross-origin request and on every POST; a
   * request without one is either not a browser or is a form post from a context
   * that deliberately omitted it, and neither is allowed to change state.
   * @throws AuthError when the origin is absent or different.
   */
  assertOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin
    if (typeof origin !== 'string' || origin === '') {
      throw new AuthError('coordinator/auth-invalid-request', 'this request must carry an Origin header')
    }
    if (this.#allowedOrigins.has(origin)) return
    if (this.#publicOrigin !== undefined && origin === this.#publicOrigin) return
    const host = request.headers.host
    if (typeof host === 'string' && host !== '') {
      // The request's own Host is the stricter comparison: a browser cannot set
      // Host to something other than the URL it is talking to, so an attacker's
      // page always arrives with a different Origin.
      const scheme = this.#secureCookies ? 'https' : 'http'
      if (origin === `${scheme}://${host}`) return
      // A mixed scheme is still the same host and port; accept it so an HTTPS
      // front end does not break the checks when it terminates TLS upstream.
      if (origin === `http://${host}` || origin === `https://${host}`) return
    }
    throw new AuthError('coordinator/auth-invalid-request', 'this request comes from a different origin')
  }

  /** Answer `GET /api/auth/me`. */
  #me(request: IncomingMessage, response: ServerResponse): void {
    const principal = this.session(request)
    if (principal === undefined) {
      // An expired cookie is cleared rather than left to be sent again.
      if (this.cookieToken(request) !== undefined) response.setHeader('set-cookie', this.#clearCookie())
      sendJson(response, 200, {
        ok: true,
        value: { authenticated: false, initialized: this.#auth.initialized },
      })
      return
    }
    sendJson(response, 200, {
      ok: true,
      value: {
        authenticated: true,
        user: { username: principal.username },
        csrfToken: principal.csrfToken,
        expiresAt: principal.expiresAt,
      },
    })
  }

  /** Answer `POST /api/auth/login`. */
  async #login(request: IncomingMessage, response: ServerResponse, maxBodyBytes: number): Promise<void> {
    if (!this.#persistenceEnabled) {
      throw new AuthError('coordinator/auth-uninitialized', 'management login needs a persistent database')
    }
    this.assertOrigin(request)
    const contentType = request.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      throw new AuthError('coordinator/auth-invalid-request', 'the login body must be application/json')
    }
    const body = await readJsonBody(request, Math.min(maxBodyBytes, 8 * 1024))
    const username = typeof body['username'] === 'string' ? body['username'] : ''
    const password = typeof body['password'] === 'string' ? body['password'] : ''
    if (username === '' || password === '') {
      throw new AuthError('coordinator/auth-rejected', 'invalid username or password')
    }
    const result: LoginResult = await this.#auth.login({
      username,
      password,
      sourceAddress: request.socket?.remoteAddress,
    })
    response.setHeader('set-cookie', this.#cookie(result.cookieToken))
    sendJson(response, 200, {
      ok: true,
      value: {
        user: { username: result.user.username },
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt,
      },
    })
  }

  /** Answer `POST /api/auth/logout`. */
  async #logout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const principal = this.session(request)
    if (principal === undefined) {
      throw new AuthError('coordinator/auth-required', 'no session to log out')
    }
    this.assertCookieWrite(request, principal)
    this.#auth.logout(principal)
    response.setHeader('set-cookie', this.#clearCookie())
    sendJson(response, 200, { ok: true, value: { loggedOut: true } })
  }

  /** Answer `POST /api/auth/password`. */
  async #password(request: IncomingMessage, response: ServerResponse, maxBodyBytes: number): Promise<void> {
    const principal = this.session(request)
    if (principal === undefined) {
      throw new AuthError('coordinator/auth-required', 'a session is required to change the password')
    }
    this.assertCookieWrite(request, principal)
    const body = await readJsonBody(request, Math.min(maxBodyBytes, 8 * 1024))
    const current = body['currentPassword']
    const next = body['newPassword']
    if (typeof current !== 'string' || typeof next !== 'string') {
      throw new AuthError('coordinator/auth-invalid-request', '"currentPassword" and "newPassword" are required')
    }
    await this.#auth.changePassword(principal, current, next)
    // Every session is gone, including this one.
    response.setHeader('set-cookie', this.#clearCookie())
    sendJson(response, 200, { ok: true, value: { reauthenticate: true } })
  }

  /** Answer `POST /api/auth/activity`. */
  async #activity(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const principal = this.session(request)
    if (principal === undefined) {
      throw new AuthError('coordinator/auth-required', 'no live session')
    }
    this.assertCookieWrite(request, principal)
    const { expiresAt } = this.#auth.touch(principal)
    sendJson(response, 200, { ok: true, value: { expiresAt } })
  }

  /** Build the `Set-Cookie` value that starts a session. */
  #cookie(token: string): string {
    const maxAge = Math.floor(12 * 60 * 60)
    return [
      `${SESSION_COOKIE_NAME}=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${maxAge}`,
      ...(this.#secureCookies ? ['Secure'] : []),
    ].join('; ')
  }

  /** Build the `Set-Cookie` value that clears a session. */
  #clearCookie(): string {
    return [
      `${SESSION_COOKIE_NAME}=`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0',
      ...(this.#secureCookies ? ['Secure'] : []),
    ].join('; ')
  }
}

/** Read one cookie value, without decoding more than once. */
export function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie
  if (typeof header !== 'string' || header === '') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    if (key !== name) continue
    const value = part.slice(index + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/** Build the wire failure the rest of the API uses. */
function failure(code: string, message: string): { ok: false; error: CoordinatorError } {
  return { ok: false, error: new CoordinatorError(code, message, {}) }
}

/** Send one JSON body. */
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
