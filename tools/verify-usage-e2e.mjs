/**
 * End-to-end verification for the admin console and node usage.
 *
 * This is deliberately an **isolated** script: it creates its own temporary database,
 * administrator, nodes and usage rows, binds an ephemeral loopback port, drives a
 * headless Chrome over the DevTools protocol, and deletes everything on the way out.
 * It never reads a real deployment's credentials and never touches a real profile.
 *
 * What it proves, in the order it proves it:
 *
 * 1. a legacy `coordinator-state.json` is migrated into SQLite once, with the node
 *    tokens and the operator token unchanged and a backup left behind;
 * 2. the management API refuses anonymous callers and accepts a session cookie;
 * 3. the rendered overview and node detail show server-side aggregates;
 * 4. a node backlog can be replayed after a lost ACK without double counting.
 *
 * Run with the built package:
 *
 *   node tools/verify-usage-e2e.mjs [--out docs/screenshots]
 *
 * The JSON summary printed at the end is the machine-readable evidence; the PNGs
 * beside it are the visual evidence.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import {
  AuthService,
  Coordinator,
  UsageRepository,
  openCoordinatorDatabase,
} from '../lib/index.js'
import { NodeUsageOwner, NodeUsageStore } from 'dsh-node'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

const ADMIN = 'admin'
const ADMIN_PASSWORD = 'verification-only passphrase'
const LEGACY_OPERATOR = 'legacy-operator-token'
const LEGACY_ENROLLMENT = 'legacy-enrollment-secret'
/** Node ids and tokens that the legacy document must bring across unchanged. */
const LEGACY_TOKENS = {
  'node-alpha': 'alpha-token',
  'node-beta': 'beta-token',
  'node-revoked': 'revoked-token',
}
const OUT_DIR = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : join(process.cwd(), 'docs', 'screenshots')

const summary = {
  startedAt: new Date().toISOString(),
  node: process.version,
  sqlite: null,
  migration: null,
  auth: null,
  usage: null,
  backfill: null,
  screenshots: [],
  widths: {},
  errors: [],
}

/** Abort with a readable message rather than a stack nobody will read. */
function fail(message) {
  summary.errors.push(message)
  throw new Error(message)
}

/** A minimal CDP client over one page target. */
class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()
  #waiters = []

  static async connect(url) {
    const client = new Cdp()
    client.#socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      client.#socket.once('open', resolve)
      client.#socket.once('error', reject)
    })
    client.#socket.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.id !== undefined) {
        const pending = client.#pending.get(message.id)
        if (pending === undefined) return
        client.#pending.delete(message.id)
        if (message.error !== undefined) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      for (const waiter of [...client.#waiters]) {
        if (waiter.method === message.method) {
          client.#waiters.splice(client.#waiters.indexOf(waiter), 1)
          waiter.resolve(message.params)
        }
      }
    })
    return client
  }

  send(method, params = {}) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  waitFor(method, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve }
      this.#waiters.push(waiter)
      setTimeout(() => {
        const index = this.#waiters.indexOf(waiter)
        if (index >= 0) this.#waiters.splice(index, 1)
        reject(new Error(`timed out waiting for ${method}`))
      }, timeoutMs)
    })
  }

  close() {
    this.#socket.close()
  }
}

/** Start headless Chrome and connect to its first page target. */
async function startChrome(profile, port) {
  const binary = CHROME_CANDIDATES.find(candidate => existsSync(candidate))
  if (binary === undefined) fail('no Chrome or Edge binary was found for screenshots')
  const child = spawn(binary, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find(target => target.type === 'page')
      if (page !== undefined) return { child, cdp: await Cdp.connect(page.webSocketDebuggerUrl) }
    } catch {
      // Chrome is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  child.kill()
  fail('Chrome did not expose a debugging target in time')
}

/** Wait for a page to settle enough for a screenshot. */
async function settle(cdp, ms = 1_200) {
  await cdp.send('Runtime.enable')
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Capture the current page to a PNG. */
async function capture(cdp, file) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(file, Buffer.from(result.data, 'base64'))
  summary.screenshots.push({ file, bytes: (await stat(file)).size })
}

/** Count the rows the usage table rendered, via the page's own DOM. */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

/** Seed the usage rows the screenshots will show. */
function seedUsage(db, nodes) {
  const now = Date.now()
  const day = 86_400_000
  const models = [
    ['deepseek-official', 'deepseek-v4-flash'],
    ['deepseek-official', 'deepseek-v4-pro'],
    ['pi-ai', 'gpt-5-mini'],
  ]
  const insert = db.prepare(
    `INSERT INTO usage_attempts
       (node_id, collector_id, attempt_id, revision_seq, started_at, ended_at, provider, model, session_id,
        purpose, state, usage_reported, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens, total_tokens, known_tokens)
     VALUES (?, 'collector-verify', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let attempt = 0
  for (const node of nodes) {
    for (let index = 0; index < 24; index += 1) {
      const [provider, model] = models[index % models.length]
      const started = new Date(now - (index % 7) * day - (index % 5) * 3_600_000).toISOString()
      const failed = index % 11 === 0
      const unknown = index % 9 === 0
      const input = unknown ? null : String(1_200 + index * 37)
      const cacheRead = unknown ? null : String(4_800 + index * 91)
      const cacheWrite = unknown ? null : '0'
      const output = unknown ? null : String(240 + index * 11)
      const total = unknown ? null : String(Number(input) + Number(cacheRead) + Number(cacheWrite) + Number(output))
      const known = unknown ? '0' : total
      insert.run(
        node,
        `attempt-${node}-${attempt++}`,
        started,
        started,
        provider,
        model,
        `session-${index % 4}`,
        index % 13 === 0 ? 'compaction' : index % 17 === 0 ? 'session-title' : 'conversation',
        failed ? 'failed' : 'completed',
        unknown ? 0 : 1,
        input,
        cacheRead,
        cacheWrite,
        output,
        unknown ? null : String(Math.floor(Number(output) / 3)),
        total,
        known,
      )
    }
    db.prepare(
      `INSERT INTO usage_sync_state
         (node_id, collector_id, cursor_seq, last_synced_at, last_error, coverage, pending_count, pending_bytes, started_at)
       VALUES (?, 'collector-verify', 48, ?, NULL, 'complete', 0, 0, ?)`,
    ).run(node, new Date(now - 30_000).toISOString(), new Date(now - 8 * day).toISOString())
  }
  // One honest gap, so the UI has to explain incomplete coverage rather than draw a
  // zero.
  db.prepare(
    `INSERT INTO usage_gaps (node_id, collector_id, from_at, to_at, reason, detected_at)
     VALUES (?, 'collector-verify', ?, ?, 'storage-failure', ?)`,
  ).run(nodes[0], new Date(now - 3 * day).toISOString(), new Date(now - 3 * day + 900_000).toISOString(), new Date(now - 2 * day).toISOString())
}

/** Verify a node backlog survives a lost ACK and replays without double counting. */
async function verifyBackfill(queueFile, coordinatorDb) {
  const store = NodeUsageStore.open({ file: queueFile, nodeId: 'node-offline' })
  const owner = new NodeUsageOwner({ store })
  for (let index = 0; index < 3; index += 1) {
    store.appendAttempt({
      attemptId: `offline-${index}`,
      startedAt: new Date(Date.now() - 60_000 + index * 1_000).toISOString(),
      endedAt: new Date(Date.now() - 59_000 + index * 1_000).toISOString(),
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      sessionId: 'offline-session',
      purpose: 'conversation',
      state: 'completed',
      usageReported: true,
      usage: {
        uncachedInputTokens: '100',
        cacheReadTokens: '200',
        cacheWriteTokens: '0',
        outputTokens: '50',
        reasoningTokens: null,
        totalTokens: '350',
      },
      source: 'runtime',
    })
  }
  const repository = new UsageRepository({ db: coordinatorDb })
  const collectorId = store.collectorId
  const batch = owner.read({ collectorId, afterSeq: '0', limit: 200, maxBytes: 262_144 })
  const first = repository.ingest('node-offline', batch)
  // The ACK is "lost": the same page is offered again by the same cursor.
  const second = repository.ingest('node-offline', batch)
  // And only now acknowledged, twice, because the first ACK may also be lost.
  owner.ack({ collectorId, throughSeq: first.ackThroughSeq })
  owner.ack({ collectorId, throughSeq: second.ackThroughSeq })
  store.close()
  const row = coordinatorDb.prepare(
    "SELECT COUNT(*) AS count, COALESCE(SUM(known_tokens), 0) AS tokens FROM usage_attempts WHERE node_id = 'node-offline'",
  ).get()
  return {
    eventsInBatch: batch.events.length,
    firstInserted: first.inserted,
    replayedInserted: second.inserted,
    replayedDuplicates: second.duplicates,
    storedAttempts: Number(row.count),
    storedTokens: String(row.tokens),
    collectedBeforeReconnect: batch.events.length,
  }
}

/** Run the whole verification. */
async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-verify-e2e-'))
  const dbFile = join(workspace, 'coordinator.sqlite')
  const legacyFile = join(workspace, 'coordinator-state.json')
  await mkdir(OUT_DIR, { recursive: true })

  // ---------------------------------------------------------------- migration
  await writeFile(legacyFile, JSON.stringify({
    version: 1,
    apiToken: LEGACY_OPERATOR,
    enrollment: { kind: 'shared-secret', token: LEGACY_ENROLLMENT },
    nodes: [
      { nodeId: 'node-alpha', token: 'alpha-token', nodeName: '工作站 Alpha', role: 'worker' },
      { nodeId: 'node-beta', token: 'beta-token', nodeName: '构建机 Beta', role: 'worker' },
      { nodeId: 'node-revoked', token: 'revoked-token', nodeName: '已撤销', revokedAt: '2026-01-01T00:00:00.000Z' },
    ],
  }, null, 2), 'utf8')

  const coordinator = new Coordinator({
    port: 0,
    host: '127.0.0.1',
    dbFile,
    logger: { level: 'error', traceFrames: false, info() {}, warn() {}, error() {}, debug() {} },
  })
  const database = coordinator.database
  const auth = new AuthService({
    db: database.db,
    kdf: { N: 1_024, r: 8, p: 1, keylen: 32 },
  })
  await auth.initAdmin(ADMIN, ADMIN_PASSWORD)

  /*
    Start before registering the offline node.

    `start()` is what runs the legacy import, and the import refuses to run into a
    database that already has nodes — deliberately, because two sources of truth for
    one credential is a coin flip. Registering first would therefore trip that guard,
    which is the correct behaviour and the reason the order is this way.
  */
  const address = await coordinator.start()
  const base = `http://127.0.0.1:${address.port}`
  // Registered after migration so the offline node's replayed backlog has a row in
  // the node table as well as in the totals.
  coordinator.addNode({ nodeId: 'node-offline', token: 'offline-token', nodeName: '离线补传节点' })
  summary.sqlite = { driver: database.driver, schemaVersion: database.schemaVersion, file: database.file }
  summary.migration = {
    backupExists: existsSync(`${legacyFile}.migrated.bak`),
    legacyFileGone: !existsSync(legacyFile),
    // Only the three records that came from the JSON are compared; node-offline is
    // registered by this script afterwards and is not part of the migration.
    nodes: coordinator.registry.records()
      .filter(record => LEGACY_TOKENS[record.nodeId] !== undefined)
      .map(record => ({
        nodeId: record.nodeId,
        tokenUnchanged: record.token === LEGACY_TOKENS[record.nodeId],
        revoked: record.revokedAt !== undefined,
      })),
    operatorTokenFromLegacy: coordinator.operatorTokenConfigured,
    enrollmentOpen: coordinator.enrollmentOpen,
  }

  // ------------------------------------------------------------------- usage
  seedUsage(database.db, ['node-alpha', 'node-beta'])
  const cookieLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: ADMIN, password: ADMIN_PASSWORD }),
  })
  if (cookieLogin.status !== 200) fail(`login failed with ${cookieLogin.status}`)
  const setCookie = cookieLogin.headers.get('set-cookie') ?? ''
  const cookieValue = /dsh_admin_session=([^;]+)/u.exec(setCookie)?.[1]
  if (cookieValue === undefined) fail('login did not set a session cookie')
  const loginBody = await cookieLogin.json()

  const from = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const to = new Date(Date.now() + 86_400_000).toISOString()
  const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&timezone=Asia%2FShanghai`
  const anonymous = await fetch(`${base}/api/usage/summary?${query}`)
  const summaryResponse = await fetch(`${base}/api/usage/summary?${query}`, { headers: { cookie: `dsh_admin_session=${cookieValue}` } })
  const summaryBody = await summaryResponse.json()
  summary.auth = {
    anonymousStatus: anonymous.status,
    cookieStatus: summaryResponse.status,
    csrfTokenLength: String(loginBody.value.csrfToken).length,
  }
  summary.usage = {
    requestCount: summaryBody.value.totals.requestCount,
    knownTokens: summaryBody.value.totals.knownTokens,
    unknownUsageCount: summaryBody.value.totals.unknownUsageCount,
    bucketUnknowns: summaryBody.value.totals.bucketUnknownCounts,
    coverage: summaryBody.value.coverage,
    gapCount: summaryBody.value.gapCount,
    models: summaryBody.value.byModel.length,
  }

  // --------------------------------------------------------------- backfill
  summary.backfill = await verifyBackfill(join(workspace, 'node-usage.sqlite'), database.db)

  // -------------------------------------------------------------- screenshots
  const profile = join(workspace, 'chrome-profile')
  const chrome = await startChrome(profile, 19_322)
  const cdp = chrome.cdp
  try {
    await cdp.send('Page.enable')
    await cdp.send('Network.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })

    // The sign-in page, unauthenticated.
    await cdp.send('Page.navigate', { url: `${base}/login` })
    await settle(cdp, 900)
    await capture(cdp, join(OUT_DIR, 'login-1024.png'))

    // Authenticate the page context with the session the API accepted.
    await cdp.send('Network.setCookie', {
      name: 'dsh_admin_session',
      value: cookieValue,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
    })

    await cdp.send('Page.navigate', { url: `${base}/ui` })
    await settle(cdp, 1_500)
    await evaluate(cdp, "document.getElementById('view-usage').click()")
    await settle(cdp, 1_800)

    for (const [label, width] of [['1024', 1024], ['736', 736], ['320', 320]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 })
      await settle(cdp, 700)
      const overflow = await evaluate(cdp, 'document.documentElement.scrollWidth - window.innerWidth')
      const offenders = await evaluate(cdp, `(() => {
        const limit = window.innerWidth + 1
        return [...document.querySelectorAll('body *')]
          .filter(element => element.getBoundingClientRect().right > limit)
          .slice(0, 8)
          .map(element => element.id ? '#' + element.id : (typeof element.className === 'string' && element.className ? '.' + element.className.split(' ')[0] : element.tagName.toLowerCase()))
      })()`)
      summary.widths[label] = { overflowPixels: overflow, offenders }
      await capture(cdp, join(OUT_DIR, `usage-overview-${label}.png`))
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false })
    const clicked = await evaluate(cdp, `(() => {
      const row = document.querySelector('#usage-view tbody tr.u-row')
      if (row === null) return false
      row.click()
      return true
    })()`)
    if (clicked !== true) fail('the node table rendered no rows to open')
    await settle(cdp, 1_800)
    await capture(cdp, join(OUT_DIR, 'usage-detail-1024.png'))
  } finally {
    cdp.close()
    chrome.child.kill()
  }

  await coordinator.stop()
  summary.finishedAt = new Date().toISOString()
  console.log(JSON.stringify(summary, null, 2))
  // Chrome may still hold its profile files for a moment after exit; a failed
  // cleanup must not turn a successful verification into an error.
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ...summary, errors: [...summary.errors, String(error && error.stack ? error.stack : error)] }, null, 2))
  process.exitCode = 1
})
