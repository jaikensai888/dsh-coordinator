/**
 * `NodeSession` behaviour: admission, the handshake, heartbeats, and what a
 * caller observes when a call succeeds, fails, times out, or loses its link.
 *
 * Every test drives the in-memory socket double and a virtual clock, so a
 * 30-second deadline is one `timers.advance()` away and nothing sleeps.
 *
 * @module dsh-coordinator/test/session
 */

import { describe, expect, it } from 'vitest'
import { NodeRegistry } from '../src/node-registry.js'
import { PROTOCOL_VERSION, type NodeCapabilitySummary } from '../src/protocol.js'
import { NodeSession, type SessionEvent } from '../src/session.js'
import {
  CLOSED,
  createManualTimers,
  createScriptedSocket,
  helloFrame,
  readyFrame,
  sampleCapabilities,
  settle,
  type ManualTimers,
  type ScriptedSocket,
  type SentFrame,
} from './helpers.js'

const NODE_ID = 'node-1'
const TOKEN = 'correct-horse-battery-staple'

// ---------------------------------------------------------------- fixtures

/** Wiring a test may vary; everything else gets a sane default. */
interface HarnessOptions {
  readonly registry?: NodeRegistry
  readonly socket?: ScriptedSocket
  readonly handshakeTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly maxFrameBytes?: number
  readonly requestTimeoutMs?: number
  readonly maxInFlightRequests?: number
  readonly maxStreams?: number
  readonly streamIdleTimeoutMs?: number
  readonly maxBufferedValues?: number
}

interface Harness {
  readonly session: NodeSession
  readonly socket: ScriptedSocket
  readonly timers: ManualTimers
  readonly registry: NodeRegistry
  readonly events: SessionEvent[]
}

/** A session on a scripted socket, with a clock the test drives. */
function createHarness(overrides: HarnessOptions = {}): Harness {
  const socket = overrides.socket ?? createScriptedSocket()
  const timers = createManualTimers()
  const registry = overrides.registry ?? new NodeRegistry({
    records: [{ nodeId: NODE_ID, token: TOKEN }],
    now: () => timers.now(),
  })
  const events: SessionEvent[] = []
  const session = new NodeSession({
    sessionKey: 'test-session',
    socket,
    registry,
    handshakeTimeoutMs: overrides.handshakeTimeoutMs ?? 10_000,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 60_000,
    maxFrameBytes: overrides.maxFrameBytes ?? 4 * 1024 * 1024,
    maxInFlightRequests: overrides.maxInFlightRequests ?? 8,
    maxStreams: overrides.maxStreams ?? 4,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 30_000,
    streamIdleTimeoutMs: overrides.streamIdleTimeoutMs ?? 60_000,
    maxBufferedValues: overrides.maxBufferedValues ?? 16,
    timers,
    onEvent: (event) => { events.push(event) },
  })
  return { session, socket, timers, registry, events }
}

/** The most recent frame of one type, or a loud failure when there is none. */
function sentFrame(socket: ScriptedSocket, type: string): SentFrame {
  const frame = socket.lastOfType(type)
  if (frame === undefined) throw new Error(`the session sent no ${type} frame`)
  return frame
}

/** Every frame type the session has sent, in order. */
function sentTypes(socket: ScriptedSocket): string[] {
  return socket.sent.map(frame => frame.type)
}

/** The connection id from the `hello.ok` the session sent. */
function connectionIdOf(socket: ScriptedSocket): string {
  const connectionId = sentFrame(socket, 'hello.ok')['connectionId']
  if (typeof connectionId !== 'string') throw new Error('hello.ok carried no connectionId')
  return connectionId
}

/** Complete the handshake, up to and including `ready`. */
function completeHandshake(harness: Harness, capabilities: NodeCapabilitySummary = sampleCapabilities()): void {
  harness.socket.receive(helloFrame({ nodeId: NODE_ID, token: TOKEN }))
  harness.socket.receive(readyFrame({
    nodeId: NODE_ID,
    connectionId: connectionIdOf(harness.socket),
    capabilities,
  }))
}

/** A session that has completed the handshake. */
function readyHarness(overrides: HarnessOptions = {}): Harness {
  const harness = createHarness(overrides)
  completeHandshake(harness)
  return harness
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

function readyEvents(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'ready' }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: 'ready' }> => event.type === 'ready')
}

function protocolErrors(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'protocol-error' }>[] {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'protocol-error' }> => event.type === 'protocol-error',
  )
}

function closedEvents(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'closed' }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: 'closed' }> => event.type === 'closed')
}

function authRejections(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'auth-rejected' }>[] {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'auth-rejected' }> => event.type === 'auth-rejected',
  )
}

// ---------------------------------------------------------------- handshake

describe('the handshake', () => {
  it('refuses a hello whose token does not match, on the frame and on the socket', async () => {
    const harness = createHarness()
    harness.socket.receive(helloFrame({ nodeId: NODE_ID, token: 'not-the-token' }))

    const close = sentFrame(harness.socket, 'close')
    expect(close['code']).toBe('node/auth-failed')
    expect(close['nodeId']).toBe(NODE_ID)
    expect(harness.socket.closeCalls.map(call => call.code)).toEqual([4401])
    expect(authRejections(harness.events)[0]).toMatchObject({ nodeId: NODE_ID, reason: 'token-mismatch' })
    expect(harness.socket.ofType('hello.ok')).toHaveLength(0)

    await settle()
    expect(harness.socket.readyState).toBe(CLOSED)
    expect(harness.session.state).toBe('offline')
    expect(harness.registry.isReady(NODE_ID)).toBe(false)
  })

  it('refuses an unknown node with the same wire reason as a wrong token', () => {
    const wrongToken = createHarness()
    wrongToken.socket.receive(helloFrame({ nodeId: NODE_ID, token: 'not-the-token' }))
    const unknown = createHarness()
    unknown.socket.receive(helloFrame({ nodeId: 'node-nobody-approved', token: TOKEN }))

    expect(sentFrame(unknown.socket, 'close')['code']).toBe('node/auth-failed')
    expect(sentFrame(unknown.socket, 'close')['reason']).toBe(sentFrame(wrongToken.socket, 'close')['reason'])
    expect(unknown.socket.closeCalls.map(call => call.code)).toEqual([4401])
    // The distinction stays in the operator's own event stream.
    expect(authRejections(unknown.events)[0]?.reason).toBe('unknown-node')
  })

  it('closes a connection whose first frame is not a hello', async () => {
    const harness = createHarness()
    harness.socket.receive(readyFrame({ nodeId: NODE_ID }))

    const errors = protocolErrors(harness.events)
    expect(errors[0]?.code).toBe('coordinator/protocol-invalid')
    expect(errors[0]?.message).toContain('before hello')
    // No `hello` was accepted, so there is no node id to address a frame to: the
    // socket close carries the message instead.
    expect(harness.socket.ofType('close')).toHaveLength(0)
    expect(harness.socket.closeCalls.map(call => call.code)).toEqual([1000])

    await settle()
    expect(harness.session.state).toBe('offline')
  })

  it('sends hello.ok with the connection id, limits, and mode, and nothing else before ready', () => {
    const harness = createHarness({ heartbeatIntervalMs: 100 })
    harness.socket.receive(helloFrame({ nodeId: NODE_ID, token: TOKEN }))

    expect(harness.session.state).toBe('authenticating')
    expect(sentTypes(harness.socket)).toEqual(['hello.ok'])
    const ok = sentFrame(harness.socket, 'hello.ok')
    expect(ok['nodeId']).toBe(NODE_ID)
    expect(ok['protocolVersion']).toBe(PROTOCOL_VERSION)
    expect(ok['connectionId']).toBe(harness.session.connectionId)
    expect(ok['connectionId']).toMatch(/^node-1:/)
    expect(ok['heartbeatIntervalMs']).toBe(100)
    expect(ok['maxFrameBytes']).toBe(4 * 1024 * 1024)
    expect(ok['acceptedMode']).toBe('full-access')

    harness.socket.receive(readyFrame({ nodeId: NODE_ID, connectionId: connectionIdOf(harness.socket) }))
    expect(harness.session.state).toBe('ready')
    // `ready` is answered by no frame at all until the heartbeat cadence fires.
    expect(sentTypes(harness.socket)).toEqual(['hello.ok'])
  })

  it('closes a connection that never sends a hello', async () => {
    const harness = createHarness({ handshakeTimeoutMs: 5_000 })
    await harness.timers.advance(5_000)

    const errors = protocolErrors(harness.events)
    expect(errors.map(event => event.code)).toEqual(['coordinator/handshake-failed'])
    expect(harness.socket.closeCalls.map(call => call.code)).toEqual([1000])
    expect(harness.socket.closeCalls[0]?.reason).toContain('no hello')
    expect(harness.session.state).toBe('offline')
    expect(harness.timers.pending()).toBe(0)
  })

  it('refuses a frame other than ready once the hello was accepted', async () => {
    const harness = createHarness()
    harness.socket.receive(helloFrame({ nodeId: NODE_ID, token: TOKEN }))
    harness.socket.receive({ type: 'ping', nodeId: NODE_ID, messageId: 'heartbeat' })
    expect(sentFrame(harness.socket, 'pong')['messageId']).toBe('heartbeat')

    harness.socket.receive({
      type: 'rpc.result',
      nodeId: NODE_ID,
      requestId: 'r-1',
      result: { ok: true, value: 1 },
    })

    const close = sentFrame(harness.socket, 'close')
    expect(close['code']).toBe('node/protocol-invalid')
    expect(close['reason']).toContain('before ready')
    await settle()
    expect(harness.session.state).toBe('offline')
  })
})

// ---------------------------------------------------------------- ready

describe('the ready handshake', () => {
  it('binds the node and its surface when ready arrives', () => {
    const harness = readyHarness()

    expect(harness.registry.isReady(NODE_ID)).toBe(true)
    expect(harness.registry.view(NODE_ID)).toMatchObject({
      nodeId: NODE_ID,
      state: 'ready',
      capabilityCount: 2,
      revoked: false,
      remoteSurfaceHash: 'surface-1',
    })
    expect(harness.registry.view(NODE_ID)?.connectionId).toBe(harness.session.connectionId)
    expect(harness.session.capabilities).toEqual(sampleCapabilities())

    const [event] = readyEvents(harness.events)
    expect(event).toMatchObject({ nodeId: NODE_ID, surfaceChanged: false })
    expect(event?.previousSurfaceHash).toBeUndefined()
  })

  it('reports a changed surface when the node reconnects with a different one', async () => {
    // The interesting case for `surfaceChanged`: a node comes back after a plugin
    // was installed, removed, or hot-reloaded. The digest has to survive the
    // reconnect for that to be detectable, so `bind()` carries the previous hash
    // over and `setCapabilities()` compares against it.
    const registry = new NodeRegistry({ records: [{ nodeId: NODE_ID, token: TOKEN }] })
    const first = readyHarness({ registry })
    expect(readyEvents(first.events)[0]?.surfaceChanged).toBe(false)

    first.socket.remoteClose(1006, 'the node restarted')
    await settle()
    expect(registry.view(NODE_ID)?.state).toBe('offline')
    expect(registry.view(NODE_ID)?.remoteSurfaceHash).toBe('surface-1')

    const second = createHarness({ registry })
    completeHandshake(second, sampleCapabilities({ remoteSurfaceHash: 'surface-2' }))

    const [event] = readyEvents(second.events)
    expect(event?.surfaceChanged).toBe(true)
    expect(event?.previousSurfaceHash).toBe('surface-1')
    expect(registry.view(NODE_ID)?.remoteSurfaceHash).toBe('surface-2')
    expect(registry.view(NODE_ID)?.state).toBe('ready')
  })

  it('reports an unchanged surface when the node reconnects with the same one', async () => {
    const registry = new NodeRegistry({ records: [{ nodeId: NODE_ID, token: TOKEN }] })
    const first = readyHarness({ registry })
    first.socket.remoteClose(1006, 'the node restarted')
    await settle()

    const second = createHarness({ registry })
    completeHandshake(second, sampleCapabilities())

    const [event] = readyEvents(second.events)
    expect(event?.surfaceChanged).toBe(false)
    expect(event?.previousSurfaceHash).toBe('surface-1')
  })

  it('refuses a second ready frame without closing the link', async () => {
    const harness = readyHarness()
    harness.socket.receive(readyFrame({ nodeId: NODE_ID, connectionId: connectionIdOf(harness.socket) }))

    expect(protocolErrors(harness.events).at(-1)?.message).toContain('not legal after ready')
    expect(harness.socket.ofType('close')).toHaveLength(0)
    expect(harness.session.state).toBe('ready')
    expect(harness.registry.view(NODE_ID)?.state).toBe('ready')
  })

  it('refuses a ready that echoes a connection id this Coordinator did not issue', async () => {
    const harness = createHarness()
    harness.socket.receive(helloFrame({ nodeId: NODE_ID, token: TOKEN }))
    harness.socket.receive(readyFrame({ nodeId: NODE_ID, connectionId: 'some-other-connection' }))

    expect(sentFrame(harness.socket, 'close')['code']).toBe('node/protocol-invalid')
    expect(protocolErrors(harness.events)[0]?.message).toContain('connectionId')
    await settle()
    expect(harness.registry.isReady(NODE_ID)).toBe(false)
  })
})

// ---------------------------------------------------------------- heartbeat

describe('heartbeats', () => {
  it('answers a ping with a pong before hello, before ready, and after ready', () => {
    const harness = createHarness()
    harness.socket.receive({ type: 'ping', nodeId: NODE_ID, messageId: 'm-1' })
    expect(sentFrame(harness.socket, 'pong')).toMatchObject({ nodeId: NODE_ID, messageId: 'm-1' })
    expect(harness.session.state).toBe('connecting')

    harness.socket.receive(helloFrame({ nodeId: NODE_ID, token: TOKEN }))
    harness.socket.receive({ type: 'ping', nodeId: NODE_ID, messageId: 'm-2' })
    expect(sentFrame(harness.socket, 'pong')).toMatchObject({ nodeId: NODE_ID, messageId: 'm-2' })
    expect(harness.session.state).toBe('authenticating')

    harness.socket.receive(readyFrame({ nodeId: NODE_ID, connectionId: connectionIdOf(harness.socket) }))
    harness.socket.receive({ type: 'ping', nodeId: NODE_ID })
    expect(sentFrame(harness.socket, 'pong')['nodeId']).toBe(NODE_ID)

    expect(sentTypes(harness.socket)).toEqual(['pong', 'hello.ok', 'pong', 'pong'])
  })

  it('keeps a link alive while pongs keep arriving', async () => {
    const harness = readyHarness({ heartbeatIntervalMs: 100 })

    for (let tick = 0; tick < 6; tick += 1) {
      await harness.timers.advance(100)
      harness.socket.receive({ type: 'pong', nodeId: NODE_ID })
    }

    expect(harness.timers.now()).toBe(600)
    expect(harness.socket.ofType('ping')).toHaveLength(6)
    expect(harness.socket.ofType('close')).toHaveLength(0)
    expect(harness.session.state).toBe('ready')
  })

  it('closes a link that stays silent past the heartbeat window', async () => {
    const harness = readyHarness({ heartbeatIntervalMs: 100 })
    await harness.timers.advance(300)

    expect(harness.socket.ofType('ping')).toHaveLength(2)
    expect(sentFrame(harness.socket, 'close')['code']).toBe('heartbeat-timeout')
    expect(harness.socket.closeCalls.map(call => call.code)).toEqual([1000])
    await settle()
    expect(harness.session.state).toBe('offline')
    expect(harness.registry.view(NODE_ID)?.state).toBe('offline')
    expect(harness.timers.pending()).toBe(0)
  })
})

// ---------------------------------------------------------------- unary calls

describe('unary calls', () => {
  it('refuses a call before the node is ready', async () => {
    const harness = createHarness()
    harness.socket.receive(helloFrame({ nodeId: NODE_ID, token: TOKEN }))

    const failure = await capture(() => harness.session.invoke('pluginInventory/list'))
    expect(failure.code).toBe('coordinator/node-offline')
    expect(harness.socket.ofType('rpc.request')).toHaveLength(0)
  })

  it('refuses an endpoint that is not <namespace>/<method>', async () => {
    const harness = readyHarness()
    for (const endpoint of ['pluginInventory', '/list', 'pluginInventory/', 'a/b/c', '']) {
      const failure = await capture(() => harness.session.invoke(endpoint))
      expect(failure.code, endpoint).toBe('coordinator/invalid-arguments')
    }
    expect(harness.socket.ofType('rpc.request')).toHaveLength(0)
  })

  it('refuses a carrier that does not match the advertised mode', async () => {
    const harness = readyHarness()

    const asUnary = await capture(() => harness.session.invoke('session/watch'))
    expect(asUnary.code).toBe('coordinator/capability-mismatch')
    expect(asUnary.details['expected']).toBe('stream')

    const asStream = await capture(() => harness.session.openStream('pluginInventory/list'))
    expect(asStream.code).toBe('coordinator/capability-mismatch')
    expect(asStream.details['expected']).toBe('unary')

    expect(harness.socket.ofType('rpc.request')).toHaveLength(0)
    expect(harness.socket.ofType('stream.open')).toHaveLength(0)
  })

  it('refuses an endpoint the node never advertised', async () => {
    const harness = readyHarness()
    const failure = await capture(() => harness.session.invoke('unadvertised/method'))
    expect(failure.code).toBe('coordinator/capability-mismatch')
    expect(failure.details['endpoint']).toBe('unadvertised/method')
  })

  it('resolves a call with the value from rpc.result', async () => {
    const harness = readyHarness()
    const pending = harness.session.invoke('pluginInventory/list', { limit: 3 })

    const request = sentFrame(harness.socket, 'rpc.request')
    expect(request['nodeId']).toBe(NODE_ID)
    expect(request['endpoint']).toBe('pluginInventory/list')
    expect(request['payload']).toEqual({ args: { limit: 3 } })
    expect(harness.session.inFlightRequests).toBe(1)

    harness.socket.receive({
      type: 'rpc.result',
      nodeId: NODE_ID,
      requestId: request['requestId'],
      result: { ok: true, value: { items: ['a', 'b'] } },
    })

    await expect(pending).resolves.toEqual({ items: ['a', 'b'] })
    expect(harness.session.inFlightRequests).toBe(0)
  })

  it("rejects a failed call with the node's own code preserved", async () => {
    const harness = readyHarness()
    const pending = capture(() => harness.session.invoke('pluginInventory/list'))
    const request = sentFrame(harness.socket, 'rpc.request')

    harness.socket.receive({
      type: 'rpc.result',
      nodeId: NODE_ID,
      requestId: request['requestId'],
      result: {
        ok: false,
        error: { code: 'session/not-found', message: 'no such session', details: { sessionId: 's-9' } },
      },
    })

    const failure = await pending
    expect(failure.code).toBe('session/not-found')
    expect(failure.message).toBe('no such session')
    expect(failure.details).toEqual({ sessionId: 's-9' })
    expect(harness.session.inFlightRequests).toBe(0)
  })

  it('fails a call that outlives its deadline and tells the node to stop', async () => {
    const harness = readyHarness({ requestTimeoutMs: 1_000 })
    const pending = capture(() => harness.session.invoke('pluginInventory/list'))
    const requestId = sentFrame(harness.socket, 'rpc.request')['requestId']

    await harness.timers.advance(1_000)

    expect((await pending).code).toBe('coordinator/request-timeout')
    expect(sentFrame(harness.socket, 'rpc.cancel')['requestId']).toBe(requestId)
    expect(harness.session.inFlightRequests).toBe(0)
  })

  it('fails an aborted call and tells the node to stop', async () => {
    const harness = readyHarness()
    const controller = new AbortController()
    const pending = capture(() => harness.session.invoke('pluginInventory/list', {}, { signal: controller.signal }))
    const requestId = sentFrame(harness.socket, 'rpc.request')['requestId']

    controller.abort()

    expect((await pending).code).toBe('coordinator/request-aborted')
    expect(sentFrame(harness.socket, 'rpc.cancel')['requestId']).toBe(requestId)
    expect(harness.session.inFlightRequests).toBe(0)
  })

  it('fails every in-flight call when the socket drops, and sends no cancel', async () => {
    const harness = readyHarness()
    const first = capture(() => harness.session.invoke('pluginInventory/list'))
    const second = capture(() => harness.session.invoke('pluginInventory/list'))
    expect(harness.session.inFlightRequests).toBe(2)

    harness.socket.remoteClose(1006, 'the network went away')

    expect((await first).code).toBe('coordinator/connection-lost')
    expect((await second).code).toBe('coordinator/connection-lost')
    expect(harness.session.inFlightRequests).toBe(0)
    // There is no link left to carry a cancel, so none is attempted.
    expect(harness.socket.ofType('rpc.cancel')).toHaveLength(0)
    expect(harness.session.state).toBe('offline')
    expect(closedEvents(harness.events)[0]).toMatchObject({ nodeId: NODE_ID, willReconnect: false })
    expect(harness.registry.view(NODE_ID)?.state).toBe('offline')

    const afterwards = await capture(() => harness.session.invoke('pluginInventory/list'))
    expect(afterwards.code).toBe('coordinator/node-offline')
  })
})

// ---------------------------------------------------------------- streams

describe('streams', () => {
  it('opens a stream with its own id and delivers values in order', async () => {
    const harness = readyHarness()
    const first = harness.session.openStream('session/watch', { topic: 'a' })
    const second = harness.session.openStream('session/watch')

    expect(first.streamId).not.toBe(second.streamId)
    const opens = harness.socket.ofType('stream.open')
    expect(opens).toHaveLength(2)
    expect(opens[0]).toMatchObject({
      nodeId: NODE_ID,
      streamId: first.streamId,
      endpoint: 'session/watch',
      payload: { args: { topic: 'a' } },
    })
    expect(opens[1]?.['streamId']).toBe(second.streamId)
    expect(harness.session.activeStreams).toBe(2)

    const streamId = first.streamId
    harness.socket.receive({ type: 'stream.ready', nodeId: NODE_ID, streamId })
    expect(first.ready).toBe(true)
    for (const [seq, value] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) {
      harness.socket.receive({ type: 'stream.data', nodeId: NODE_ID, streamId, seq, value })
    }
    harness.socket.receive({ type: 'stream.end', nodeId: NODE_ID, streamId, count: 3 })

    const values: unknown[] = []
    for await (const value of first) values.push(value)
    expect(values).toEqual(['a', 'b', 'c'])
    expect(first.count).toBe(3)
    expect(harness.session.activeStreams).toBe(1)

    harness.session.cancelStream(second.streamId)
    expect(harness.session.activeStreams).toBe(0)
  })

  it("rejects the consumer with the node's own code on stream.error", async () => {
    const harness = readyHarness()
    const stream = harness.session.openStream('session/watch')
    const drained = capture(async () => {
      for await (const value of stream) void value
    })

    harness.socket.receive({
      type: 'stream.error',
      nodeId: NODE_ID,
      streamId: stream.streamId,
      count: 0,
      error: { code: 'node/backpressure', message: 'the node is producing too fast', details: {} },
    })

    const failure = await drained
    expect(failure.code).toBe('node/backpressure')
    expect(harness.session.activeStreams).toBe(0)
  })

  it('cancels a stream on the node and closes it for the consumer', async () => {
    const harness = readyHarness()
    const stream = harness.session.openStream('session/watch')
    const drained = capture(async () => {
      for await (const value of stream) void value
    })

    harness.session.cancelStream(stream.streamId, 'the operator stopped it')

    expect((await drained).code).toBe('coordinator/stream-closed')
    // The frame's `reason` is the stream's own diagnosis, with the caller's note
    // inside it: the node's log is the only place an operator sees this.
    expect(sentFrame(harness.socket, 'stream.cancel')).toMatchObject({
      nodeId: NODE_ID,
      streamId: stream.streamId,
      reason: expect.stringContaining('the operator stopped it'),
    })
    expect(harness.session.activeStreams).toBe(0)
  })

  it('fails a stream whose sequence skips a value', async () => {
    const harness = readyHarness()
    const stream = harness.session.openStream('session/watch')
    const drained = capture(async () => {
      for await (const value of stream) void value
    })

    harness.socket.receive({ type: 'stream.data', nodeId: NODE_ID, streamId: stream.streamId, seq: 1, value: 'a' })
    harness.socket.receive({ type: 'stream.data', nodeId: NODE_ID, streamId: stream.streamId, seq: 3, value: 'c' })

    expect((await drained).code).toBe('coordinator/protocol-invalid')
  })
})

// ---------------------------------------------------------------- frame limits

describe('frame limits and malformed frames', () => {
  it('refuses a frame over the negotiated size instead of acting on it', () => {
    const harness = readyHarness({ maxFrameBytes: 1_024 })
    harness.socket.receiveRaw(JSON.stringify({
      type: 'ping',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      padding: 'x'.repeat(2_048),
    }))

    const errors = protocolErrors(harness.events)
    expect(errors.at(-1)?.code).toBe('coordinator/frame-too-large')
    // Refused means refused: the oversized ping produced no pong and no effect.
    expect(harness.socket.ofType('pong')).toHaveLength(0)
    expect(harness.socket.ofType('close')).toHaveLength(0)
    expect(harness.session.state).toBe('ready')
  })

  it('closes a connecting socket whose frame is over the limit', async () => {
    const harness = createHarness({ maxFrameBytes: 1_024 })
    harness.socket.receiveRaw(JSON.stringify({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: NODE_ID,
      mode: 'full-access',
      auth: { type: 'bearer', token: TOKEN },
      padding: 'y'.repeat(2_048),
    }))

    expect(protocolErrors(harness.events).at(-1)?.code).toBe('coordinator/frame-too-large')
    expect(harness.socket.closeCalls.map(call => call.code)).toEqual([1000])
    await settle()
    expect(harness.session.state).toBe('offline')
  })

  it('reports a non-JSON payload without tearing down a ready link', async () => {
    const harness = readyHarness()
    harness.socket.receiveRaw('this is not json{')

    const errors = protocolErrors(harness.events)
    expect(errors.at(-1)?.code).toBe('coordinator/protocol-invalid')
    expect(errors.at(-1)?.details['reason']).toBe('not-json')
    expect(harness.socket.ofType('close')).toHaveLength(0)
    expect(harness.session.state).toBe('ready')

    // The link is still usable, which is the point of not closing it.
    const pending = harness.session.invoke('pluginInventory/list')
    const request = sentFrame(harness.socket, 'rpc.request')
    harness.socket.receive({
      type: 'rpc.result',
      nodeId: NODE_ID,
      requestId: request['requestId'],
      result: { ok: true, value: 'still here' },
    })
    await expect(pending).resolves.toBe('still here')
  })

  it('closes the link on an unsupported protocol version and asks for no reconnect', async () => {
    const harness = readyHarness()
    harness.socket.receiveRaw(JSON.stringify({
      type: 'ping',
      protocolVersion: 'dsh-node/2',
      nodeId: NODE_ID,
    }))

    const close = sentFrame(harness.socket, 'close')
    expect(close).toMatchObject({ code: 'coordinator/protocol-invalid', reconnect: false, nodeId: NODE_ID })
    expect(protocolErrors(harness.events).at(-1)?.details['reason']).toBe('protocol-version')
    expect(harness.socket.closeCalls.map(call => call.code)).toEqual([1000])

    await settle()
    expect(harness.session.state).toBe('offline')
  })
})
