/**
 * The management HTTP surface: who gets in, what a session can do, and the CSRF and
 * Origin rules around it.
 *
 * These tests run against a real `Coordinator` on a real loopback port with a real
 * cookie, because the properties under test are all about transport: a `Set-Cookie`
 * header, a 303 to the login page, an invalid bearer token that must not fall back
 * to a cookie. A stub would prove none of them.
 *
 * @module dsh-coordinator/test/usage-api
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/auth.js'
import { silentLogger } from '../src/log.js'
import { Coordinator } from '../src/server.js'

const PASSWORD = 'a sufficiently long passphrase'
const OPERATOR = 'operator-token-for-http-tests'
const directories: string[] = []
const coordinators: Coordinator[] = []

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.stop()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

interface Running {
  readonly coordinator: Coordinator
  readonly base: string
}

/** Start a Coordinator with a database, an administrator, and an operator token. */
async function start(): Promise<Running> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-coordinator-http-'))
  directories.push(directory)
  const coordinator = new Coordinator({
    port: 0,
    dbFile: join(directory, 'coordinator.sqlite'),
    apiToken: OPERATOR,
    logger: silentLogger,
    shutdownGraceMs: 200,
  })
  coordinators.push(coordinator)
  const auth = new AuthService({
    db: coordinator.database!.db,
    kdf: { N: 1_024, r: 8, p: 1, keylen: 32 },
  })
  await auth.initAdmin('admin', PASSWORD)
  const address = await coordinator.start()
  return { coordinator, base: `http://127.0.0.1:${address.port}` }
}

/** Insert one attempt row into the running Coordinator's database. */
function seed(running: Running, overrides: {
  attemptId: string
  startedAt: string
  known?: string
  state?: string
  usageReported?: boolean
  model?: string
}): void {
  const db = running.coordinator.database!.db
  db.prepare(
    `INSERT INTO usage_attempts
       (node_id, collector_id, attempt_id, revision_seq, started_at, provider, model, purpose, state,
        usage_reported, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
        total_tokens, known_tokens)
     VALUES ('node-1', 'c1', ?, 1, ?, 'deepseek-official', ?, 'conversation', ?, ?, 5, 3, 0, 2, 10, ?)`,
  ).run(
    overrides.attemptId,
    overrides.startedAt,
    overrides.model ?? 'deepseek-v4-flash',
    overrides.state ?? 'completed',
    overrides.usageReported === false ? 0 : 1,
    overrides.known ?? '10',
  )
}

/** Log in and return the cookie value plus the CSRF token. */
async function login(base: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  })
  expect(response.status).toBe(200)
  const setCookie = response.headers.get('set-cookie') ?? ''
  const match = /dsh_admin_session=([^;]+)/u.exec(setCookie)
  expect(match).not.toBeNull()
  const body = await response.json() as { value: { csrfToken: string } }
  return { cookie: `dsh_admin_session=${match![1]}`, csrf: body.value.csrfToken }
}

describe('authorization', () => {
  it('refuses anonymous requests even from loopback', async () => {
    const { base } = await start()
    for (const path of ['/api/stats', '/api/nodes', '/api/usage/summary']) {
      const response = await fetch(`${base}${path}`)
      expect(response.status, path).toBe(401)
      await expect(response.json()).resolves.toMatchObject({ ok: false })
    }
  })

  it('answers health anonymously, without leaking anything else', async () => {
    const { base } = await start()
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, value: { listening: true } })
  })

  it('accepts the operator bearer token and never echoes it', async () => {
    const { base } = await start()
    const response = await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${OPERATOR}` } })
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain(OPERATOR)
  })

  it('does not fall back to a cookie when the bearer token is wrong', async () => {
    const { base } = await start()
    const { cookie } = await login(base)
    const response = await fetch(`${base}/api/stats`, {
      headers: { authorization: 'Bearer wrong', cookie },
    })
    expect(response.status).toBe(401)
  })
})

describe('the login page and session cookie', () => {
  it('redirects an anonymous page to /login', async () => {
    const { base } = await start()
    for (const path of ['/', '/ui']) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' })
      expect(response.status, path).toBe(303)
      expect(response.headers.get('location')).toBe('/login')
    }
  })

  it('serves the login page anonymously and the console only with a session', async () => {
    const { base } = await start()
    const loginPage = await fetch(`${base}/login`)
    expect(loginPage.status).toBe(200)
    const html = await loginPage.text()
    expect(html).not.toMatch(/demo-pass|使用示例账号/u)
    // No account name is injected or filled in: the page does not know who the
    // administrator is, and `admin init` is mentioned only as a repair instruction.
    expect(html).not.toMatch(/value="admin"/u)
    expect(html).not.toMatch(/name="username"[^>]*value=/u)

    const { cookie } = await login(base)
    const consolePage = await fetch(`${base}/ui`, { headers: { cookie } })
    expect(consolePage.status).toBe(200)
    const consoleHtml = await consolePage.text()
    expect(consoleHtml).toContain('用量统计')
    expect(consoleHtml).not.toContain('dsh.coordinator.token')
    // The idle clock is refreshed by real foreground activity, not by the poll.
    expect(consoleHtml).toContain("api('/api/auth/activity'")
    expect(consoleHtml).toContain('reportActivity')

    const script = await fetch(`${base}/ui/usage.js`)
    // Assets are public: the sign-in page loads the same stylesheet and script, and
    // neither carries data. The page itself is still gated above.
    expect(script.status).toBe(200)
    expect((await fetch(`${base}/login`)).status).toBe(200)
  })

  it('reports the session and a usable CSRF token', async () => {
    const { base } = await start()
    const anonymous = await fetch(`${base}/api/auth/me`)
    await expect(anonymous.json()).resolves.toEqual({ ok: true, value: { authenticated: false, initialized: true } })
    const { cookie, csrf } = await login(base)
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } })
    const body = await me.json() as { value: { authenticated: boolean; user: { username: string }; csrfToken: string } }
    expect(body.value.authenticated).toBe(true)
    expect(body.value.user.username).toBe('admin')
    expect(body.value.csrfToken).toBe(csrf)
  })

  it('refuses a wrong password with 401 and the same message for an unknown user', async () => {
    const { base } = await start()
    const wrong = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'admin', password: 'wrong password here' }),
    })
    expect(wrong.status).toBe(401)
    const unknown = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'nobody', password: PASSWORD }),
    })
    expect(unknown.status).toBe(401)
    const first = await wrong.json() as { error: { message: string } }
    const second = await unknown.json() as { error: { message: string } }
    expect(first.error.message).toBe(second.error.message)
  })

  it('refuses a login without an Origin, and one from another origin', async () => {
    const { base } = await start()
    const missing = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    })
    expect(missing.status).toBe(400)
    const foreign = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    })
    expect(foreign.status).toBe(400)
  })

  it('requires Origin and CSRF on a cookie-authenticated write', async () => {
    const { base } = await start()
    const { cookie, csrf } = await login(base)
    const noCsrf = await fetch(`${base}/api/enrollment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base },
      body: JSON.stringify({ token: 'enrollment-secret' }),
    })
    expect(noCsrf.status).toBe(400)
    const noOrigin = await fetch(`${base}/api/enrollment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ token: 'enrollment-secret' }),
    })
    expect(noOrigin.status).toBe(400)
    const accepted = await fetch(`${base}/api/enrollment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base, 'x-csrf-token': csrf },
      body: JSON.stringify({ token: 'enrollment-secret' }),
    })
    expect(accepted.status).toBe(200)
  })

  it('logs out and immediately invalidates the cookie', async () => {
    const { base } = await start()
    const { cookie, csrf } = await login(base)
    const logout = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base, 'x-csrf-token': csrf },
      body: '{}',
    })
    expect(logout.status).toBe(200)
    const after = await fetch(`${base}/api/stats`, { headers: { cookie } })
    expect(after.status).toBe(401)
  })

  it('changes the password and revokes the session', async () => {
    const { base, coordinator } = await start()
    const { cookie, csrf } = await login(base)
    const change = await fetch(`${base}/api/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base, 'x-csrf-token': csrf },
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'another long passphrase' }),
    })
    expect(change.status).toBe(200)
    await expect(change.json()).resolves.toMatchObject({ ok: true, value: { reauthenticate: true } })
    const after = await fetch(`${base}/api/stats`, { headers: { cookie } })
    expect(after.status).toBe(401)
    // The new password works.
    const relogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'admin', password: 'another long passphrase' }),
    })
    expect(relogin.status).toBe(200)
    void coordinator
  })
})

describe('the in-memory (--no-state-file) mode', () => {
  it('refuses management login instead of inventing an anonymous bootstrap', async () => {
    const coordinator = new Coordinator({ port: 0, apiToken: OPERATOR, logger: silentLogger, shutdownGraceMs: 200 })
    coordinators.push(coordinator)
    const address = await coordinator.start()
    const base = `http://127.0.0.1:${address.port}`

    const page = await fetch(`${base}/login`)
    expect(page.status).toBe(503)
    expect(await page.text()).toContain('管理登录不可用')

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    })
    expect(login.status).toBe(503)
    await expect(login.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/auth-uninitialized' },
    })

    // The machine API still works with its bearer token, and still needs one.
    expect((await fetch(`${base}/api/stats`)).status).toBe(401)
    expect((await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${OPERATOR}` } })).status).toBe(200)
    // Usage reporting is off, not silently empty.
    const usage = await fetch(`${base}/api/usage/summary`, { headers: { authorization: `Bearer ${OPERATOR}` } })
    expect(usage.status).toBe(500)
    await expect(usage.json()).resolves.toMatchObject({ ok: false, error: { code: 'coordinator/storage-unavailable' } })
  })
})

describe('the usage API', () => {
  it('answers with server-side aggregates and Decimal strings', async () => {
    const running = await start()
    seed(running, { attemptId: 'a', startedAt: '2026-10-23T02:00:00.000Z' })
    seed(running, { attemptId: 'b', startedAt: '2026-10-23T03:00:00.000Z', state: 'failed', usageReported: false, known: '0' })
    const response = await fetch(
      `${running.base}/api/usage/summary?from=2026-10-22T00:00:00%2B08:00&to=2026-10-24T00:00:00%2B08:00`,
      { headers: { authorization: `Bearer ${OPERATOR}` } },
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { value: { totals: Record<string, string>; byModel: unknown[] } }
    expect(body.value.totals.requestCount).toBe('2')
    expect(body.value.totals.knownTokens).toBe('10')
    expect(body.value.totals.unknownUsageCount).toBe('1')
    expect(typeof body.value.totals.knownTokens).toBe('string')
    expect(body.value.byModel).toHaveLength(1)
  })

  it('refuses a bad range, an unknown node, and a bad grain', async () => {
    const running = await start()
    const headers = { authorization: `Bearer ${OPERATOR}` }
    const tooLong = await fetch(
      `${running.base}/api/usage/summary?from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
      { headers },
    )
    expect(tooLong.status).toBe(400)
    const unknownNode = await fetch(`${running.base}/api/usage/nodes?nodeId=ghost`, { headers })
    expect(unknownNode.status).toBe(404)
    const badGrain = await fetch(`${running.base}/api/usage/series?grain=week`, { headers })
    expect(badGrain.status).toBe(400)
  })

  it('serves the request ledger with a working cursor', async () => {
    const running = await start()
    for (let index = 0; index < 5; index += 1) {
      seed(running, { attemptId: `a${index}`, startedAt: `2026-10-23T0${index}:00:00.000Z` })
    }
    const headers = { authorization: `Bearer ${OPERATOR}` }
    const first = await fetch(
      `${running.base}/api/usage/requests?limit=2&from=2026-10-22T00:00:00%2B08:00&to=2026-10-24T00:00:00%2B08:00`,
      { headers },
    )
    const body = await first.json() as { value: { items: unknown[]; nextCursor: string | null } }
    expect(body.value.items).toHaveLength(2)
    expect(body.value.nextCursor).not.toBeNull()
    const second = await fetch(
      `${running.base}/api/usage/requests?limit=2&cursor=${encodeURIComponent(body.value.nextCursor ?? '')}&from=2026-10-22T00:00:00%2B08:00&to=2026-10-24T00:00:00%2B08:00`,
      { headers },
    )
    const next = await second.json() as { value: { items: { attemptId: string }[] } }
    expect(next.value.items).toHaveLength(2)
    expect(next.value.items[0]?.attemptId).not.toBe('a4')
  })

  it('accepts an administrator session as well as a bearer token', async () => {
    const running = await start()
    seed(running, { attemptId: 'a', startedAt: '2026-10-23T02:00:00.000Z' })
    const { cookie } = await login(running.base)
    const response = await fetch(`${running.base}/api/usage/summary`, { headers: { cookie } })
    expect(response.status).toBe(200)
  })
})
