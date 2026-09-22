/**
 * The session call surface: `session/create`, `session/prompt`, `session/follow`.
 *
 * Two things are under test here, and they fail in different ways:
 *
 * - the **builders**, which shape a request object. Their job is to match a Remote
 *   descriptor on another machine, so the assertions are about exact wire fields —
 *   a wrong wrapper name is not a subtle bug, it is a `gateway/arguments-invalid`
 *   from a node that never ran the method.
 * - the **routing**, which has to pick the right endpoint and the right wrapper for
 *   each call. `session/list` and `session/page` disagree about their argument name
 *   on the real node, so a shared default would be wrong for one of them.
 *
 * @module dsh-coordinator/test/session-api
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCreateRequest,
  buildFollowRequest,
  buildPromptRequest,
  resolveSessionsOptions,
  DEFAULT_SESSION_LIST_ARGUMENT,
  DEFAULT_SESSION_PAGE_ARGUMENT,
  DEFAULT_SESSION_REQUEST_ARGUMENT,
  type PromptMode,
} from '../src/sessions.js'
import { Coordinator, type CoordinatorOptions } from '../src/server.js'
import type { CoordinatorError } from '../src/errors.js'
import { silentLogger } from '../src/log.js'
import type { NodeCapabilitySummary } from '../src/protocol.js'
import { connectFakeNode, settle, waitFor, type FakeNodeClient, type SentFrame } from './helpers.js'

const TOKEN = 'session-api-token'
const NODE_ID = 'node-with-session-api'

/** A surface with every session Remote this service knows, plus a stream. */
const CAPABILITIES: NodeCapabilitySummary = {
  remotes: [
    { endpoint: 'session/list', mode: 'unary' },
    { endpoint: 'session/page', mode: 'unary' },
    { endpoint: 'session/create', mode: 'unary' },
    { endpoint: 'session/prompt', mode: 'unary' },
    { endpoint: 'session/follow', mode: 'stream' },
  ],
  remoteSurfaceHash: 'session-api-surface',
  namespaces: ['session'],
}

// ------------------------------------------------------------ pure builders

describe('the session request builders', () => {
  /** A deterministic request-id generator, so assertions can name the value. */
  const promptOptions = { defaultMode: 'queue' as PromptMode, generateRequestId: () => 'p-1' }

  it('omits absent fields instead of sending undefined', () => {
    // The node validates arguments exactly: a key present with `undefined` is a
    // different payload from a key that was never sent, and only one of them passes.
    expect(buildCreateRequest({})).toEqual({})
    expect(buildCreateRequest({ cwd: 'C:\\work' })).toEqual({ cwd: 'C:\\work' })
    expect(buildFollowRequest({ sessionId: 's-1' })).toEqual({ address: { kind: 'session', sessionId: 's-1' } })
  })

  it('expands a plain text prompt into the node\'s tagged content array', () => {
    const request = buildPromptRequest({ sessionId: 's-1', text: 'hello' }, promptOptions)
    expect(request).toEqual({
      requestId: 'p-1',
      sessionId: 's-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    })
  })

  it('does not expand a pre-built content array', () => {
    // The escape hatch has to stay open: an image or file part is not expressible
    // through `text`, and rewriting the caller's array would break it silently.
    const content = [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]
    const request = buildPromptRequest({ sessionId: 's-1', content }, promptOptions)
    expect(request['content']).toBe(content)
  })

  it('lets a verbatim request win over every convenience field', () => {
    expect(buildCreateRequest({ cwd: 'ignored', request: { cwd: 'verbatim' } })).toEqual({ cwd: 'verbatim' })
    expect(buildPromptRequest({ sessionId: 'ignored', request: { sessionId: 'verbatim' } }, promptOptions)).toEqual({
      sessionId: 'verbatim',
    })
    expect(buildFollowRequest({ sessionId: 'ignored', request: { address: { kind: 'session' } } })).toEqual({
      address: { kind: 'session' },
    })
  })

  it('builds a session address from a bare session id', () => {
    expect(buildFollowRequest({ sessionId: 's-9', maxMessages: 50, assistantStream: true })).toEqual({
      address: { kind: 'session', sessionId: 's-9' },
      maxMessages: 50,
      assistantStream: true,
    })
  })

  it('refuses a prompt with neither text nor content', () => {
    expect(() => buildPromptRequest({ sessionId: 's-1' }, promptOptions)).toThrow(/"text" must be/u)
  })

  it('refuses a follow with neither a session id nor an address', () => {
    expect(() => buildFollowRequest({})).toThrow(/"sessionId" must be/u)
  })

  it('refuses a wrong-typed optional field rather than coercing it', () => {
    expect(() => buildFollowRequest({ sessionId: 's-1', maxMessages: -1 })).toThrow(/non-negative integer/u)
    // Cast through `unknown`: the point is that a caller reaching this from JSON has
    // no type to protect them, so the runtime check is the only defence.
    const wrongType = { sessionId: 's-1', assistantStream: 'yes' } as unknown as { assistantStream: boolean }
    expect(() => buildFollowRequest(wrongType)).toThrow(/must be a boolean/u)
    expect(() => buildPromptRequest({ sessionId: 's-1', text: 'x', mode: 'loud' as PromptMode }, promptOptions))
      .toThrow(/"mode" must be "queue" or "steer"/u)
  })

  it('names the wrapper arguments differently for list and page', () => {
    // The whole point of splitting the option: the node really does disagree, and a
    // shared default silently breaks whichever route loses.
    expect(DEFAULT_SESSION_LIST_ARGUMENT).toBe('_request')
    expect(DEFAULT_SESSION_PAGE_ARGUMENT).toBe('request')
    expect(DEFAULT_SESSION_REQUEST_ARGUMENT).toBe('request')

    const resolved = resolveSessionsOptions()
    expect(resolved.listRequestArgument).not.toBe(resolved.pageRequestArgument)
    expect(resolved).toMatchObject({
      listEndpoint: 'session/list',
      pageEndpoint: 'session/page',
      createEndpoint: 'session/create',
      promptEndpoint: 'session/prompt',
      followEndpoint: 'session/follow',
      promptMode: 'queue',
    })
  })
})

// ------------------------------------------------------------ wire routing

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

interface Fixture {
  readonly coordinator: Coordinator
  readonly node: FakeNodeClient
  readonly nodeId: string
  readonly port: number
  readonly requests: ReceivedRequest[]
  /** Answer the next unary request with this value. */
  answer(value: unknown): void
  stop(): Promise<void>
}

/** Start a Coordinator with one ready fake node attached. */
async function createFixture(options: CoordinatorOptions = {}): Promise<Fixture> {
  const coordinator = new Coordinator({
    port: 0,
    enrollment: { kind: 'shared-secret', token: TOKEN },
    handshakeTimeoutMs: 2_000,
    heartbeatIntervalMs: 30_000,
    logger: silentLogger,
    ...options,
  })
  const address = await coordinator.start()
  const node = await connectFakeNode(address.url, { nodeId: NODE_ID, token: TOKEN })
  await node.handshake({ capabilities: CAPABILITIES })
  await waitFor(() => coordinator.listNodes().some(view => view.state === 'ready'), {
    timeoutMs: 3_000,
    label: 'the node to be ready',
  })

  const requests: ReceivedRequest[] = []
  let outcome: unknown
  let hasOutcome = false

  const pump = async (): Promise<void> => {
    for (;;) {
      const frame: SentFrame = await node.next('rpc.request', 5_000)
      requests.push({
        endpoint: frame['endpoint'] as string,
        args: (frame['payload'] as { args: Record<string, unknown> }).args,
      })
      while (!hasOutcome) await settle(1)
      const answer = outcome as { readonly ok: true; readonly value: unknown }
      hasOutcome = false
      outcome = undefined
      node.send({
        type: 'rpc.result',
        nodeId: NODE_ID,
        requestId: frame['requestId'],
        result: { ok: true, value: answer.value },
      })
    }
  }
  void pump().catch(() => {
    // Ends when the fixture's socket closes.
  })

  return {
    coordinator,
    node,
    nodeId: NODE_ID,
    port: address.port,
    requests,
    answer: (value) => { outcome = { ok: true, value }; hasOutcome = true },
    stop: async () => {
      node.destroy()
      await coordinator.stop()
    },
  }
}

const fixtures: Fixture[] = []

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

describe('the session call surface against a real node connection', () => {
  it('creates a session and returns the node answer', async () => {
    const created = await fixture()
    created.answer({ sessionId: 's-new' })

    const call = settled(created.coordinator.createSession(created.nodeId, { cwd: 'C:\\work' }))
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })

    expect(created.requests[0]?.endpoint).toBe('session/create')
    expect(created.requests[0]?.args).toEqual({ request: { cwd: 'C:\\work' } })
    expect(await call).toEqual({ ok: true, value: { sessionId: 's-new' } })
  })

  it('mints a request id when the caller does not supply one', async () => {
    const created = await fixture()
    created.answer({ accepted: true })

    const call = settled(created.coordinator.promptSession(created.nodeId, { sessionId: 's-1', text: 'hi' }))
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })

    const args = created.requests[0]?.args as { request: { requestId: string; mode: string; content: unknown } }
    expect(created.requests[0]?.endpoint).toBe('session/prompt')
    // `session/prompt` requires a requestId on the wire, so a caller who only wants
    // to say something must not have to invent one.
    expect(typeof args.request.requestId).toBe('string')
    expect(args.request.requestId.length).toBeGreaterThan(0)
    expect(args.request.mode).toBe('queue')
    expect(args.request.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(await call).toEqual({ ok: true, value: { accepted: true } })
  })

  it('opens a follow stream with a session address', async () => {
    const created = await fixture()

    // Armed before the call: `next` waits for a frame arriving after it, and the
    // frame is already on the wire by the time an `await` would come back.
    const opened = created.node.next('stream.open')
    const stream = created.coordinator.followSession(created.nodeId, { sessionId: 's-1' })
    const frame = await opened

    expect(frame['endpoint']).toBe('session/follow')
    expect((frame['payload'] as { args: Record<string, unknown> }).args).toEqual({
      request: { address: { kind: 'session', sessionId: 's-1' } },
    })
    // The stream is registered before the frame is sent, so a node that answers
    // immediately cannot produce a value with nowhere to land.
    expect(stream.streamId).toBe(frame['streamId'])
    created.coordinator.cancelStream(created.nodeId, stream.streamId, 'the test is done')
  })

  it('takes the wrapper arguments from configuration', async () => {
    const created = await fixture({
      sessions: { listRequestArgument: 'q', requestArgument: 'body' },
    })
    created.answer({ items: [] })

    const call = settled(created.coordinator.listSessions(created.nodeId, { limit: 1 }))
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })

    expect(created.requests[0]?.args).toEqual({ q: { limit: 1 } })
    expect(await call).toEqual({ ok: true, value: { items: [] } })
  })

  it('refuses every session call when the routes are disabled', async () => {
    const created = await fixture({ sessions: { enabled: false } })

    for (const call of [
      settled(created.coordinator.createSession(created.nodeId, {})),
      settled(created.coordinator.promptSession(created.nodeId, { sessionId: 's-1', text: 'x' })),
      settled(created.coordinator.listSessions(created.nodeId, {})),
    ]) {
      const outcome = await call
      expect(outcome.ok ? undefined : outcome.error.code).toBe('coordinator/invalid-arguments')
    }
    expect(() => created.coordinator.followSession(created.nodeId, { sessionId: 's-1' })).toThrow(
      /session routes are disabled/u,
    )
    await settle()
    expect(created.requests).toEqual([])
  })
})

describe('the session routes over HTTP', () => {
  it('answers POST /api/session/create', async () => {
    const created = await fixture()
    created.answer({ sessionId: 's-http' })

    const call = api(created.port, '/api/session/create', {
      method: 'POST',
      body: JSON.stringify({ nodeId: NODE_ID, cwd: 'C:\\work' }),
    })
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })
    const { status, body } = await call

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { sessionId: 's-http' } })
    expect(created.requests[0]?.args).toEqual({ request: { cwd: 'C:\\work' } })
  })

  it('answers POST /api/session/prompt, expanding the text', async () => {
    const created = await fixture()
    created.answer({ accepted: true })

    const call = api(created.port, '/api/session/prompt', {
      method: 'POST',
      body: JSON.stringify({ nodeId: NODE_ID, sessionId: 's-1', text: 'ping' }),
    })
    await waitFor(() => created.requests.length === 1, { label: 'the request to arrive' })
    const { status, body } = await call

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { accepted: true } })
    expect(created.requests[0]?.endpoint).toBe('session/prompt')
    const args = created.requests[0]?.args as { request: { content: unknown } }
    expect(args.request.content).toEqual([{ type: 'text', text: 'ping' }])
  })

  it('rejects a prompt with nothing to send, without calling the node', async () => {
    const created = await fixture()

    const { status, body } = await api(created.port, '/api/session/prompt', {
      method: 'POST',
      body: JSON.stringify({ nodeId: NODE_ID, sessionId: 's-1' }),
    })

    expect(status).toBe(400)
    expect(body.error.code).toBe('coordinator/invalid-arguments')
    await settle()
    expect(created.requests).toEqual([])
  })

  it('streams /api/session/follow as NDJSON', async () => {
    const created = await fixture()

    // Armed before the request: `fetch` only resolves once the server has written the
    // response head, and by then the `stream.open` frame has already been received.
    const opened = created.node.next('stream.open')
    const response = await fetch(`http://127.0.0.1:${created.port}/api/session/follow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: NODE_ID, sessionId: 's-1' }),
    })
    const streamId = (await opened)['streamId'] as string

    created.node.send({ type: 'stream.ready', nodeId: NODE_ID, streamId })
    created.node.send({
      type: 'stream.data',
      nodeId: NODE_ID,
      streamId,
      seq: 1,
      value: { type: 'event', event: { type: 'text', seq: 1, time: Date.now(), data: 'hello' } },
    })
    created.node.send({ type: 'stream.end', nodeId: NODE_ID, streamId, count: 1 })

    const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(lines[0]).toMatchObject({ type: 'open', endpoint: 'session/follow' })
    expect(lines[1]).toMatchObject({ type: 'data', value: { type: 'event' } })
    expect(lines[2]).toMatchObject({ type: 'end', count: 1 })
  })

  it('answers 404 for every session route when the routes are disabled', async () => {
    const created = await fixture({ sessions: { enabled: false } })

    for (const path of ['/api/session/create', '/api/session/prompt', '/api/session/follow', '/api/sessions']) {
      const { status } = await api(created.port, path, {
        method: 'POST',
        body: JSON.stringify({ nodeId: NODE_ID, sessionId: 's-1', text: 'x' }),
      })
      expect(status, path).toBe(404)
    }
  })

  it('serves the UI page and its asset path', async () => {
    const created = await fixture()

    const page = await fetch(`http://127.0.0.1:${created.port}/ui`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('DSH Coordinator')
    // The page is useless if it cannot reach the routes it drives.
    expect(html).toContain('/api/session/follow')

    const slashed = await fetch(`http://127.0.0.1:${created.port}/ui/`)
    expect(slashed.status).toBe(200)
  })

  it('does not serve the UI when it is turned off or sessions are disabled', async () => {
    const noUi = await fixture({ enableUi: false })
    expect((await fetch(`http://127.0.0.1:${noUi.port}/ui`)).status).toBe(404)

    const noSessions = await fixture({ sessions: { enabled: false } })
    expect((await fetch(`http://127.0.0.1:${noSessions.port}/ui`)).status).toBe(404)
  })
})
