/**
 * The read-only session views.
 *
 * These are the only routes in this service that name a business endpoint, so the
 * tests below are mostly about the boundary of that concession: the wrapper
 * argument is the only thing this service adds to a call, the request object is the
 * caller's verbatim, the node stays the authority on what exists, and the endpoint
 * names come from configuration rather than from a constant baked into the code.
 *
 * @module dsh-coordinator/test/session-views
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Coordinator, type CoordinatorOptions } from '../src/server.js'
import type { CoordinatorError } from '../src/errors.js'
import { silentLogger } from '../src/log.js'
import type { NodeCapabilitySummary } from '../src/protocol.js'
import { connectFakeNode, settle, waitFor, type FakeNodeClient, type SentFrame } from './helpers.js'

const TOKEN = 'session-view-token'
const NODE_ID = 'node-with-sessions'

/**
 * A surface that has the session Remotes plus one unrelated pair.
 *
 * Advertised explicitly instead of using the shared sample: the Coordinator
 * refuses an endpoint a node never mentioned, so a view test has to say what the
 * node serves — which is itself the behaviour under test.
 */
const VIEW_CAPABILITIES: NodeCapabilitySummary = {
  remotes: [
    { endpoint: 'session/list', mode: 'unary' },
    { endpoint: 'session/page', mode: 'unary' },
    { endpoint: 'demo/echo', mode: 'unary' },
    { endpoint: 'demo/tick', mode: 'stream' },
  ],
  remoteSurfaceHash: 'session-view-surface',
  namespaces: ['demo', 'session'],
}

/** A settled outcome, with handlers attached at creation time. */
type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CoordinatorError }

/** Await a promise without ever leaving a rejection unhandled. */
function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    value => ({ ok: true as const, value }),
    (error: CoordinatorError) => ({ ok: false as const, error }),
  )
}

/** One `rpc.request` the node received. */
interface ReceivedRequest {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
}

/** Everything a test has to clean up. */
interface Fixture {
  readonly coordinator: Coordinator
  readonly node: FakeNodeClient
  readonly nodeId: string
  readonly port: number
  /** Every `rpc.request` the node received, in order. */
  readonly requests: ReceivedRequest[]
  /** Answer the next request with this value. */
  answer(value: unknown): void
  /** Answer the next request with this failure. */
  fail(code: string, message: string): void
  stop(): Promise<void>
}

/** Start a Coordinator with one enrolled, ready fake node attached. */
async function createFixture(options: CoordinatorOptions = {}): Promise<Fixture> {
  const coordinator = new Coordinator({
    port: 0,
    enrollment: { kind: 'shared-secret', token: TOKEN },
    handshakeTimeoutMs: 2_000,
    heartbeatIntervalMs: 30_000,
    // These tests assert on the wire, not on the log; keeping the default logger
    // would bury a real failure in per-fixture noise.
    logger: silentLogger,
    ...options,
  })
  const address = await coordinator.start()
  const node = await connectFakeNode(address.url, { nodeId: NODE_ID, token: TOKEN })
  await node.handshake({ capabilities: VIEW_CAPABILITIES })
  await waitFor(() => coordinator.listNodes().some(view => view.state === 'ready'), {
    timeoutMs: 3_000,
    label: 'the node to be ready',
  })

  const requests: ReceivedRequest[] = []
  let outcome: unknown
  let hasOutcome = false

  // A request pump: record what arrived, then answer with whatever the test set.
  const pump = async (): Promise<void> => {
    for (;;) {
      const frame: SentFrame = await node.next('rpc.request', 5_000)
      requests.push({
        endpoint: frame['endpoint'] as string,
        args: (frame['payload'] as { args: Record<string, unknown> }).args,
      })
      while (!hasOutcome) await settle(1)
      const answer = outcome as
        | { readonly ok: true; readonly value: unknown }
        | { readonly ok: false; readonly code: string; readonly message: string }
      hasOutcome = false
      outcome = undefined
      node.send({
        type: 'rpc.result',
        nodeId: NODE_ID,
        requestId: frame['requestId'],
        result: answer.ok
          ? { ok: true, value: answer.value }
          : { ok: false, error: { code: answer.code, message: answer.message, details: {} } },
      })
    }
  }
  void pump().catch(() => {
    // The pump ends when the fixture's socket closes; nothing to report.
  })

  return {
    coordinator,
    node,
    nodeId: NODE_ID,
    port: address.port,
    requests,
    answer: (value) => { outcome = { ok: true, value }; hasOutcome = true },
    fail: (code, message) => { outcome = { ok: false, code, message }; hasOutcome = true },
    stop: async () => {
      node.destroy()
      await coordinator.stop()
    },
  }
}

const fixtures: Fixture[] = []

/** Build a fixture and remember it for teardown. */
async function fixture(options: CoordinatorOptions = {}): Promise<Fixture> {
  const created = await createFixture(options)
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const created of fixtures.splice(0, fixtures.length)) await created.stop()
})

/** Call the operator API and return the envelope. */
async function api(port: number, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, body: await response.json() }
}

describe('the session views against a real node connection', () => {
  it('wraps the caller request under the configured argument and returns the node answer', async () => {
    const created = await fixture()
    created.answer({ items: [{ sessionId: 's-1' }], cursor: null })

    const call = settled(created.coordinator.listSessions(created.nodeId, { cursor: 'page-2' }))
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })

    expect(created.requests[0]?.endpoint).toBe('session/list')
    // The wrapper is the only thing this service adds; the caller's object is
    // otherwise untouched, because its shape belongs to the node's Remote.
    expect(created.requests[0]?.args).toEqual({ _request: { cursor: 'page-2' } })
    expect(await call).toEqual({ ok: true, value: { items: [{ sessionId: 's-1' }], cursor: null } })
  })

  it('sends an empty request object when the caller has no filters', async () => {
    const created = await fixture()
    created.answer({ items: [] })

    const call = settled(created.coordinator.listSessions(created.nodeId))
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })

    // `session/list` accepts `{_request: {}}`; sending no argument at all would be
    // refused by the node's exact-argument check.
    expect(created.requests[0]?.args).toEqual({ _request: {} })
    expect(await call).toEqual({ ok: true, value: { items: [] } })
  })

  it('reads a session page through the page endpoint', async () => {
    const created = await fixture()
    created.answer({ messages: [] })

    const call = settled(created.coordinator.pageSessions(created.nodeId, { sessionId: 's-1', limit: 10 }))
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })

    expect(created.requests[0]?.endpoint).toBe('session/page')
    // `request`, not `_request`: the node's descriptor names this parameter
    // differently from `session/list`'s. Sharing one name across both views is what
    // made this route fail on a real node while every test still passed.
    expect(created.requests[0]?.args).toEqual({ request: { sessionId: 's-1', limit: 10 } })
    expect(await call).toEqual({ ok: true, value: { messages: [] } })
  })

  it('keeps the node failure code when the node refuses the view', async () => {
    const created = await fixture()
    created.fail('session/not-found', 'no such session')

    const call = settled(created.coordinator.pageSessions(created.nodeId, { sessionId: 'ghost' }))
    const outcome = await call
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? undefined : outcome.error.code).toBe('session/not-found')
    expect(outcome.ok ? undefined : outcome.error.message).toBe('no such session')
  })

  it('refuses a request that is not an object before sending anything', async () => {
    const created = await fixture()

    const outcome = await settled(created.coordinator.listSessions(created.nodeId, [1, 2]))
    expect(outcome.ok ? undefined : outcome.error.code).toBe('coordinator/invalid-arguments')
    await settle()
    expect(created.requests).toEqual([])
  })

  it('fails an unregistered node and an offline node without sending a frame', async () => {
    const created = await fixture()

    const unknown = await settled(created.coordinator.listSessions('ghost', {}))
    expect(unknown.ok ? undefined : unknown.error.code).toBe('coordinator/node-unknown')

    created.node.destroy()
    await waitFor(() => created.coordinator.listNodes()[0]?.state === 'offline', {
      timeoutMs: 3_000,
      label: 'the node to go offline',
    })
    const offline = await settled(created.coordinator.listSessions(created.nodeId, {}))
    expect(offline.ok ? undefined : offline.error.code).toBe('coordinator/node-offline')
    expect(created.requests).toEqual([])
  })

  it('takes the endpoint names from configuration', async () => {
    const created = await fixture({ sessions: { listEndpoint: 'demo/echo', listRequestArgument: 'query' } })
    created.answer({ items: [] })

    const call = settled(created.coordinator.listSessions(created.nodeId, { limit: 1 }))
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })

    expect(created.requests[0]?.endpoint).toBe('demo/echo')
    expect(created.requests[0]?.args).toEqual({ query: { limit: 1 } })
    expect(await call).toEqual({ ok: true, value: { items: [] } })
  })

  it('rejects a misconfigured endpoint name at construction', () => {
    expect(() => new Coordinator({ port: 0, sessions: { listEndpoint: 'notanendpoint' } })).toThrow(
      /<namespace>\/<method>/u,
    )
    expect(() => new Coordinator({ port: 0, sessions: { requestArgument: '  ' } })).toThrow(/must not be empty/u)
    expect(() => new Coordinator({ port: 0, sessions: { pageRequestArgument: '' } })).toThrow(/must not be empty/u)
  })
})

describe('the session views over HTTP', () => {
  it('answers GET /api/sessions with the node value', async () => {
    const created = await fixture()
    created.answer({ items: [{ sessionId: 's-1' }] })

    const call = api(created.port, '/api/sessions?nodeId=node-with-sessions&request=%7B%22cursor%22%3A%22p2%22%7D')
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })
    const { status, body } = await call

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { items: [{ sessionId: 's-1' }] } })
    expect(created.requests[0]?.args).toEqual({ _request: { cursor: 'p2' } })
  })

  it('answers GET /api/sessions with no request parameter at all', async () => {
    const created = await fixture()
    created.answer({ items: [] })

    const call = api(created.port, '/api/sessions?nodeId=node-with-sessions')
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })
    const { body } = await call

    expect(body).toEqual({ ok: true, value: { items: [] } })
    expect(created.requests[0]?.args).toEqual({ _request: {} })
  })

  it('answers POST /api/session/page with the caller body', async () => {
    const created = await fixture()
    created.answer({ messages: [] })

    const call = api(created.port, '/api/session/page', {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'node-with-sessions', request: { sessionId: 's-9' } }),
    })
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })
    const { status, body } = await call

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { messages: [] } })
    expect(created.requests[0]?.endpoint).toBe('session/page')
    expect(created.requests[0]?.args).toEqual({ request: { sessionId: 's-9' } })
  })

  it('returns the node failure code as data with HTTP 200', async () => {
    const created = await fixture()
    created.fail('session/not-found', 'gone')

    const { status, body } = await api(created.port, '/api/session/page', {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'node-with-sessions', request: { sessionId: 'ghost' } }),
    })

    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('session/not-found')
  })

  it('rejects a malformed request parameter without calling the node', async () => {
    const created = await fixture()

    const { status, body } = await api(created.port, '/api/sessions?nodeId=node-with-sessions&request=%5B1%5D')
    expect(status).toBe(400)
    expect(body.error.code).toBe('coordinator/invalid-arguments')
    expect(created.requests).toEqual([])
  })

  it('is not installed at all when disabled', async () => {
    const created = await fixture({ sessions: { enabled: false } })

    const { status } = await api(created.port, '/api/sessions?nodeId=node-with-sessions')
    expect(status).toBe(404)
    const outcome = await settled(created.coordinator.listSessions(created.nodeId, {}))
    expect(outcome.ok ? undefined : outcome.error.code).toBe('coordinator/invalid-arguments')
    expect(created.requests).toEqual([])
  })
})
