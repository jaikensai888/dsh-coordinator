/**
 * The single administrator: password hashing, sessions, rate limiting, and audit.
 *
 * Scope is deliberately narrow (design §"认证设计"): one account, created and reset
 * from a server-local CLI, no registration, no password recovery by mail, no roles.
 * What the account can do is therefore not the interesting part — what protects it
 * is.
 *
 * The properties this file is responsible for:
 *
 * - **Passwords are never stored or logged.** scrypt with a random per-account
 *   salt, the cost parameters kept beside the hash so a later build can verify an
 *   older one, and a timing-safe comparison.
 * - **A wrong username costs the same as a wrong password.** A missing account
 *   still runs one scrypt against a fixed dummy digest.
 * - **Sessions are opaque and server-owned.** A random 32-byte token is sent to
 *   the browser; SQLite stores only its SHA-256. Idle expiry (30 min) and absolute
 *   expiry (12 h) are both enforced here, and a background poll cannot extend the
 *   absolute deadline because only {@link AuthService.touch} moves the idle clock.
 * - **Changing or resetting the password revokes every session**, because a
 *   credential change that leaves old sessions valid has not actually changed
 *   anything for whoever had the old password.
 * - **CSRF tokens are derived, not stored in the clear.**
 *   `csrf = HMAC(csrfKey, sessionToken)`, so `/api/auth/me` can re-derive it after a
 *   restart, and SQLite stores only its hash.
 *
 * @module dsh-coordinator/auth
 */

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { CoordinatorError } from './errors.js'
import { readSetting, writeSetting } from './database.js'
import { inTransaction, type SqlDatabase } from './sqlite.js'

/** How long a session may sit idle before it is refused. */
export const SESSION_IDLE_MS = 30 * 60 * 1000

/** How long a session may exist at all, no matter how active. */
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000

/** How often the idle clock may be written to disk. */
export const SESSION_PERSIST_INTERVAL_MS = 60 * 1000

/** Minimum password length, in Unicode code points. */
export const MIN_PASSWORD_LENGTH = 12

/** Maximum password length, in Unicode code points. */
export const MAX_PASSWORD_LENGTH = 128

/** Maximum password size, in UTF-8 bytes. */
export const MAX_PASSWORD_BYTES = 1024

/** The username pattern the contract fixes. */
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/u

/** The default KDF cost. Measured on the target host in `docs/usage-compatibility.md`. */
export const DEFAULT_KDF = { alg: 'scrypt', N: 32768, r: 8, p: 1, keylen: 64 } as const

/** The `settings` key holding the CSRF derivation key. */
const CSRF_KEY_SETTING = 'csrfKey'

/** The name of the session cookie. */
export const SESSION_COOKIE_NAME = 'dsh_admin_session'

/** Login attempts allowed per source address per window. */
export const SOURCE_ATTEMPT_LIMIT = 15

/** Login failures allowed per account per window. */
export const ACCOUNT_FAILURE_LIMIT = 5

/** The rate-limit window. */
export const RATE_WINDOW_MS = 10 * 60 * 1000

/** The maximum number of rate-limit keys held in memory. */
export const MAX_RATE_KEYS = 10_000

/** One authenticated administrator session. */
export interface AdminPrincipal {
  readonly kind: 'admin'
  /** The session's primary key: the SHA-256 of the cookie token. */
  readonly sessionId: string
  readonly username: string
  /** The derived CSRF token; safe for the browser, useless without the cookie. */
  readonly csrfToken: string
  /** Absolute expiry, ISO-8601. */
  readonly expiresAt: string
}

/** A machine client using the operator bearer token. */
export interface OperatorPrincipal {
  readonly kind: 'operator'
}

/** Either caller. */
export type Principal = AdminPrincipal | OperatorPrincipal

/** A stored administrator, without any secret. */
export interface AdminUserView {
  readonly username: string
  readonly credentialVersion: number
}

/** What a successful login produced. */
export interface LoginResult {
  readonly cookieToken: string
  readonly csrfToken: string
  readonly user: AdminUserView
  readonly expiresAt: string
}

/** Auth failures, with the codes the HTTP layer maps onto statuses. */
export type AuthErrorCode =
  | 'coordinator/auth-uninitialized'
  | 'coordinator/auth-rejected'
  | 'coordinator/auth-required'
  | 'coordinator/auth-rate-limited'
  | 'coordinator/auth-invalid-request'

/** A failure raised by this module. */
export class AuthError extends CoordinatorError {
  /** Seconds the caller should wait, when rate limited. */
  readonly retryAfterSeconds: number | undefined

  /**
   * @param code - the stable failure code.
   * @param message - an operator-facing explanation with no secret in it.
   * @param retryAfterSeconds - present on a rate-limit failure.
   */
  constructor(code: AuthErrorCode, message: string, retryAfterSeconds?: number) {
    super(code, message, retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
    this.name = 'AuthError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Whether a value is this module's failure. */
export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError
}

/** Options for {@link AuthService}. */
export interface AuthServiceOptions {
  readonly db: SqlDatabase
  /** Injectable clock, in milliseconds. */
  readonly now?: () => number
  /** Injectable KDF cost, so tests do not have to pay 100 ms per hash. */
  readonly kdf?: { readonly N: number; readonly r: number; readonly p: number; readonly keylen: number }
}

/** A bounded counter, one window per key. */
interface Bucket {
  count: number
  windowStart: number
}

/**
 * A bounded, window-based failure counter.
 *
 * Bounded on purpose: an unbounded map keyed by a remote value is a memory leak
 * with a remote trigger. The oldest entry is evicted when the cap is reached, so
 * the worst an attacker can do is make an older key's failures forgettable —
 * never grow this process without limit.
 */
class RateLimiter {
  readonly #buckets = new Map<string, Bucket>()
  readonly #limit: number
  readonly #windowMs: number
  readonly #capacity: number
  readonly #now: () => number

  constructor(limit: number, windowMs: number, capacity: number, now: () => number) {
    this.#limit = limit
    this.#windowMs = windowMs
    this.#capacity = capacity
    this.#now = now
  }

  /** Seconds to wait when the key is over its limit, otherwise 0. */
  retryAfter(key: string): number {
    const bucket = this.#buckets.get(key)
    if (bucket === undefined) return 0
    const now = this.#now()
    if (now - bucket.windowStart >= this.#windowMs) {
      this.#buckets.delete(key)
      return 0
    }
    if (bucket.count < this.#limit) return 0
    return Math.max(1, Math.ceil((bucket.windowStart + this.#windowMs - now) / 1000))
  }

  /** Record one failure. */
  record(key: string): void {
    const now = this.#now()
    const bucket = this.#buckets.get(key)
    if (bucket === undefined || now - bucket.windowStart >= this.#windowMs) {
      if (this.#buckets.size >= this.#capacity) {
        const oldest = this.#buckets.keys().next()
        if (!oldest.done) this.#buckets.delete(oldest.value)
      }
      // Deleting then re-inserting keeps Map iteration order meaningful for the
      // eviction above.
      this.#buckets.delete(key)
      this.#buckets.set(key, { count: 1, windowStart: now })
      return
    }
    bucket.count += 1
    this.#buckets.set(key, bucket)
  }

  /** Forget a key's failures, after a success. */
  reset(key: string): void {
    this.#buckets.delete(key)
  }

  /** Drop keys whose window has closed. */
  sweep(): void {
    const now = this.#now()
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.windowStart >= this.#windowMs) this.#buckets.delete(key)
    }
  }
}

/**
 * Password hashing and session management for the one administrator.
 */
export class AuthService {
  readonly #db: SqlDatabase
  readonly #now: () => number
  readonly #kdf: { N: number; r: number; p: number; keylen: number }
  readonly #sourceLimiter: RateLimiter
  readonly #accountLimiter: RateLimiter
  /** Caps concurrent scrypt calls: the thread pool is small and shared. */
  #kdfActive = 0
  readonly #kdfQueue: (() => void)[] = []
  #disposed = false

  /** @param options - database, clock, and KDF cost. */
  constructor(options: AuthServiceOptions) {
    this.#db = options.db
    this.#now = options.now ?? (() => Date.now())
    this.#kdf = options.kdf ?? DEFAULT_KDF
    this.#sourceLimiter = new RateLimiter(SOURCE_ATTEMPT_LIMIT, RATE_WINDOW_MS, MAX_RATE_KEYS, this.#now)
    this.#accountLimiter = new RateLimiter(ACCOUNT_FAILURE_LIMIT, RATE_WINDOW_MS, MAX_RATE_KEYS, this.#now)
  }

  /** Whether an administrator exists. */
  get initialized(): boolean {
    return this.#readUser() !== undefined
  }

  /** The stored account, without secrets. */
  get user(): AdminUserView | undefined {
    const row = this.#readUser()
    if (row === undefined) return undefined
    return { username: row.username, credentialVersion: row.credentialVersion }
  }

  /** Read the CSRF derivation key, creating it on first use. */
  #csrfKey(): string {
    const existing = readSetting<string>(this.#db, CSRF_KEY_SETTING)
    if (typeof existing === 'string' && existing !== '') return existing
    const key = randomBytes(32).toString('base64url')
    writeSetting(this.#db, CSRF_KEY_SETTING, key)
    return key
  }

  /** Derive the CSRF token for a cookie token. */
  #csrfFor(cookieToken: string): string {
    return createHmac('sha256', this.#csrfKey()).update(cookieToken, 'utf8').digest('base64url')
  }

  /** SHA-256 of a session token, hex. What the database stores. */
  #sessionHash(cookieToken: string): string {
    return createHash('sha256').update(cookieToken, 'utf8').digest('hex')
  }

  /** SHA-256 of a CSRF token, hex. What the database stores. */
  #csrfHash(csrfToken: string): string {
    return createHash('sha256').update(csrfToken, 'utf8').digest('hex')
  }

  /** Read the account row. */
  #readUser(): {
    username: string
    passwordHash: string
    salt: string
    kdf: { N: number; r: number; p: number; keylen: number }
    credentialVersion: number
  } | undefined {
    const row = this.#db.prepare(
      'SELECT username, password_hash, salt, kdf_json, credential_version FROM admin_users WHERE singleton_id = 1',
    ).get()
    if (row === undefined) return undefined
    const kdf = parseKdf(row['kdf_json'])
    return {
      username: String(row['username']),
      passwordHash: String(row['password_hash']),
      salt: String(row['salt']),
      kdf,
      credentialVersion: numberValue(row['credential_version']),
    }
  }

  /** Run one scrypt with the concurrency cap. */
  async #derive(
    password: string,
    salt: Buffer,
    kdf: { readonly N: number; readonly r: number; readonly p: number; readonly keylen: number } | undefined = this.#kdf,
  ): Promise<Buffer> {
    await this.#acquire()
    try {
      const { N, r, p, keylen } = kdf ?? this.#kdf
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password,
          salt,
          keylen,
          // The *stored* parameters are used for verification, not the current
          // ones: changing the cost must not lock out an existing account.
          { N, r, p, maxmem: 64 * 1024 * 1024 },
          (error, derived) => {
            if (error !== null) reject(error)
            else resolve(derived)
          },
        )
      })
    } finally {
      this.#release()
    }
  }

  /** Wait for one of at most two KDF slots. */
  async #acquire(): Promise<void> {
    if (this.#kdfActive < 2) {
      this.#kdfActive += 1
      return
    }
    await new Promise<void>(resolve => { this.#kdfQueue.push(resolve) })
    this.#kdfActive += 1
  }

  /** Release a KDF slot and wake the next waiter. */
  #release(): void {
    this.#kdfActive -= 1
    const next = this.#kdfQueue.shift()
    if (next !== undefined) next()
  }

  /**
   * Create the administrator.
   * @param username - 3..64 ASCII letters, digits, `.`, `_`, `-`.
   * @param password - 12..128 characters, at most 1024 UTF-8 bytes.
   * @throws AuthError `coordinator/auth-invalid-request` on bad input, or
   * `coordinator/auth-rejected` when an administrator already exists.
   */
  async initAdmin(username: string, password: string): Promise<void> {
    if (this.initialized) {
      throw new AuthError('coordinator/auth-rejected', 'an administrator already exists; use reset-password instead')
    }
    const normalized = normalizeUsername(username)
    validatePassword(password)
    const salt = randomBytes(16)
    const derived = await this.#derive(password, salt)
    const now = new Date(this.#now()).toISOString()
    try {
      inTransaction(this.#db, () => {
        this.#db.prepare(
          `INSERT INTO admin_users
             (singleton_id, username, password_hash, salt, kdf_json, credential_version, created_at, updated_at)
           VALUES (1, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(normalized, derived.toString('hex'), salt.toString('hex'), JSON.stringify(this.#kdf), now, now)
      })
    } catch (error) {
      // The CHECK constraint and the unique index are the real "only one" gate; an
      // error here is a race with another init, not a bug worth retrying.
      throw new AuthError(
        'coordinator/auth-rejected',
        `the administrator could not be created: ${(error as Error).message}`,
      )
    }
    this.#audit('init', 'success', undefined)
  }

  /**
   * Replace the password from the server's own console, revoking every session.
   * @param password - the new password.
   * @throws AuthError `coordinator/auth-uninitialized` when there is no account.
   */
  async resetPassword(password: string): Promise<void> {
    const user = this.#readUser()
    if (user === undefined) {
      throw new AuthError('coordinator/auth-uninitialized', 'no administrator exists yet')
    }
    validatePassword(password)
    const salt = randomBytes(16)
    const derived = await this.#derive(password, salt)
    const now = new Date(this.#now()).toISOString()
    inTransaction(this.#db, () => {
      this.#db.prepare(
        `UPDATE admin_users
            SET password_hash = ?, salt = ?, kdf_json = ?, credential_version = credential_version + 1, updated_at = ?
          WHERE singleton_id = 1`,
      ).run(derived.toString('hex'), salt.toString('hex'), JSON.stringify(this.#kdf), now)
      this.#db.prepare('DELETE FROM admin_sessions').run()
    })
    this.#audit('reset-password', 'success', undefined)
  }

  /**
   * Verify a password and open a session.
   * @param input - username, password, and the source address for rate limiting.
   * @returns the cookie token, CSRF token, user and absolute expiry.
   * @throws AuthError on bad credentials, rate limiting, or an uninitialized account.
   */
  async login(input: {
    readonly username: string
    readonly password: string
    readonly sourceAddress: string | undefined
  }): Promise<LoginResult> {
    const user = this.#readUser()
    if (user === undefined) {
      throw new AuthError('coordinator/auth-uninitialized', 'management login needs a persistent database with an administrator')
    }
    const normalized = safeNormalizeUsername(input.username)
    const sourceKey = `source:${input.sourceAddress ?? 'unknown'}`
    const accountKey = `account:${normalized}`

    const sourceWait = this.#sourceLimiter.retryAfter(sourceKey)
    if (sourceWait > 0) {
      this.#audit('login', 'rate-limited', input.sourceAddress)
      throw new AuthError('coordinator/auth-rate-limited', `too many attempts from this address; retry in ${sourceWait}s`, sourceWait)
    }
    const accountWait = this.#accountLimiter.retryAfter(accountKey)
    if (accountWait > 0) {
      this.#audit('login', 'rate-limited', input.sourceAddress)
      throw new AuthError('coordinator/auth-rate-limited', `too many failed attempts for this account; retry in ${accountWait}s`, accountWait)
    }

    const matches = await this.#verify(input.password, user)
    /*
      The username has to match too.

      Verifying only the password would mean "any username, as long as the password is
      right", which sounds harmless until the check is reused. The derivation has
      already run, so a wrong username costs exactly what a wrong password costs.
    */
    const usernameMatches = normalized === user.username.toLowerCase()
    if (!matches || !usernameMatches) {
      this.#sourceLimiter.record(sourceKey)
      this.#accountLimiter.record(accountKey)
      this.#audit('login', 'failure', input.sourceAddress)
      throw new AuthError('coordinator/auth-rejected', 'invalid username or password')
    }
    this.#sourceLimiter.reset(sourceKey)
    this.#accountLimiter.reset(accountKey)

    const cookieToken = randomBytes(32).toString('base64url')
    const csrfToken = this.#csrfFor(cookieToken)
    const sessionHash = this.#sessionHash(cookieToken)
    const nowMs = this.#now()
    const createdAt = new Date(nowMs).toISOString()
    const expiresAt = new Date(nowMs + SESSION_ABSOLUTE_MS).toISOString()
    this.#db.prepare(
      `INSERT INTO admin_sessions
         (token_hash, user_id, credential_version, created_at, last_seen_at, expires_at, csrf_hash)
       VALUES (?, 1, ?, ?, ?, ?, ?)`,
    ).run(sessionHash, user.credentialVersion, createdAt, createdAt, expiresAt, this.#csrfHash(csrfToken))
    this.#audit('login', 'success', input.sourceAddress)
    return {
      cookieToken,
      csrfToken,
      user: { username: user.username, credentialVersion: user.credentialVersion },
      expiresAt,
    }
  }

  /** Compare a password against the stored digest, or a dummy one. */
  async #verify(password: string, user: {
    passwordHash: string
    salt: string
    kdf: { N: number; r: number; p: number; keylen: number }
  } | undefined): Promise<boolean> {
    // A missing account still pays for one derivation, so "no such user" and
    // "wrong password" take the same time and the login form is not an account
    // oracle.
    const salt = user === undefined ? Buffer.alloc(16, 7) : Buffer.from(user.salt, 'hex')
    const expected = user === undefined
      ? Buffer.alloc(this.#kdf.keylen, 0)
      : Buffer.from(user.passwordHash, 'hex')
    let derived: Buffer
    try {
      derived = await this.#derive(password, salt, user?.kdf)
    } catch {
      return false
    }
    if (derived.length !== expected.length) return false
    return timingSafeEqual(derived, expected)
  }

  /**
   * Resolve a cookie token to a live session.
   *
   * Both expiries are checked here, which is the whole point of doing it server
   * side: a client that keeps polling, or that never closes its tab, cannot make a
   * session outlive its absolute deadline.
   * @param cookieToken - the raw cookie value.
   * @returns the principal, or undefined when the session is not usable.
   */
  authenticate(cookieToken: string | undefined): AdminPrincipal | undefined {
    if (cookieToken === undefined || cookieToken === '') return undefined
    const sessionHash = this.#sessionHash(cookieToken)
    const row = this.#db.prepare(
      `SELECT s.token_hash, s.credential_version AS session_version, s.last_seen_at, s.expires_at,
              u.username, u.credential_version AS user_version
         FROM admin_sessions s JOIN admin_users u ON u.singleton_id = s.user_id
        WHERE s.token_hash = ?`,
    ).get(sessionHash)
    if (row === undefined) return undefined

    const now = this.#now()
    const expiresAt = Date.parse(String(row['expires_at']))
    const lastSeen = Date.parse(String(row['last_seen_at']))
    if (!Number.isFinite(expiresAt) || now >= expiresAt) {
      this.#deleteSession(sessionHash)
      return undefined
    }
    if (!Number.isFinite(lastSeen) || now - lastSeen > SESSION_IDLE_MS) {
      this.#deleteSession(sessionHash)
      return undefined
    }
    if (numberValue(row['session_version']) !== numberValue(row['user_version'])) {
      // The password changed after this session was issued.
      this.#deleteSession(sessionHash)
      return undefined
    }

    /*
      No `last_seen_at` write here, on purpose.

      Resolving a session is what a *poll* does, and a fifteen-second status poll
      must not keep an idle session alive. Only `touch()` — called from the
      foreground `POST /api/auth/activity` — moves the idle clock, which is the rule
      the contract states and the reason an unattended tab eventually locks.
    */
    return {
      kind: 'admin',
      sessionId: sessionHash,
      username: String(row['username']),
      csrfToken: this.#csrfFor(cookieToken),
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  /**
   * Restart the idle clock, without moving the absolute deadline.
   * @param principal - the session to touch.
   * @returns the absolute expiry.
   */
  touch(principal: AdminPrincipal): { expiresAt: string } {
    const now = this.#now()
    this.#db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run(new Date(now).toISOString(), principal.sessionId)
    return { expiresAt: principal.expiresAt }
  }

  /**
   * Check a CSRF token for a session.
   * @param principal - the session.
   * @param token - the value of `X-CSRF-Token`.
   * @returns whether it matches.
   */
  verifyCsrf(principal: AdminPrincipal, token: string | undefined): boolean {
    if (token === undefined || token === '') return false
    // The session row stores SHA-256(csrf), never csrf itself, and never the
    // cookie. Comparing hashes keeps the check constant-time and means a leaked
    // database row is not a usable CSRF token.
    const expected = this.#csrfHash(token)
    const row = this.#db.prepare('SELECT csrf_hash FROM admin_sessions WHERE token_hash = ?')
      .get(principal.sessionId)
    const stored = row?.['csrf_hash']
    if (typeof stored !== 'string') return false
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(stored, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  /** Revoke one session. */
  logout(principal: AdminPrincipal): void {
    this.#deleteSession(principal.sessionId)
    this.#audit('logout', 'success', undefined)
  }

  /** Revoke every session; used after a password change and by the CLI. */
  revokeAllSessions(): void {
    this.#db.prepare('DELETE FROM admin_sessions').run()
  }

  /**
   * Change the password from the browser, which requires the current one.
   *
   * Revokes **all** sessions including the caller's: the contract says so, and it
   * is the behaviour that makes "I changed my password" actually mean the old one
   * no longer works anywhere.
   * @param principal - the caller.
   * @param currentPassword - proof of the current credential.
   * @param newPassword - the replacement.
   */
  async changePassword(principal: AdminPrincipal, currentPassword: string, newPassword: string): Promise<void> {
    const user = this.#readUser()
    if (user === undefined) throw new AuthError('coordinator/auth-uninitialized', 'no administrator exists')
    const matches = await this.#verify(currentPassword, user)
    if (!matches) {
      this.#accountLimiter.record(`account:${user.username}`)
      this.#audit('password', 'failure', undefined)
      throw new AuthError('coordinator/auth-rejected', 'the current password is not correct')
    }
    validatePassword(newPassword)
    if (newPassword === currentPassword) {
      throw new AuthError('coordinator/auth-invalid-request', 'the new password must differ from the current one')
    }
    const salt = randomBytes(16)
    const derived = await this.#derive(newPassword, salt)
    const now = new Date(this.#now()).toISOString()
    inTransaction(this.#db, () => {
      this.#db.prepare(
        `UPDATE admin_users
            SET password_hash = ?, salt = ?, kdf_json = ?, credential_version = credential_version + 1, updated_at = ?
          WHERE singleton_id = 1`,
      ).run(derived.toString('hex'), salt.toString('hex'), JSON.stringify(this.#kdf), now)
      this.#db.prepare('DELETE FROM admin_sessions').run()
    })
    this.#audit('password', 'success', undefined)
    // The caller's own session is gone too; the HTTP layer answers
    // `{reauthenticate: true}` and clears the cookie.
    void principal
  }

  /** Delete one session row. */
  #deleteSession(sessionHash: string): void {
    this.#db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sessionHash)
  }

  /** Remove expired sessions and old audit rows. Safe to call on a timer. */
  cleanup(): void {
    const now = this.#now()
    const iso = new Date(now).toISOString()
    this.#db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(iso)
    // The audit trail is capped at 30 days; the contract says so and this is the
    // daily prune it describes.
    this.#db.prepare('DELETE FROM auth_audit WHERE at < ?')
      .run(new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString())
    this.#sourceLimiter.sweep()
    this.#accountLimiter.sweep()
  }

  /** Whether a session still exists. Used by long-lived streams. */
  sessionAlive(sessionId: string): boolean {
    const row = this.#db.prepare('SELECT expires_at, last_seen_at FROM admin_sessions WHERE token_hash = ?')
      .get(sessionId)
    if (row === undefined) return false
    const now = this.#now()
    const expiresAt = Date.parse(String(row['expires_at']))
    const lastSeen = Date.parse(String(row['last_seen_at']))
    return Number.isFinite(expiresAt) && Number.isFinite(lastSeen) &&
      now < expiresAt && now - lastSeen <= SESSION_IDLE_MS
  }

  /** Record one auth event, without a password, token, or cookie. */
  #audit(action: string, outcome: string, sourceAddress: string | undefined): void {
    try {
      this.#db.prepare('INSERT INTO auth_audit (at, action, outcome, source_address) VALUES (?, ?, ?, ?)')
        .run(new Date(this.#now()).toISOString(), action, outcome, sourceAddress ?? null)
    } catch {
      // An audit write must never turn a login into a failure; the outcome is
      // already decided by the time this runs.
    }
  }

  /** Stop accepting work. */
  dispose(): void {
    this.#disposed = true
    void this.#disposed
  }
}

/** Validate the username shape, returning the normalized form. */
export function normalizeUsername(value: string): string {
  const trimmed = value.trim()
  if (!USERNAME_PATTERN.test(trimmed)) {
    throw new AuthError(
      'coordinator/auth-invalid-request',
      'the username must be 3..64 characters of ASCII letters, digits, ".", "_" or "-"',
    )
  }
  return trimmed.toLowerCase()
}

/** Normalize for rate limiting without throwing on a malformed attempt. */
function safeNormalizeUsername(value: string): string {
  try {
    return normalizeUsername(value)
  } catch {
    return value.trim().toLowerCase().slice(0, 64)
  }
}

/**
 * Validate a password, in Unicode code points and UTF-8 bytes.
 * @param value - the password.
 * @throws AuthError `coordinator/auth-invalid-request`.
 */
export function validatePassword(value: string): void {
  const length = [...value].length
  if (length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(
      'coordinator/auth-invalid-request',
      `the password must be ${MIN_PASSWORD_LENGTH}..${MAX_PASSWORD_LENGTH} characters`,
    )
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new AuthError('coordinator/auth-invalid-request', `the password must be at most ${MAX_PASSWORD_BYTES} UTF-8 bytes`)
  }
}

/** Parse a stored KDF description, falling back to the current defaults. */
function parseKdf(value: unknown): { N: number; r: number; p: number; keylen: number } {
  if (typeof value !== 'string') return { ...DEFAULT_KDF }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const pick = (field: string, fallback: number): number => {
      const raw = parsed[field]
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
    }
    return {
      N: pick('N', DEFAULT_KDF.N),
      r: pick('r', DEFAULT_KDF.r),
      p: pick('p', DEFAULT_KDF.p),
      keylen: pick('keylen', DEFAULT_KDF.keylen),
    }
  } catch {
    return { ...DEFAULT_KDF }
  }
}

/** Read an integer column that may arrive as a number or a bigint. */
function numberValue(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  return 0
}
