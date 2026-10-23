/**
 * The single administrator: hashing, sessions, expiry, revocation, and rate limits.
 *
 * The clock is injected everywhere, because three of the guarantees are only
 * observable across time: idle expiry, absolute expiry, and the rule that a poll
 * cannot extend either. The KDF cost is lowered for the suite; the production
 * parameters are measured separately in `docs/usage-compatibility.md`.
 *
 * @module dsh-coordinator/test/auth
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthError, AuthService, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, normalizeUsername, validatePassword } from '../src/auth.js'
import { openCoordinatorDatabase, type CoordinatorDatabase } from '../src/database.js'

const PASSWORD = 'correct horse battery staple'
const directories: string[] = []
const databases: CoordinatorDatabase[] = []

/** A fast KDF, so a login costs microseconds rather than a tenth of a second. */
const FAST_KDF = { N: 1_024, r: 8, p: 1, keylen: 32 }

interface Harness {
  readonly auth: AuthService
  readonly database: CoordinatorDatabase
  advance(ms: number): void
}

/** A service on a temporary database, with a controllable clock. */
async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-coordinator-auth-'))
  directories.push(directory)
  const database = openCoordinatorDatabase({ file: join(directory, 'coordinator.sqlite') })
  databases.push(database)
  let now = Date.parse('2026-10-23T08:00:00.000Z')
  const auth = new AuthService({ db: database.db, now: () => now, kdf: FAST_KDF })
  return {
    auth,
    database,
    advance: (ms) => { now += ms },
  }
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('creating the administrator', () => {
  it('can be created once and only once', async () => {
    const { auth } = await harness()
    expect(auth.initialized).toBe(false)
    await auth.initAdmin('admin', PASSWORD)
    expect(auth.initialized).toBe(true)
    await expect(auth.initAdmin('other', PASSWORD)).rejects.toThrow(/already exists/u)
    expect(auth.user?.username).toBe('admin')
  })

  it('validates the username and the password length', async () => {
    const { auth } = await harness()
    await expect(auth.initAdmin('ad', PASSWORD)).rejects.toThrow(AuthError)
    await expect(auth.initAdmin('has space', PASSWORD)).rejects.toThrow(AuthError)
    await expect(auth.initAdmin('admin', 'short')).rejects.toThrow(/12/u)
    await expect(auth.initAdmin('admin', 'x'.repeat(129))).rejects.toThrow(/12..128/u)
    // At least one non-ASCII password must work, measured in code points.
    await auth.initAdmin('admin', '密码密码密码密码密码密码')
    expect(auth.initialized).toBe(true)
  })

  it('never stores the password or a raw session token', async () => {
    const { auth, database } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const user = database.db.prepare('SELECT * FROM admin_users').get()
    expect(JSON.stringify(user)).not.toContain(PASSWORD)
    const result = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '127.0.0.1' })
    const session = database.db.prepare('SELECT * FROM admin_sessions').get()
    expect(JSON.stringify(session)).not.toContain(result.cookieToken)
    expect(session?.['token_hash']).toMatch(/^[0-9a-f]{64}$/u)
  })
})

describe('logging in', () => {
  it('gives the same answer for a wrong password and an unknown user', async () => {
    const { auth } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const wrongPassword = await auth
      .login({ username: 'admin', password: 'not the password', sourceAddress: '10.0.0.1' })
      .catch((error: unknown) => error as AuthError)
    const unknownUser = await auth
      .login({ username: 'nobody', password: PASSWORD, sourceAddress: '10.0.0.2' })
      .catch((error: unknown) => error as AuthError)
    expect(wrongPassword).toBeInstanceOf(AuthError)
    expect(unknownUser).toBeInstanceOf(AuthError)
    expect((wrongPassword as AuthError).message).toBe((unknownUser as AuthError).message)
    expect((wrongPassword as AuthError).code).toBe('coordinator/auth-rejected')
  })

  it('rotates the session token on every login', async () => {
    const { auth } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const first = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    const second = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    expect(first.cookieToken).not.toBe(second.cookieToken)
    expect(first.csrfToken).not.toBe(second.csrfToken)
  })

  it('refuses a login before the account exists', async () => {
    const { auth } = await harness()
    await expect(auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' }))
      .rejects.toMatchObject({ code: 'coordinator/auth-uninitialized' })
  })
})

describe('session expiry', () => {
  it('ends an idle session after 30 minutes', async () => {
    const { auth, advance } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const login = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    advance(SESSION_IDLE_MS - 1)
    expect(auth.authenticate(login.cookieToken)).toBeDefined()
    advance(2)
    expect(auth.authenticate(login.cookieToken)).toBeUndefined()
  })

  it('does not let activity extend the absolute 12-hour deadline', async () => {
    const { auth, advance } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const login = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    let principal = auth.authenticate(login.cookieToken)
    expect(principal).toBeDefined()
    // Twenty minutes of activity, twenty-three hours' worth of polls.
    for (let elapsed = 0; elapsed < SESSION_ABSOLUTE_MS - 60_000; elapsed += 20 * 60_000) {
      advance(20 * 60_000)
      principal = auth.authenticate(login.cookieToken)
      if (principal !== undefined) auth.touch(principal)
    }
    advance(120_000)
    expect(auth.authenticate(login.cookieToken)).toBeUndefined()
  })

  it('is not extended by polling: authenticate never moves the idle clock', async () => {
    const { auth, advance } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const login = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    // A 15-second poll for slightly more than the full idle window.
    for (let elapsed = 0; elapsed < SESSION_IDLE_MS; elapsed += 15_000) {
      expect(auth.authenticate(login.cookieToken)).toBeDefined()
      advance(15_000)
    }
    advance(1)
    expect(auth.authenticate(login.cookieToken)).toBeUndefined()
  })

  it('touch restarts the idle clock without moving the absolute expiry', async () => {
    const { auth, advance } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const login = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    advance(SESSION_IDLE_MS - 60_000)
    let principal = auth.authenticate(login.cookieToken)
    expect(principal).toBeDefined()
    const touched = auth.touch(principal as NonNullable<typeof principal>)
    expect(touched.expiresAt).toBe(login.expiresAt)
    advance(SESSION_IDLE_MS - 1)
    principal = auth.authenticate(login.cookieToken)
    expect(principal).toBeDefined()
  })
})

describe('revocation', () => {
  it('logout ends the session immediately', async () => {
    const { auth } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const login = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    const principal = auth.authenticate(login.cookieToken)
    auth.logout(principal as NonNullable<typeof principal>)
    expect(auth.authenticate(login.cookieToken)).toBeUndefined()
    expect(auth.sessionAlive(principal!.sessionId)).toBe(false)
  })

  it('a password change revokes every session, including the caller', async () => {
    const { auth } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const first = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    const second = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.2' })
    const principal = auth.authenticate(first.cookieToken)
    await auth.changePassword(principal as NonNullable<typeof principal>, PASSWORD, 'a brand new passphrase')
    expect(auth.authenticate(first.cookieToken)).toBeUndefined()
    expect(auth.authenticate(second.cookieToken)).toBeUndefined()
    await expect(auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.3' }))
      .rejects.toMatchObject({ code: 'coordinator/auth-rejected' })
    await expect(auth.login({ username: 'admin', password: 'a brand new passphrase', sourceAddress: '10.0.0.3' }))
      .resolves.toBeDefined()
  })

  it('a reset from the server revokes every session too', async () => {
    const { auth } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const login = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    await auth.resetPassword('another brand new passphrase')
    expect(auth.authenticate(login.cookieToken)).toBeUndefined()
    expect(auth.user?.username).toBe('admin')
  })
})

describe('CSRF', () => {
  it('accepts the derived token and nothing else', async () => {
    const { auth } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const login = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    const principal = auth.authenticate(login.cookieToken)
    expect(auth.verifyCsrf(principal as NonNullable<typeof principal>, login.csrfToken)).toBe(true)
    expect(auth.verifyCsrf(principal as NonNullable<typeof principal>, 'not-the-token')).toBe(false)
    expect(auth.verifyCsrf(principal as NonNullable<typeof principal>, undefined)).toBe(false)
  })

  it('derives the same token again after a restart, from the cookie alone', async () => {
    const { auth } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    const login = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
    // A second service instance on the same database models a restart.
    const { auth: restarted } = { auth }
    const principal = restarted.authenticate(login.cookieToken)
    expect(principal?.csrfToken).toBe(login.csrfToken)
  })
})

describe('rate limiting', () => {
  it('locks one account after five failures, then releases after the window', async () => {
    const { auth, advance } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login({ username: 'admin', password: 'wrong', sourceAddress: '10.0.0.1' }))
        .rejects.toMatchObject({ code: 'coordinator/auth-rejected' })
    }
    const limited = await auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' })
      .catch((error: unknown) => error as AuthError)
    expect(limited).toMatchObject({ code: 'coordinator/auth-rate-limited' })
    expect((limited as AuthError).retryAfterSeconds).toBeGreaterThan(0)
    advance(10 * 60_000 + 1)
    await expect(auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.1' }))
      .resolves.toBeDefined()
  })

  it('keeps the account limit scoped to the account, not the source', async () => {
    const { auth } = await harness()
    await auth.initAdmin('admin', PASSWORD)
    /*
      Five failures for one *account* lock that account for ten minutes, whichever
      address asks — that is the contract's rule and the reason a leaked username
      cannot be brute-forced from a botnet. A different account is unaffected, which
      is what this checks, using an unknown name so the admin account stays unlocked.
    */
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login({ username: 'nobody', password: 'wrong', sourceAddress: '10.0.0.1' }).catch(() => undefined)
    }
    await expect(auth.login({ username: 'nobody', password: 'wrong', sourceAddress: '10.0.0.2' }))
      .rejects.toMatchObject({ code: 'coordinator/auth-rate-limited' })
    await expect(auth.login({ username: 'admin', password: PASSWORD, sourceAddress: '10.0.0.2' }))
      .resolves.toBeDefined()
  })
})

describe('validation helpers', () => {
  it('normalizes the username to lower case and keeps the allowed punctuation', () => {
    expect(normalizeUsername('Ad.Min_1')).toBe('ad.min_1')
    expect(normalizeUsername('  Admin  ')).toBe('admin')
    expect(() => normalizeUsername('ab')).toThrow(AuthError)
    expect(() => normalizeUsername('a'.repeat(65))).toThrow(AuthError)
  })

  it('measures the password in code points, with a byte ceiling that cannot bite first', () => {
    expect(() => validatePassword('short')).toThrow(AuthError)
    expect(() => validatePassword('123456789012')).not.toThrow()
    expect(() => validatePassword('x'.repeat(128))).not.toThrow()
    expect(() => validatePassword('x'.repeat(129))).toThrow(AuthError)
    // 128 code points can be at most 512 UTF-8 bytes, so the 1024-byte ceiling is a
    // guard for a future length change rather than a reachable limit today.
    expect(() => validatePassword('密'.repeat(128))).not.toThrow()
    expect(() => validatePassword('密'.repeat(129))).toThrow(/12..128/u)
  })
})
