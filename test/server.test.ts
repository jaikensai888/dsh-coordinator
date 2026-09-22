/**
 * `Coordinator` behaviour over a real loopback listener: what a node sees when
 * it dials in, what a caller sees when it calls through, and what an operator
 * sees when a node is revoked or the service stops.
 *
 * These tests bind a real server on port 0 and dial it with a real `ws` client,
 * because the wiring between `ws`, the session, and the registry is exactly what
 * a socket double cannot exercise.
 *
 * @module dsh-coordinator/test/server
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Coordinator, DEFAULT_PATH, isLoopback } from '../src/server.js'
import { silentLogger } from '../src/log.js'
import {
  connectFakeNode,
  helloFrame,
  waitFor,
  type FakeNodeClient,
} from './helpers.js'

const NODE_ID = 'node-1'
const TOKEN = 'node-token-abc'
const RECORDS = [
  { nodeId: NODE_ID, token: TOKEN },
  { nodeId: 'silent-node', token: 'silent-token' },
]

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

/** Options a test may vary; everything else is fixed for the suite. */
interface StartOptions {
  readonly port?: number
  readonly host?: string
  readonly allowInsecureBind?: boolean
  readonly apiToken?: string
  readonly enableApi?: boolean
  readonly shutdownGraceMs?: number
}

/** Build, start, and track a Coordinator that the teardown will always stop. */
async function startCoordinator(overrides: StartOptions = {}): Promise<Coordinator> {
  const coordinator = new Coordinator({
    port: overrides.port ?? 0,
    host: overrides.host ?? '127.0.0.1',
    records: RECORDS,
    logger: silentLogger,
    shutdownGraceMs: overrides.shutdownGraceMs ?? 500,
    ...(overrides.allowInsecureBind === undefined ? {} : { allowInsecureBind: overrides.allowInsecureBind }),
    ...(overrides.apiToken === undefined ? {} : { apiToken: overrides.apiToken }),
    ...(overrides.enableApi === undefined ? {} : { enableApi: overrides.enableApi }),
  })
  coordinators.push(coordinator)
  await coordinator.start()
  return coordinator
}

/** The URL a node should dial for a running Coordinator. */
function urlOf(coordinator: Coordinator): string {
  const address = coordinator.address
  if (address === undefined) throw new Error('the coordinator is not listening')
  return address.url
}

/** Dial in as a node and wait until the Coordinator considers it ready. */
async function connect(coordinator: Coordinator, nodeId: string, token: string): Promise<FakeNodeClient> {
  const client = await connectFakeNode(urlOf(coordinator), { nodeId, token })
  clients.push(client)
  // A socket the server destroys on purpose must not surface as a test error.
  client.socket.on('error', () => {})
  await client.handshake()
  await waitFor(() => coordinator.registry.isReady(nodeId), { label: `${nodeId} to be ready` })
  return client
}

/** One failure a caller observed. */
interface Failure {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

/** Await a call that is expected to fail, and report how it failed. */
async function capture(run: () => unknown): Promise<Failure> {
  try {
    await run()
  } catch (error) {
    const shaped = error as Partial<Failure>
    if (typeof shaped.code !== 'string') throw new Error(`the failure carried no code: ${String(error)}`)
    return { code: shaped.code, message: shaped.message ?? '', details: shaped.details ?? {} }
  }
  throw new Error('the call was expected to fail, but it succeeded')
}

describe('starting and stopping', () => {
  it('binds a loopback listener once, however often start() is called', async () => {
    const coordinator = new Coordinator({
      port: 0,
      records: RECORDS,
      logger: silentLogger,
      shutdownGraceMs: 500,
    })
    coordinators.push(coordinator)

    const [first, second] = await Promise.all([coordinator.start(), coordinator.start()])
    const third = await coordinator.start()

    expect(first.port).toBeGreaterThan(0)
    expect(second).toBe(first)
    expect(third.port).toBe(first.port)
    expect(first.host).toBe('127.0.0.1')
    expect(first.path).toBe(DEFAULT_PATH)
    expect(first.url).toBe(`ws://127.0.0.1:${first.port}${DEFAULT_PATH}`)
    expect(coordinator.address).toEqual(first)
  })

  it('refuses a non-loopback bind unless it is explicitly allowed', () => {
    let refused: unknown
    try {
      void new Coordinator({ port: 0, host: '0.0.0.0', logger: silentLogger })
    } catch (error) {
      refused = error
    }
    expect((refused as { code?: string } | undefined)?.code).toBe('coordinator/invalid-arguments')
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback('127.0.0.1')).toBe(true)

    expect(() => new Coordinator({
      port: 0,
      host: '0.0.0.0',
      allowInsecureBind: true,
      apiToken: 'operator-secret',
      logger: silentLogger,
    })).not.toThrow()
  })

  it('stop() disconnects node sockets and releases the port for a fresh start', async () => {
    const coordinator = await startCoordinator()
    const client = await connect(coordinator, NODE_ID, TOKEN)
    const port = coordinator.address?.port ?? 0

    const shutdownFrame = client.next('close')
    const closed = client.closed()
    await coordinator.stop()

    const frame = await shutdownFrame
    expect(frame).toMatchObject({ code: 'coordinator/shutdown', reconnect: true, nodeId: NODE_ID })
    expect((await closed).code).toBe(1000)
    expect(coordinator.address).toBeUndefined()
    expect(coordinator.stats().listening).toBe(false)

    const restarted = await startCoordinator({ port })
    expect(restarted.address?.port).toBe(port)
    expect(restarted.stats().listening).toBe(true)
  })

  it('keeps the operator API available on localhost for an unprotected non-loopback bind', async () => {
    const coordinator = await startCoordinator({ host: '0.0.0.0', allowInsecureBind: true })
    const port = coordinator.address?.port ?? 0

    // The listener may be reachable by nodes on other interfaces, but the
    // operator API remains a localhost bootstrap surface until a token is set.
    for (const path of ['/api/stats', '/api/nodes']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      expect(response.status, path).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ ok: true })
    }
  })

  it('installs the operator API on a non-loopback bind when a token protects it', async () => {
    const coordinator = await startCoordinator({
      host: '0.0.0.0',
      allowInsecureBind: true,
      apiToken: 'operator-secret',
    })
    const port = coordinator.address?.port ?? 0

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/stats`)
    expect(unauthorized.status).toBe(401)

    const authorized = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      headers: { authorization: 'Bearer operator-secret' },
    })
    expect(authorized.status).toBe(200)
    await expect(authorized.json()).resolves.toMatchObject({ ok: true, value: { listening: true } })
  })
})

describe('reaching a node', () => {
  it('refuses a call to a node that was never approved', async () => {
    const coordinator = await startCoordinator()
    const failure = await capture(() => coordinator.invoke('ghost-node', 'pluginInventory/list'))
    expect(failure.code).toBe('coordinator/node-unknown')
    expect(failure.details['nodeId']).toBe('ghost-node')
  })

  it('refuses a call to a registered node with no live connection', async () => {
    const coordinator = await startCoordinator()
    const failure = await capture(() => coordinator.invoke('silent-node', 'pluginInventory/list'))
    expect(failure.code).toBe('coordinator/node-offline')
    expect(failure.details['state']).toBe('offline')
  })

  it('forwards a call to a dialled-in node and returns its answer', async () => {
    const coordinator = await startCoordinator()
    const client = await connect(coordinator, NODE_ID, TOKEN)

    const waiting = client.next('rpc.request')
    const pending = coordinator.invoke(NODE_ID, 'pluginInventory/list', { limit: 2 })
    const request = await waiting
    expect(request['nodeId']).toBe(NODE_ID)
    expect(request['endpoint']).toBe('pluginInventory/list')
    expect(request['payload']).toEqual({ args: { limit: 2 } })
    expect(coordinator.stats().inFlightRequests).toBe(1)

    client.send({
      type: 'rpc.result',
      nodeId: NODE_ID,
      requestId: request['requestId'],
      result: { ok: true, value: { items: ['a', 'b'] } },
    })

    await expect(pending).resolves.toEqual({ items: ['a', 'b'] })
    expect(coordinator.stats().inFlightRequests).toBe(0)
  })

  it("returns the node's own failure code to the caller", async () => {
    const coordinator = await startCoordinator()
    const client = await connect(coordinator, NODE_ID, TOKEN)

    const waiting = client.next('rpc.request')
    const pending = capture(() => coordinator.invoke(NODE_ID, 'pluginInventory/list'))
    const request = await waiting
    client.send({
      type: 'rpc.result',
      nodeId: NODE_ID,
      requestId: request['requestId'],
      result: { ok: false, error: { code: 'session/not-found', message: 'no such session', details: {} } },
    })

    const failure = await pending
    expect(failure.code).toBe('session/not-found')
    expect(failure.message).toBe('no such session')
  })
})

describe('one connection per node', () => {
  it('replaces the older socket when the same node dials in twice', async () => {
    const coordinator = await startCoordinator()
    const first = await connect(coordinator, NODE_ID, TOKEN)
    const firstConnectionId = coordinator.sessionOf(NODE_ID)?.connectionId

    const second = await connectFakeNode(urlOf(coordinator), { nodeId: NODE_ID, token: TOKEN })
    clients.push(second)
    second.socket.on('error', () => {})
    const replacedFrame = first.next('close')
    const closed = first.closed()

    await second.handshake()
    await waitFor(() => coordinator.sessionOf(NODE_ID)?.state === 'ready')

    const frame = await replacedFrame
    expect(frame).toMatchObject({ code: 'node/protocol-invalid', reconnect: false, nodeId: NODE_ID })
    expect((await closed).code).toBe(1000)
    expect(coordinator.sessionOf(NODE_ID)?.connectionId).not.toBe(firstConnectionId)
    await waitFor(() => coordinator.stats().sessions === 1)

    // Dispatch follows the surviving connection.
    const waiting = second.next('rpc.request')
    const pending = coordinator.invoke(NODE_ID, 'pluginInventory/list')
    const request = await waiting
    second.send({
      type: 'rpc.result',
      nodeId: NODE_ID,
      requestId: request['requestId'],
      result: { ok: true, value: 'from the new connection' },
    })
    await expect(pending).resolves.toBe('from the new connection')
  })

  it('revokes a node: the live socket is closed and the view says so', async () => {
    const coordinator = await startCoordinator()
    const client = await connect(coordinator, NODE_ID, TOKEN)

    const revokedFrame = client.next('close')
    const closed = client.closed()
    const view = coordinator.revokeNode(NODE_ID)

    expect(view.revoked).toBe(true)
    expect(view.state).not.toBe('ready')
    const frame = await revokedFrame
    expect(frame).toMatchObject({ code: 'node/auth-failed', reconnect: false, nodeId: NODE_ID })
    expect((await closed).code).toBe(4401)

    expect(coordinator.node(NODE_ID)?.revoked).toBe(true)
    expect(coordinator.stats().revoked).toBe(1)
    await waitFor(() => coordinator.stats().sessions === 0)

    // A revoked node cannot talk its way back in.
    const retry = await connectFakeNode(urlOf(coordinator), { nodeId: NODE_ID, token: TOKEN })
    clients.push(retry)
    retry.socket.on('error', () => {})
    const refusedFrame = retry.next('close')
    const refusedClose = retry.closed()
    retry.send(helloFrame({ nodeId: NODE_ID, token: TOKEN }))
    expect((await refusedFrame)['code']).toBe('node/auth-failed')
    expect((await refusedClose).code).toBe(4401)
  })
})

describe('service health', () => {
  it('counts a ready node in stats()', async () => {
    const coordinator = await startCoordinator()
    expect(coordinator.stats()).toMatchObject({
      listening: true,
      nodes: 2,
      ready: 0,
      revoked: 0,
      sessions: 0,
      inFlightRequests: 0,
      activeStreams: 0,
    })
    expect(coordinator.stats().url).toBe(urlOf(coordinator))

    await connect(coordinator, NODE_ID, TOKEN)

    expect(coordinator.stats()).toMatchObject({
      listening: true,
      nodes: 2,
      ready: 1,
      revoked: 0,
      sessions: 1,
      inFlightRequests: 0,
      activeStreams: 0,
    })
  })

  it('lists nodes without leaking a token', async () => {
    const coordinator = await startCoordinator()
    await connect(coordinator, NODE_ID, TOKEN)

    const listed = coordinator.listNodes()
    expect(listed.map(node => node.nodeId)).toEqual([NODE_ID, 'silent-node'])
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
    expect(coordinator.node(NODE_ID)).toMatchObject({ nodeId: NODE_ID, state: 'ready', revoked: false })
  })
})
