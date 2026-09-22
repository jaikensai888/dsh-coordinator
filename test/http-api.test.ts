/**
 * The operator API: routing, authentication, body limits, the NDJSON stream
 * encoding, and the promise that no response ever carries a node credential.
 *
 * Two modes, for two different questions: a stub host drives the request layer
 * in isolation (so a routing mistake cannot hide behind a broken session), and a
 * real `Coordinator` drives the same routes end to end.
 *
 * @module dsh-coordinator/test/http-api
 */

import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { CoordinatorError } from '../src/errors.js'
import {
  allowsRemoteApi,
  createHttpApi,
  isLoopbackAddress,
  type HttpApi,
  type HttpApiHost,
  type HttpApiOptions,
} from '../src/http-api.js'
import { silentLogger } from '../src/log.js'
import type { NodeCapabilitySummary, NodeRecord, NodeView } from '../src/protocol.js'
import { Coordinator } from '../src/server.js'
import { RemoteStream } from '../src/stream-hub.js'
import { connectFakeNode, sampleCapabilities, waitFor, type FakeNodeClient } from './helpers.js'

const NODE_ID = 'node-1'
const SECRET = 'node-token-super-secret'
const OPERATOR_TOKEN = 'operator-secret'

/** A ready node, as a view would report it. */
const READY_VIEW: NodeView = {
  nodeId: NODE_ID,
  nodeName: 'Node One',
  role: 'worker',
  state: 'ready',
  connectionId: 'node-1:abc',
  connectedAt: '2024-01-01T00:00:00.000Z',
  lastSeenAt: '2024-01-01T00:00:01.000Z',
  remoteSurfaceHash: 'surface-1',
  capabilityCount: 2,
  inFlightRequests: 0,
  activeStreams: 0,
  revoked: false,
}

// ---------------------------------------------------------------- fixtures

/** A running stub API. */
interface Served {
  readonly api: HttpApi
  readonly base: string
  close(): Promise<void>
}

const servers: Served[] = []

afterEach(async () => {
  for (const running of servers.splice(0)) await running.close()
})

/** Serve one API on a loopback port for the duration of the test. */
async function serve(host: HttpApiHost, options: HttpApiOptions = {}): Promise<Served> {
  const api = createHttpApi(host, options)
  const server = createServer((request, response) => { api.handle(request, response) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => { resolve() })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    api,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      // `fetch` keeps connections alive; close them so the teardown cannot hang.
      server.closeAllConnections()
      server.close(error => { error === undefined ? resolve() : reject(error) })
    }),
  }
}

async function serveTracked(host: HttpApiHost, options: HttpApiOptions = {}): Promise<Served> {
  const running = await serve(host, options)
  servers.push(running)
  return running
}

function get(base: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { headers })
}

function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** POST a body verbatim, for the malformed-JSON case. */
function postRaw(base: string, path: string, body: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

/** One `cancelStream` the API asked the host to perform. */
interface CancelCall {
  readonly nodeId: string
  readonly streamId: string
  readonly reason: string | undefined
}

/** One `invoke` the API asked the host to perform. */
interface InvokeCall {
  readonly nodeId: string
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
}

interface StubHost extends HttpApiHost {
  readonly cancels: CancelCall[]
  readonly invoked: InvokeCall[]
  readonly streams: RemoteStream[]
  /** Every `setEnrollmentSecret` the API asked for, in order. */
  readonly enrollment: (string | null)[]
}

interface StubOptions {
  readonly nodes?: readonly NodeView[]
  readonly stats?: unknown
  readonly capabilities?: (nodeId: string) => NodeCapabilitySummary | undefined
  readonly invoke?: (nodeId: string, endpoint: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly openStream?: () => RemoteStream
  readonly addNode?: (record: NodeRecord) => NodeView
  readonly sessionViewsEnabled?: boolean
  readonly enrollmentOpen?: boolean
  readonly stateFile?: string
  readonly setEnrollmentSecret?: (secret: string | null) => void
}

/** The wrapper argument the session views put the caller's request object under. */
function wrapViewRequest(request: unknown): Readonly<Record<string, unknown>> {
  return { _request: request ?? {} }
}

/** A host that records what the API asked of it and answers nothing by default. */
function createStubHost(options: StubOptions = {}): StubHost {
  const cancels: CancelCall[] = []
  const invoked: InvokeCall[] = []
  const streams: RemoteStream[] = []
  const enrollment: (string | null)[] = []
  const nodes = options.nodes ?? [READY_VIEW]

  return {
    address: { host: '127.0.0.1' },
    cancels,
    invoked,
    streams,
    enrollment,
    enrollmentOpen: options.enrollmentOpen ?? true,
    stateFile: options.stateFile,
    setEnrollmentSecret: (secret) => {
      enrollment.push(secret)
      options.setEnrollmentSecret?.(secret)
    },
    listNodes: () => [...nodes],
    node: nodeId => nodes.find(view => view.nodeId === nodeId),
    capabilitiesOf: nodeId => options.capabilities?.(nodeId),
    stats: () => options.stats ?? { listening: true, nodes: nodes.length, ready: nodes.length },
    invoke: async (nodeId, endpoint, args) => {
      invoked.push({ nodeId, endpoint, args })
      if (options.invoke === undefined) throw new Error(`the stub cannot invoke ${endpoint}`)
      return await options.invoke(nodeId, endpoint, args)
    },
    openStream: () => {
      const stream = options.openStream?.() ?? createTestStream()
      streams.push(stream)
      return stream
    },
    cancelStream: (nodeId, streamId, reason) => {
      cancels.push({ nodeId, streamId, reason })
      // A real host abandons the stream; without that the NDJSON handler would
      // wait for a consumer that is already gone.
      for (const stream of streams) {
        if (stream.streamId === streamId) {
          stream.fail({ code: 'coordinator/stream-closed', message: reason ?? 'cancelled', details: {} }, 'cancelled')
        }
      }
    },
    revokeNode: () => { throw new CoordinatorError('coordinator/node-unknown', 'the stub cannot revoke', {}) },
    restoreNode: () => { throw new CoordinatorError('coordinator/node-unknown', 'the stub cannot restore', {}) },
    rotateNodeToken: () => { throw new CoordinatorError('coordinator/node-unknown', 'the stub cannot rotate', {}) },
    sessionsEnabled: options.sessionViewsEnabled ?? true,
    listSessions: async (nodeId, request) => {
      invoked.push({ nodeId, endpoint: 'session/list', args: wrapViewRequest(request) })
      if (options.invoke === undefined) throw new Error('the stub cannot invoke session/list')
      return await options.invoke(nodeId, 'session/list', wrapViewRequest(request))
    },
    pageSessions: async (nodeId, request) => {
      invoked.push({ nodeId, endpoint: 'session/page', args: wrapViewRequest(request) })
      if (options.invoke === undefined) throw new Error('the stub cannot invoke session/page')
      return await options.invoke(nodeId, 'session/page', wrapViewRequest(request))
    },
    createSession: async (nodeId) => {
      invoked.push({ nodeId, endpoint: 'session/create', args: {} })
      if (options.invoke === undefined) throw new Error('the stub cannot invoke session/create')
      return await options.invoke(nodeId, 'session/create', {})
    },
    promptSession: async (nodeId, input) => {
      invoked.push({ nodeId, endpoint: 'session/prompt', args: input as Record<string, unknown> })
      if (options.invoke === undefined) throw new Error('the stub cannot invoke session/prompt')
      return await options.invoke(nodeId, 'session/prompt', input as Record<string, unknown>)
    },
    followSession: (nodeId) => {
      const stream = options.openStream?.() ?? createTestStream({ endpoint: 'session/follow' })
      streams.push(stream)
      invoked.push({ nodeId, endpoint: 'session/follow', args: {} })
      return stream
    },
    addNode: (record) => {
      if (options.addNode === undefined) {
        throw new CoordinatorError('coordinator/invalid-arguments', 'the stub cannot add nodes', {})
      }
      return options.addNode(record)
    },
  }
}

/** A stream handle a test can feed by hand. */
function createTestStream(overrides: { readonly streamId?: string; readonly endpoint?: string } = {}): RemoteStream {
  return new RemoteStream(
    {
      streamId: overrides.streamId ?? 's-1',
      endpoint: overrides.endpoint ?? 'session/watch',
      maxBufferedValues: 16,
      timeoutMs: 60_000,
      onIdle: () => {},
    },
    () => {},
  )
}

/** Parse an NDJSON body into its lines. */
function ndjson(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

// ---------------------------------------------------------------- a real service

const coordinators: Coordinator[] = []
const clients: FakeNodeClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      client.destroy()
    } catch {
      // Already gone; nothing to clean up.
    }
  }
  for (const coordinator of coordinators.splice(0)) await coordinator.stop()
})

async function startCoordinator(
  records: readonly NodeRecord[],
  apiToken?: string,
): Promise<{ coordinator: Coordinator; base: string }> {
  const coordinator = new Coordinator({
    port: 0,
    records,
    logger: silentLogger,
    shutdownGraceMs: 500,
    ...(apiToken === undefined ? {} : { apiToken }),
  })
  coordinators.push(coordinator)
  const address = await coordinator.start()
  return { coordinator, base: `http://127.0.0.1:${address.port}` }
}

async function connect(coordinator: Coordinator, nodeId: string, token: string): Promise<FakeNodeClient> {
  const address = coordinator.address
  if (address === undefined) throw new Error('the coordinator is not listening')
  const client = await connectFakeNode(address.url, { nodeId, token })
  clients.push(client)
  client.socket.on('error', () => {})
  await client.handshake()
  await waitFor(() => coordinator.registry.isReady(nodeId), { label: `${nodeId} to be ready` })
  return client
}

// ---------------------------------------------------------------- routing

describe('routing', () => {
  it('answers an unknown route with 404', async () => {
    const { base } = await serveTracked(createStubHost())

    const outside = await get(base, '/not-the-api')
    expect(outside.status).toBe(404)
    await expect(outside.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/invalid-arguments', message: 'no route for /not-the-api' },
    })

    const inside = await post(base, '/api/nope', {})
    expect(inside.status).toBe(404)
    await expect(inside.json()).resolves.toMatchObject({ ok: false, error: { code: 'coordinator/invalid-arguments' } })
  })

  it('answers a GET on a POST-only route with 405', async () => {
    const { base } = await serveTracked(createStubHost())

    const response = await get(base, '/api/invoke')
    expect(response.status).toBe(405)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/invalid-arguments', message: '/api/invoke only accepts POST' },
    })
    expect((await get(base, '/api/nodes/add')).status).toBe(405)
  })

  it('answers every route with 404 when the API is not installed', async () => {
    const { api, base } = await serveTracked(createStubHost(), { enabled: false })

    expect(api.requiresToken).toBe(false)
    for (const path of ['/api/stats', '/api/nodes']) {
      const response = await get(base, path)
      expect(response.status, path).toBe(404)
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { message: `no route for ${path}` },
      })
    }
  })
})

// ---------------------------------------------------------------- authentication

describe('the bearer token', () => {
  it('requires the configured token on every route', async () => {
    const { api, base } = await serveTracked(createStubHost(), { token: OPERATOR_TOKEN })
    expect(api.requiresToken).toBe(true)

    const missing = await get(base, '/api/nodes')
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')
    const body = await missing.text()
    expect(body).toContain('coordinator/auth-rejected')
    expect(body).not.toContain(OPERATOR_TOKEN)

    expect((await get(base, '/api/nodes', { authorization: 'Bearer not-the-token' })).status).toBe(401)
    expect((await get(base, '/api/nodes', { authorization: OPERATOR_TOKEN })).status).toBe(401)

    const authorized = await get(base, '/api/nodes', { authorization: `Bearer ${OPERATOR_TOKEN}` })
    expect(authorized.status).toBe(200)
    await expect(authorized.json()).resolves.toMatchObject({ ok: true, value: [READY_VIEW] })
  })
})

// ---------------------------------------------------------------- state routes

describe('reading state', () => {
  it('returns the node list and the health snapshot', async () => {
    const host = createStubHost({ stats: { listening: true, nodes: 1, ready: 1, revoked: 0 } })
    const { base } = await serveTracked(host)

    const nodes = await get(base, '/api/nodes')
    expect(nodes.status).toBe(200)
    await expect(nodes.json()).resolves.toEqual({ ok: true, value: [READY_VIEW] })

    const stats = await get(base, '/api/stats')
    expect(stats.status).toBe(200)
    await expect(stats.json()).resolves.toEqual({
      ok: true,
      value: { listening: true, nodes: 1, ready: 1, revoked: 0 },
    })

    const health = await get(base, '/api/health')
    await expect(health.json()).resolves.toEqual({ ok: true, value: { listening: true } })
  })

  it('answers an unknown node with 404 and coordinator/node-unknown', async () => {
    const { base } = await serveTracked(createStubHost())

    const unknown = await get(base, '/api/node?nodeId=ghost')
    expect(unknown.status).toBe(404)
    await expect(unknown.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/node-unknown', details: { nodeId: 'ghost' } },
    })

    const absent = await get(base, '/api/node')
    expect(absent.status).toBe(404)
    await expect(absent.json()).resolves.toMatchObject({ ok: false, error: { code: 'coordinator/node-unknown' } })
  })

  it('returns one node by id', async () => {
    const { base } = await serveTracked(createStubHost())
    const response = await get(base, `/api/node?nodeId=${NODE_ID}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, value: READY_VIEW })
  })

  it('returns the advertised capability surface, or reports the node as offline', async () => {
    const summary = sampleCapabilities()
    const host = createStubHost({ capabilities: nodeId => (nodeId === NODE_ID ? summary : undefined) })
    const { base } = await serveTracked(host)

    const response = await get(base, `/api/capabilities?nodeId=${NODE_ID}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, value: summary })

    const offline = await get(base, '/api/capabilities?nodeId=silent-node')
    expect(offline.status).toBe(409)
    await expect(offline.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/node-offline', details: { nodeId: 'silent-node' } },
    })

    const absent = await get(base, '/api/capabilities')
    expect(absent.status).toBe(409)
    await expect(absent.json()).resolves.toMatchObject({ ok: false, error: { code: 'coordinator/node-offline' } })
  })
})

// ---------------------------------------------------------------- invoke

describe('invoke', () => {
  it('returns the value of a successful call', async () => {
    const host = createStubHost({ invoke: async () => ({ items: ['a', 'b'] }) })
    const { base } = await serveTracked(host)

    const response = await post(base, '/api/invoke', { nodeId: NODE_ID, endpoint: 'pluginInventory/list' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, value: { items: ['a', 'b'] } })
    expect(host.invoked).toEqual([{ nodeId: NODE_ID, endpoint: 'pluginInventory/list', args: {} }])
  })

  it('forwards the arguments and the deadline to the host', async () => {
    const host = createStubHost({ invoke: async () => null })
    const { base } = await serveTracked(host)

    await post(base, '/api/invoke', {
      nodeId: NODE_ID,
      endpoint: 'pluginInventory/list',
      args: { limit: 3 },
      timeoutMs: 2_500,
    })

    expect(host.invoked).toEqual([
      { nodeId: NODE_ID, endpoint: 'pluginInventory/list', args: { limit: 3 } },
    ])
  })

  it('maps a Coordinator failure onto a real HTTP status', async () => {
    const host = createStubHost({
      invoke: async () => { throw new CoordinatorError('coordinator/node-offline', 'no live connection', {}) },
    })
    const { base } = await serveTracked(host)

    const response = await post(base, '/api/invoke', { nodeId: NODE_ID, endpoint: 'pluginInventory/list' })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/node-offline' },
    })
  })

  it("keeps a node's own failure code and reports it as an error body", async () => {
    // A failure the node reported is data, not an HTTP-level error: the call did
    // reach the node, and a status would throw the code away.
    const host = createStubHost({
      invoke: async () => {
        throw new CoordinatorError('session/not-found', 'no such session', { sessionId: 's-9' })
      },
    })
    const { base } = await serveTracked(host)

    const response = await post(base, '/api/invoke', { nodeId: NODE_ID, endpoint: 'pluginInventory/list' })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; error: { code: string; message: string; details: Record<string, unknown> } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('session/not-found')
    expect(body.error.message).toBe('no such session')
    expect(body.error.details).toEqual({ sessionId: 's-9' })
  })

  it('refuses a body that is not JSON', async () => {
    const { base } = await serveTracked(createStubHost({ invoke: async () => null }))

    const malformed = await postRaw(base, '/api/invoke', '{"nodeId": ')
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/invalid-arguments', message: 'the request body is not valid JSON' },
    })

    const array = await postRaw(base, '/api/invoke', '[]')
    expect(array.status).toBe(400)
    await expect(array.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/invalid-arguments', message: 'the request body must be a JSON object' },
    })
  })

  it('refuses a field that is missing or of the wrong type', async () => {
    const { base } = await serveTracked(createStubHost({ invoke: async () => null }))

    const missing = await post(base, '/api/invoke', { endpoint: 'pluginInventory/list' })
    expect(missing.status).toBe(400)
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/invalid-arguments', details: { field: 'nodeId' } },
    })

    const wrongType = await post(base, '/api/invoke', {
      nodeId: NODE_ID,
      endpoint: 'pluginInventory/list',
      args: 'not-an-object',
    })
    expect(wrongType.status).toBe(400)
    await expect(wrongType.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/invalid-arguments', details: { field: 'args' } },
    })
  })

  it('refuses a body over the ceiling with 413', async () => {
    const { base } = await serveTracked(createStubHost({ invoke: async () => null }), { maxBodyBytes: 1_024 })

    const response = await post(base, '/api/invoke', {
      nodeId: NODE_ID,
      endpoint: 'pluginInventory/list',
      padding: 'x'.repeat(4_096),
    })
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/frame-too-large' },
    })
  })
})

// ---------------------------------------------------------------- streams

describe('stream', () => {
  it('writes NDJSON: open, one data line per value, then end', async () => {
    const stream = createTestStream()
    const host = createStubHost({ openStream: () => stream })
    const { base } = await serveTracked(host)

    const response = await post(base, '/api/stream', {
      nodeId: NODE_ID,
      endpoint: 'session/watch',
      args: { topic: 'a' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')

    stream.push(1, { n: 1 })
    stream.push(2, { n: 2 })
    stream.end(2)

    expect(ndjson(await response.text())).toEqual([
      { type: 'open', streamId: 's-1', endpoint: 'session/watch' },
      { type: 'data', value: { n: 1 } },
      { type: 'data', value: { n: 2 } },
      { type: 'end', count: 2 },
    ])
  })

  it('reports a stream failure inside the NDJSON body, not as an HTTP status', async () => {
    const stream = createTestStream()
    const host = createStubHost({ openStream: () => stream })
    const { base } = await serveTracked(host)

    const response = await post(base, '/api/stream', { nodeId: NODE_ID, endpoint: 'session/watch' })
    expect(response.status).toBe(200)
    stream.fail({ code: 'node/backpressure', message: 'too fast', details: {} }, 'protocol')

    expect(ndjson(await response.text())).toEqual([
      { type: 'open', streamId: 's-1', endpoint: 'session/watch' },
      { type: 'error', error: { code: 'node/backpressure', message: 'too fast', details: {} }, count: 0 },
    ])
  })

  it('cancels the stream on the host when the client disconnects', async () => {
    const stream = createTestStream()
    const host = createStubHost({ openStream: () => stream })
    const { base } = await serveTracked(host)

    const controller = new AbortController()
    const response = await fetch(`${base}/api/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: NODE_ID, endpoint: 'session/watch' }),
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    const head = await reader?.read()
    expect(head?.done).toBe(false)

    // The consumer leaves before the node is done producing.
    await reader?.cancel()
    controller.abort()

    await waitFor(() => host.cancels.length > 0, {
      label: 'the host to be told the stream was cancelled',
      timeoutMs: 5_000,
    })
    expect(host.cancels[0]).toEqual({
      nodeId: NODE_ID,
      streamId: 's-1',
      reason: 'the HTTP client disconnected',
    })
  })
})

// ------------------------------------------------------- remote access decision

describe('who may reach the operator API', () => {
  it('recognises every shape a loopback address arrives in', () => {
    // Node reports an IPv4-mapped IPv6 form when a dual-stack listener accepts an
    // IPv4 connection. Missing that would treat a local browser as remote and lock
    // the operator out of their own UI.
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.0.0.5')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('localhost')).toBe(true)

    expect(isLoopbackAddress('192.168.1.10')).toBe(false)
    expect(isLoopbackAddress('::ffff:192.168.1.10')).toBe(false)
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('allows remote administration only when a token protects it', () => {
    // The point of the rule: a wildcard bind invites *nodes* without inviting
    // *administrators*. Without a token there is nothing to authenticate a remote
    // administrator with, so the honest answer is to refuse.
    expect(allowsRemoteApi({})).toBe(false)
    expect(allowsRemoteApi({ token: '' })).toBe(false)
    expect(allowsRemoteApi({ token: OPERATOR_TOKEN })).toBe(true)
  })
})

// ---------------------------------------------------------------- end to end

describe('against a running Coordinator', () => {
  it('serves the node list, stats, and one node, live', async () => {
    const { coordinator, base } = await startCoordinator([{ nodeId: NODE_ID, token: SECRET }])

    const offline = await (await get(base, '/api/nodes')).json() as { ok: boolean; value: NodeView[] }
    expect(offline.ok).toBe(true)
    expect(offline.value).toHaveLength(1)
    expect(offline.value[0]).toMatchObject({ nodeId: NODE_ID, state: 'offline', capabilityCount: 0, revoked: false })

    const client = await connect(coordinator, NODE_ID, SECRET)
    expect(client.received.length).toBeGreaterThan(0)

    const live = await (await get(base, `/api/node?nodeId=${NODE_ID}`)).json() as { ok: boolean; value: NodeView }
    expect(live.value).toMatchObject({ state: 'ready', capabilityCount: 2, remoteSurfaceHash: 'surface-1' })

    const stats = await (await get(base, '/api/stats')).json() as { value: Record<string, unknown> }
    expect(stats.value).toMatchObject({ listening: true, nodes: 1, ready: 1, sessions: 1 })
    expect(stats.value['url']).toBe(coordinator.address?.url)
  })

  it('reports the capability surface of a live node, and refuses one that has none', async () => {
    const { coordinator, base } = await startCoordinator([{ nodeId: NODE_ID, token: SECRET }])

    const before = await get(base, `/api/capabilities?nodeId=${NODE_ID}`)
    expect(before.status).toBe(409)
    await expect(before.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'coordinator/node-offline' },
    })

    await connect(coordinator, NODE_ID, SECRET)

    const after = await get(base, `/api/capabilities?nodeId=${NODE_ID}`)
    expect(after.status).toBe(200)
    await expect(after.json()).resolves.toEqual({ ok: true, value: sampleCapabilities() })
  })

  it('invokes a Remote through the API and returns its value', async () => {
    const { coordinator, base } = await startCoordinator([{ nodeId: NODE_ID, token: SECRET }])
    const client = await connect(coordinator, NODE_ID, SECRET)

    const waiting = client.next('rpc.request')
    const responsePromise = post(base, '/api/invoke', {
      nodeId: NODE_ID,
      endpoint: 'pluginInventory/list',
      args: { limit: 1 },
      timeoutMs: 5_000,
    })
    const request = await waiting
    expect(request['endpoint']).toBe('pluginInventory/list')
    expect(request['payload']).toEqual({ args: { limit: 1 } })

    client.send({
      type: 'rpc.result',
      nodeId: NODE_ID,
      requestId: request['requestId'],
      result: { ok: true, value: { items: ['a'] } },
    })

    const response = await responsePromise
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, value: { items: ['a'] } })
  })

  it("keeps a real node's failure code in the error body", async () => {
    const { coordinator, base } = await startCoordinator([{ nodeId: NODE_ID, token: SECRET }])
    const client = await connect(coordinator, NODE_ID, SECRET)

    const waiting = client.next('rpc.request')
    const responsePromise = post(base, '/api/invoke', { nodeId: NODE_ID, endpoint: 'pluginInventory/list' })
    const request = await waiting
    client.send({
      type: 'rpc.result',
      nodeId: NODE_ID,
      requestId: request['requestId'],
      result: { ok: false, error: { code: 'session/not-found', message: 'no such session', details: {} } },
    })

    const response = await responsePromise
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })
  })

  it('streams NDJSON from a real node', async () => {
    const { coordinator, base } = await startCoordinator([{ nodeId: NODE_ID, token: SECRET }])
    const client = await connect(coordinator, NODE_ID, SECRET)

    const waiting = client.next('stream.open')
    const responsePromise = post(base, '/api/stream', { nodeId: NODE_ID, endpoint: 'session/watch' })
    const open = await waiting
    const streamId = String(open['streamId'])

    client.send({ type: 'stream.ready', nodeId: NODE_ID, streamId })
    client.send({ type: 'stream.data', nodeId: NODE_ID, streamId, seq: 1, value: { n: 1 } })
    client.send({ type: 'stream.data', nodeId: NODE_ID, streamId, seq: 2, value: { n: 2 } })
    client.send({ type: 'stream.end', nodeId: NODE_ID, streamId, count: 2 })

    const response = await responsePromise
    expect(response.status).toBe(200)
    expect(ndjson(await response.text())).toEqual([
      { type: 'open', streamId, endpoint: 'session/watch' },
      { type: 'data', value: { n: 1 } },
      { type: 'data', value: { n: 2 } },
      { type: 'end', count: 2 },
    ])
  })

  it('revokes a node through the API and closes its socket', async () => {
    const { coordinator, base } = await startCoordinator([{ nodeId: NODE_ID, token: SECRET }])
    const client = await connect(coordinator, NODE_ID, SECRET)
    const closed = client.closed()

    const response = await post(base, '/api/nodes/revoke', { nodeId: NODE_ID })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, value: { nodeId: NODE_ID, revoked: true } })

    expect((await closed).code).toBe(4401)
    await expect(
      get(base, `/api/node?nodeId=${NODE_ID}`).then(async response => await response.json()),
    ).resolves.toMatchObject({ ok: true, value: { revoked: true } })
    expect(coordinator.stats().revoked).toBe(1)
  })

  it('never puts a node token in a response', async () => {
    const { base } = await startCoordinator([{ nodeId: NODE_ID, token: SECRET }], OPERATOR_TOKEN)
    const auth = { authorization: `Bearer ${OPERATOR_TOKEN}` }
    const results: { label: string; status: number; text: string }[] = []
    const record = async (label: string, response: Response): Promise<void> => {
      results.push({ label, status: response.status, text: await response.text() })
    }

    await record('nodes', await get(base, '/api/nodes', auth))
    await record('stats', await get(base, '/api/stats', auth))
    await record('node', await get(base, `/api/node?nodeId=${NODE_ID}`, auth))
    await record('add', await post(base, '/api/nodes/add', { nodeId: 'node-2', token: SECRET }, auth))
    await record('rotate-unknown', await post(base, '/api/nodes/rotate', { nodeId: 'ghost', token: SECRET }, auth))
    await record('revoke-unknown', await post(base, '/api/nodes/revoke', { nodeId: 'ghost' }, auth))
    await record('invoke-unknown', await post(base, '/api/invoke', { nodeId: 'ghost', endpoint: 'a/b' }, auth))
    await record('unauthorized', await get(base, '/api/nodes'))

    for (const result of results) {
      expect(result.text, `${result.label} leaked the node token`).not.toContain(SECRET)
      expect(result.text, `${result.label} leaked the operator token`).not.toContain(OPERATOR_TOKEN)
    }
    // The responses are real answers, not empty shells.
    expect(results.map(result => result.status)).toEqual([200, 200, 200, 200, 404, 404, 404, 401])
    expect(results[0]?.text).toContain(NODE_ID)
    expect(results[3]?.text).toContain('node-2')
  })
})
