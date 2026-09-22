/**
 * Cross-implementation integration test: the **real** `dsh-node` against the
 * **real** `Coordinator`, in one process, over one real loopback WebSocket.
 *
 * Nothing here is a stand-in for either half of the protocol. The node is the
 * installed `dsh-node` plugin (`DshNodeHost`, driven exactly the way
 * `dsh-node/test/integration.test.ts` drives it, through the structural
 * interfaces it declares); the Coordinator is `src/server.ts`. Neither side
 * imports the other's types, which is the point: a second implementation only
 * agrees with the first if the wire really is specified, so every assertion
 * below is about **agreement**, not about one side's internal behaviour.
 *
 * Two things are faked, and both are *outside* the protocol:
 *
 * - `ctx.typertGateway` / `ctx.typert` — the local DSH Gateway and registry. A
 *   fake is required, not optional: the real Gateway ships with DSH, and this
 *   package is the Coordinator. The fake is deliberately dumb (it records what
 *   it was asked and answers from a switch) because its whole job here is to be
 *   the *evidence* that a forwarded call reached a business method with exactly
 *   the arguments the Coordinator sent (`assertExactArguments`).
 * - the identity file location — a fresh file under `test/.tmp/`, so the suite
 *   never reads or writes the operator's real `~/.dsh/storages/dsh-node`.
 *
 * Everything the protocol owns is real: the `ws` client and server, the frame
 * codecs, the connector's state machine, the session's admission rules, the
 * request table, the stream hub, heartbeats, and the registry.
 *
 * Two assertions in this file are expected to fail. They are marked
 * `// SUSPECTED SOURCE BUG` and explained in place and in the report:
 *
 * 1. a successful `rpc.result` whose value is `undefined` loses its `value`
 *    field to JSON, and the Coordinator then strands the call until its deadline;
 * 2. a credential refusal never reaches `dshNode.status().lastError`, because
 *    the host snapshot is built from a field the connector never writes.
 *
 * @module dsh-coordinator/test/cross-implementation
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DshNodeHost,
  resolveNodeConfig,
  type DshNodeHostOptions,
  type InvocationDescriptorLike,
  type NodeHostContext,
  type TypertGatewayLike,
  type TypertRegistryLike,
} from 'dsh-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  Coordinator,
  CoordinatorError,
  silentLogger,
  type CoordinatorAddress,
  type NodeView,
  type SessionEvent,
} from '../src/index.js'
import { waitFor } from './helpers.js'

/** The bearer credential both ends are configured with. */
const TOKEN = 'cross-implementation-secret'

/** Namespace every fake Remote lives in. */
const NS = 'demo'

/** Where the node's identity file is created. Never the user's real `~/.dsh`. */
const TMP_ROOT = join(process.cwd(), 'test', '.tmp')

/** Canonical endpoints of the fake surface. */
const ECHO = `${NS}/echo`
const FAIL = `${NS}/fail`
const RETURNS_NOTHING = `${NS}/returnsNothing`
const WATCH = `${NS}/watch`

/**
 * The surface the node will advertise, in the order `collectCapabilities` sorts
 * it: `endpoint:mode`, one entry per descriptor in {@link DESCRIPTORS}.
 */
const ADVERTISED_SURFACE = [`${ECHO}:unary`, `${FAIL}:unary`, `${RETURNS_NOTHING}:unary`, `${WATCH}:stream`]

// ------------------------------------------------------------------ fixtures

/**
 * A DSH-shaped Remote failure.
 *
 * `isDSHRemoteError` is the structural marker DSH itself recognises, so this is
 * the same shape a real business Remote throws — the point being that the code
 * must survive two frames and a socket unchanged.
 */
class FakeRemoteError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  readonly isDSHRemoteError = true

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.details = details
  }
}

/** One request as the fake Gateway received it. Deliberately three fields. */
interface ReceivedInvocation {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
}

/** What the node hands `ctx.typertGateway.invoke` / `.stream`. */
interface GatewayRequest {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}

/**
 * The fake local Gateway.
 *
 * It implements `TypertGatewayLike` structurally, so the compiler — not a
 * comment — guarantees this is the interface the node actually calls. Its
 * recording arrays are the evidence for "the arguments arrived intact" and for
 * "an unadvertised endpoint never reached a business method".
 */
class FakeGateway implements TypertGatewayLike {
  /** Every unary dispatch, in order, exactly as it arrived. */
  readonly invocations: ReceivedInvocation[] = []
  /** Every stream dispatch, in order, exactly as it arrived. */
  readonly streamOpens: ReceivedInvocation[] = []

  async invoke(request: GatewayRequest): Promise<unknown> {
    this.invocations.push({ namespace: request.namespace, method: request.method, args: request.args })
    const endpoint = `${request.namespace}/${request.method}`
    switch (endpoint) {
      case ECHO:
        return { echoed: request.args }
      case FAIL:
        // A business failure: the code is the node's to preserve, not to invent.
        throw new FakeRemoteError('session/not-found', 'the fixture has no such session', {
          sessionId: 'missing-session',
        })
      case RETURNS_NOTHING:
        // A `void`-shaped Remote. Legal in TypeScript, and the interesting case
        // for any protocol that carries JSON.
        return undefined
      default:
        // What the real Gateway answers for a method it does not export; the
        // node folds this family into `node/capability-unavailable`.
        throw new FakeRemoteError('gateway/method-unavailable', `no method "${endpoint}" is registered`, {
          endpoint,
        })
    }
  }

  async stream(request: GatewayRequest): Promise<AsyncIterable<unknown>> {
    this.streamOpens.push({ namespace: request.namespace, method: request.method, args: request.args })
    const endpoint = `${request.namespace}/${request.method}`
    if (endpoint !== WATCH) {
      throw new FakeRemoteError('gateway/method-unavailable', `no stream "${endpoint}" is registered`, { endpoint })
    }
    const count = typeof request.args['count'] === 'number' ? request.args['count'] : 0
    return (async function* generate(): AsyncIterable<unknown> {
      for (let index = 1; index <= count; index += 1) yield { n: index }
    })()
  }

  /**
   * The Gateway's own carrier-safe projection, which is exactly what the real
   * HTTP/WebSocket carriers use — so a business code keeps its identity here by
   * the same rule it does in production.
   */
  readonly wireStream = {
    failure: (error: unknown): { code: string; message: string; details: object } => {
      if (error instanceof FakeRemoteError) {
        return { code: error.code, message: error.message, details: error.details }
      }
      return {
        code: 'gateway/internal',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      }
    },
  }
}

/**
 * The descriptors the node will advertise.
 *
 * Two unary methods, one `void`-shaped unary method, and one stream method: the
 * smallest surface that exercises both carriers, the failure path, and the
 * carrier/gateway asymmetry the protocol requires.
 */
const DESCRIPTORS: readonly InvocationDescriptorLike[] = [
  { namespace: NS, method: 'echo' },
  { namespace: NS, method: 'fail' },
  { namespace: NS, method: 'returnsNothing' },
  { namespace: NS, method: 'watch', mode: 'stream' },
]

/** The fake `ctx.typert`: only `local.list()` is what the node advertises from. */
function createFakeRegistry(descriptors: readonly InvocationDescriptorLike[]): TypertRegistryLike {
  const byEndpoint = new Map(descriptors.map(descriptor => [`${descriptor.namespace}/${descriptor.method}`, descriptor]))
  return {
    local: {
      get: endpoint => byEndpoint.get(endpoint),
      hasSeen: endpoint => byEndpoint.has(endpoint),
      list: () => descriptors,
      // The node subscribes to invalidate its capability cache. Nothing changes
      // during a test, so the disposer does nothing.
      subscribe: () => () => {},
    },
  }
}

/**
 * Build the host context the node reads its collaborators from.
 *
 * `DshNodeHost` reaches its services through `ctx.get(key, strict?)` and nothing
 * else — no `reflect`, no `effect`, no `provide` — so a hand-made object is both
 * sufficient and more honest than a real Cordis `Context` would be here: this
 * package does not (and should not) depend on Cordis just to run a test. The
 * structural cast is checked by the compiler against `NodeHostContext`.
 *
 * `reflect` is deliberately absent: with no `props`, `sourceModeNamespaces()`
 * finds nothing, so the advertised surface is exactly {@link DESCRIPTORS}.
 */
function createHostContext(gateway: FakeGateway, registry: TypertRegistryLike): NodeHostContext {
  const services = new Map<string, unknown>([
    ['typert', registry],
    ['typertGateway', gateway],
  ])
  const ctx = {
    typertGateway: gateway,
    get: (key: string) => services.get(key),
  }
  return ctx as unknown as NodeHostContext
}

/** What one observed socket carried, in each direction. */
interface FrameTally {
  /** Frame types the Coordinator sent, in order. */
  readonly fromCoordinator: string[]
  /** Frame types the node sent, in order. */
  readonly fromNode: string[]
  /** Whole frames the node sent, so a test can assert on wire fields. */
  readonly nodeFrames: Record<string, unknown>[]
}

/** How many frames of one type crossed in one direction. */
function countFrames(tally: readonly string[], type: string): number {
  return tally.filter(entry => entry === type).length
}

/** The first frame the node sent of one type. */
function nodeFrame(tally: FrameTally, type: string): Record<string, unknown> | undefined {
  return tally.nodeFrames.find(frame => frame['type'] === type)
}

/**
 * Recompute the surface digest from the documented rule.
 *
 * `dsh-node`'s `protocol.ts` specifies `remoteSurfaceHash` as "a sha256 over the
 * sorted endpoint+mode list" plus the namespaces that cannot be enumerated. This
 * package deliberately does not import the node's implementation of it, so the
 * digest is recomputed here from the rule instead — which is also what makes the
 * `namespaces` finding in the last test verifiable: a digest that matches the
 * remotes alone proves the opaque-namespace list was empty even though
 * `namespaces` itself was not.
 */
function surfaceHash(remotes: readonly { readonly endpoint: string; readonly mode: string }[], namespaces: readonly string[]): string {
  const surface = [
    ...remotes.map(entry => `${entry.mode} ${entry.endpoint}`),
    ...namespaces.map(namespace => `namespace ${namespace}`),
  ]
  return `sha256:${createHash('sha256').update(surface.join('\n'), 'utf8').digest('hex')}`
}

/** One socket factory, typed off the node's own option surface. */
type NodeSocketFactoryLike = NonNullable<DshNodeHostOptions['createSocket']>

/**
 * A socket factory that observes frames without replacing the transport.
 *
 * The real `ws` client is still the socket; this only records what crosses it.
 * That is how "the node answered the Coordinator's ping" becomes a *direct*
 * observation instead of an inference from the connection still being up, and how
 * the handshake frames can be asserted on their wire fields rather than through
 * the Coordinator's interpretation of them.
 */
function tallyingSocketFactory(tally: FrameTally): NodeSocketFactoryLike {
  return (url: string) => {
    const socket = new WebSocket(url)
    // Only the node's own frames are kept whole (they are what this suite asserts
    // on); the Coordinator's frames are counted from the type alone.
    const record = (types: string[], data: unknown, frames?: Record<string, unknown>[]): void => {
      try {
        const parsed = JSON.parse(String(data)) as Record<string, unknown>
        const type = parsed['type']
        types.push(typeof type === 'string' ? type : '?')
        frames?.push(parsed)
      } catch {
        types.push('?')
      }
    }
    return {
      get readyState(): number {
        return socket.readyState
      },
      send(data: string): void {
        record(tally.fromNode, data, tally.nodeFrames)
        socket.send(data)
      },
      close(code?: number, reason?: string): void {
        socket.close(code, reason)
      },
      terminate(): void {
        socket.terminate()
      },
      on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): unknown {
        if (event === 'message') {
          socket.on('message', data => {
            record(tally.fromCoordinator, data)
            ;(listener as (value: unknown) => void)(data)
          })
        } else if (event === 'close') {
          socket.on('close', (code, reason) => { (listener as (code: number, reason: unknown) => void)(code, reason) })
        } else if (event === 'error') {
          socket.on('error', error => { (listener as (error: Error) => void)(error) })
        } else {
          socket.on('open', () => { (listener as () => void)() })
        }
        return socket
      },
    }
  }
}

// --------------------------------------------------------------------- suite

describe('the real dsh-node against the real Coordinator', () => {
  let coordinators: Coordinator[] = []
  let hosts: DshNodeHost[] = []
  /** The Coordinator every test in this file starts with. */
  let coordinator: Coordinator
  /** Every session event the primary Coordinator emitted. */
  let events: SessionEvent[] = []
  let gateway: FakeGateway
  let tally: FrameTally
  let tmpDir: string
  let identityFile: string

  /** Options for one node host, all defaulted to a fast, loopback-only setup. */
  interface NodeOverrides {
    readonly heartbeatIntervalMs?: number
    readonly reconnectMaxDelayMs?: number
    readonly createSocket?: NodeSocketFactoryLike
  }

  beforeEach(async () => {
    await mkdir(TMP_ROOT, { recursive: true })
    tmpDir = await mkdtemp(join(TMP_ROOT, 'cross-impl-'))
    identityFile = join(tmpDir, 'identity.json')
    gateway = new FakeGateway()
    tally = { fromCoordinator: [], fromNode: [], nodeFrames: [] }
    events = []
    hosts = []
    coordinators = []
    coordinator = createCoordinator()
    await coordinator.start()
  })

  afterEach(async () => {
    // Hosts first: a live node would otherwise keep dialling a listener that is
    // already gone. Both halves are disposed before the temp files disappear.
    for (const host of [...hosts].reverse()) await host.stop('test teardown')
    hosts = []
    for (const instance of [...coordinators].reverse()) await instance.stop()
    coordinators = []
    await rm(tmpDir, { recursive: true, force: true })
  })

  // ------------------------------------------------------------- test helpers

  /**
   * A Coordinator on an ephemeral loopback port.
   *
   * Enrollment is `shared-secret` because a real node mints its own `nodeId`
   * before it ever talks to a Coordinator, so there is nothing for this test to
   * pre-register either — that is the documented first-contact flow.
   */
  function createCoordinator(options: { readonly port?: number; readonly heartbeatIntervalMs?: number } = {}): Coordinator {
    const instance = new Coordinator({
      port: options.port ?? 0,
      host: '127.0.0.1',
      enrollment: { kind: 'shared-secret', token: TOKEN },
      logger: silentLogger,
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      onEvent: event => { events.push(event) },
    })
    coordinators.push(instance)
    return instance
  }

  /** The bound address, or a clear failure instead of an `undefined` deref. */
  function addressOf(instance: Coordinator): CoordinatorAddress {
    const address = instance.address
    if (address === undefined) throw new Error('the Coordinator is not listening')
    return address
  }

  /** Build and start a real node host pointed at the primary Coordinator. */
  function createNode(overrides: NodeOverrides = {}): DshNodeHost {
    const resolution = resolveNodeConfig(
      {
        coordinatorUrl: addressOf(coordinator).url,
        // The one piece of state that must be real: the node persists its
        // identity, and a test must never touch the operator's own file.
        identityFile,
        nodeName: 'cross-implementation-node',
        role: 'test-fixture',
        mode: 'full-access',
        auth: { token: TOKEN },
        heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 250,
        handshakeTimeoutMs: 3_000,
        requestTimeoutMs: 5_000,
        maxFrameBytes: 1_048_576,
        maxInFlightRequests: 8,
        reconnect: {
          initialDelayMs: 30,
          maxDelayMs: overrides.reconnectMaxDelayMs ?? 150,
          jitterRatio: 0,
          stableResetMs: 100,
        },
      },
      {},
    )
    if (resolution.status !== 'ok') {
      throw new Error(`the node config was rejected: ${resolution.errors.join('; ')}`)
    }
    const host = new DshNodeHost({
      ctx: createHostContext(gateway, createFakeRegistry(DESCRIPTORS)),
      resolution,
      // An empty environment keeps the run hermetic: no `DSH_NODE_TOKEN`, no
      // `DSH_HOME`, no log-level surprises from the machine running the suite.
      env: {},
      // The default sink is `console`; a cross-implementation test that prints
      // every state change is unreadable.
      logSink: () => {},
      ...(overrides.createSocket === undefined ? {} : { createSocket: overrides.createSocket }),
    })
    hosts.push(host)
    return host
  }

  /** Start a node and wait until *both* ends agree the link is ready. */
  async function connectReady(node: DshNodeHost, instance: Coordinator = coordinator): Promise<NodeView> {
    await node.start()
    await waitFor(() => instance.listNodes().some(view => view.state === 'ready'), {
      timeoutMs: 5_000,
      label: 'the Coordinator to report a ready node',
    })
    await waitFor(() => node.status.state === 'ready', {
      timeoutMs: 5_000,
      label: "the node's own status to report ready",
    })
    const view = instance.node(node.nodeId)
    if (view === undefined) throw new Error('the Coordinator has no record of the node it just admitted')
    return view
  }

  /** A Coordinator error, however the call was refused. */
  async function catchFailure(promise: Promise<unknown>): Promise<CoordinatorError> {
    try {
      await promise
    } catch (error) {
      if (error instanceof CoordinatorError) return error
      throw error
    }
    throw new Error('the call unexpectedly resolved')
  }

  // ---------------------------------------------------------------- 1. hello

  it('agrees on the handshake: one ready node carrying the advertised surface', async () => {
    // The observing socket factory is used here too, so the handshake can be
    // checked on the frames themselves and not only through either end's view.
    const node = createNode({ createSocket: tallyingSocketFactory(tally) })
    const view = await connectReady(node)

    // The Coordinator's view of the connection.
    expect(view.state).toBe('ready')
    expect(view.nodeId).toBe(node.nodeId)
    expect(view.connectionId).toBeTruthy()
    expect(view.revoked).toBe(false)
    expect(view.capabilityCount).toBe(DESCRIPTORS.length)

    // The node's own view of the same connection: same identity, same
    // connection id, so `hello.ok` was understood by both ends.
    const status = node.status
    expect(status.state).toBe('ready')
    expect(status.nodeId).toBe(view.nodeId)
    expect(status.connectionId).toBe(view.connectionId)
    expect(status.reconnectAttempt).toBe(0)

    // The identity is the persisted one, not one invented per connection.
    const persisted = JSON.parse(await readFile(identityFile, 'utf8')) as { nodeId: string }
    expect(persisted.nodeId).toBe(view.nodeId)
    expect(persisted.nodeId).toMatch(/^node-[0-9a-f]{32}$/u)

    // The advertised surface is the fake registry's, endpoint for endpoint...
    const summary = node.capabilitySummary()
    expect(summary.remotes.map(entry => `${entry.endpoint}:${entry.mode}`)).toEqual(ADVERTISED_SURFACE)
    // ...and the digest of it survived verbatim, so a Coordinator can detect a
    // changed surface without receiving the descriptors again.
    expect(summary.remoteSurfaceHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(view.remoteSurfaceHash).toBe(summary.remoteSurfaceHash)
    // The summary the Coordinator stored is byte-for-byte what the node sent.
    expect(coordinator.registry.capabilitiesOf(view.nodeId)).toEqual(summary)

    // The frames themselves: the fields the protocol requires, as they went out.
    const hello = nodeFrame(tally, 'hello')
    expect(hello).toMatchObject({
      protocolVersion: 'dsh-node/1',
      nodeId: view.nodeId,
      mode: 'full-access',
      nodeName: 'cross-implementation-node',
      role: 'test-fixture',
      auth: { type: 'bearer', token: TOKEN },
    })
    const ready = nodeFrame(tally, 'ready')
    // `connectionId` is the one field whose absence the node treats as fatal
    // (COORDINATOR.md §2), so the echo is asserted explicitly.
    expect(ready).toMatchObject({
      protocolVersion: 'dsh-node/1',
      nodeId: view.nodeId,
      connectionId: view.connectionId,
    })
    const capabilities = ready?.['capabilities'] as { readonly remoteSurfaceHash?: string } | undefined
    const dsh = ready?.['dsh'] as { readonly remoteSurfaceHash?: string } | undefined
    // Two spellings of one digest: COORDINATOR.md §3.2 reads the surface hash from
    // `ready.dsh.remoteSurfaceHash`, while this Coordinator stores
    // `ready.capabilities.remoteSurfaceHash`. The node sends both with the same
    // value, so either reading is correct — which is the agreement asserted here.
    expect(dsh?.remoteSurfaceHash).toBe(view.remoteSurfaceHash)
    expect(capabilities?.remoteSurfaceHash).toBe(view.remoteSurfaceHash)
  })

  // ---------------------------------------------------------------- 2. unary

  it('forwards a unary call and hands the Gateway exactly {namespace, method, args}', async () => {
    const node = createNode()
    const view = await connectReady(node)
    const args = { someArg: { nested: [1, 'two', { three: true }] }, other: 'kept' }

    const value = await coordinator.invoke(view.nodeId, ECHO, args)

    expect(value).toEqual({ echoed: args })

    // The `assertExactArguments` contract: the Gateway sees the args object the
    // Coordinator sent — no field added, renamed, or dropped, and no transport
    // metadata smuggled alongside it.
    expect(gateway.invocations).toHaveLength(1)
    const received = gateway.invocations[0]
    if (received === undefined) throw new Error('the Gateway was never called')
    expect(received).toEqual({ namespace: NS, method: 'echo', args })
    expect(Object.keys(received)).toEqual(['namespace', 'method', 'args'])
    expect(Object.keys(received.args).sort()).toEqual(['other', 'someArg'])

    // Settled on both sides: the call is no longer in flight anywhere.
    await waitFor(() => node.status.inFlightRequests === 0 && coordinator.node(view.nodeId)?.inFlightRequests === 0, {
      timeoutMs: 2_000,
      label: 'both ends to have no call in flight',
    })
  })

  // -------------------------------------------------------------- 3. failures

  it('carries a business failure code across the boundary unchanged', async () => {
    const node = createNode()
    const view = await connectReady(node)

    const failure = await catchFailure(coordinator.invoke(view.nodeId, FAIL, {}))

    expect(failure).toBeInstanceOf(CoordinatorError)
    // The exact code the fake Remote threw: not flattened into the Coordinator's
    // own vocabulary, and not the `internal` that a non-business boundary failure
    // would produce on some DSH builds.
    expect(failure.code).toBe('session/not-found')
    expect(failure.code).not.toBe('coordinator/internal')
    expect(failure.code).not.toBe('internal')
    expect(failure.message).toBe('the fixture has no such session')
    expect(failure.details).toEqual({ sessionId: 'missing-session' })
    // It really was the business method that ran.
    expect(gateway.invocations.map(entry => entry.method)).toEqual(['fail'])
  })

  // ------------------------------------------------- 4. the `undefined` value

  it('carries a Remote result of `undefined` through as an empty success', async () => {
    const node = createNode()
    const view = await connectReady(node)

    const outcome = await coordinator
      .invoke(view.nodeId, RETURNS_NOTHING, {}, { timeoutMs: 400 })
      .then(
        value => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )

    // The business method did run and did succeed locally.
    expect(gateway.invocations.map(entry => entry.method)).toEqual(['returnsNothing'])
    expect(node.status.inFlightRequests).toBe(0)

    // The node encodes `{ok:true, value: undefined}` and `JSON.stringify` drops the
    // key, so the wire frame is `{ok:true}`. That is not a malformed frame: JSON
    // cannot represent `undefined`, so an empty success *has* to look like this.
    // The Coordinator therefore reads a missing `value` as `undefined`
    // (`frame-codec.ts#validateBody`) instead of refusing the frame — refusing it
    // would leave the caller waiting out its deadline for a call that already
    // succeeded, and report `coordinator/request-timeout` for a transport that was
    // never at fault.
    expect(events.some(event => event.type === 'protocol-error')).toBe(false)
    expect(outcome).toEqual({ kind: 'resolved', value: undefined })
  })

  // --------------------------------------------------------------- 5. streams

  it('streams every value in order, ends with the node\'s count, and releases the stream', async () => {
    const node = createNode()
    const view = await connectReady(node)

    const stream = coordinator.openStream(view.nodeId, WATCH, { count: 3 })
    const values: unknown[] = []
    for await (const value of stream) values.push(value)

    // `stream.data.seq` is checked by the Coordinator's hub (a gap fails the
    // stream), so a complete, ordered sequence here is protocol agreement.
    expect(values).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(await stream.closed).toMatchObject({ ok: true, count: 3, reason: 'end' })
    expect(gateway.streamOpens).toEqual([{ namespace: NS, method: 'watch', args: { count: 3 } }])

    // Both ends agree the stream is gone; no `stream.cancel` was needed.
    await waitFor(() => coordinator.node(view.nodeId)?.activeStreams === 0 && node.status.activeStreams === 0, {
      timeoutMs: 2_000,
      label: 'both ends to report no active streams',
    })
    expect(coordinator.stats().activeStreams).toBe(0)
    expect(node.status.activeStreams).toBe(0)
    expect(events.some(event => event.type === 'closed')).toBe(false)
  })

  // ------------------------------------------------------------ 6. heartbeats

  it('agrees on heartbeats: both ends answer pings for several intervals', async () => {
    // A fast Coordinator cadence: the default 30 s would not exercise anything in
    // a test, and `hello.ok` only ever *tightens* the node's own interval.
    await coordinator.stop()
    coordinator = createCoordinator({ heartbeatIntervalMs: 300 })
    await coordinator.start()

    // The Coordinator pings every 300 ms; the node keeps its own 100 ms cadence
    // (it takes `min(local, advertised)`) and tolerates two missed intervals, so
    // its window is 200 ms — *shorter* than the Coordinator's ping cadence. A node
    // that survived this window can only have been receiving `pong`s in reply to
    // its own pings, which is precisely the rule COORDINATOR.md §2 calls out as
    // "not stated in the spec but required by the node".
    const node = createNode({ heartbeatIntervalMs: 100, createSocket: tallyingSocketFactory(tally) })
    const view = await connectReady(node)
    // Counts, not a copy of the tally: the recorder keeps pushing into the same
    // arrays, so a shallow snapshot would appear to never change.
    const before = {
      coordinatorPings: countFrames(tally.fromCoordinator, 'ping'),
      nodePongs: countFrames(tally.fromNode, 'pong'),
      nodePings: countFrames(tally.fromNode, 'ping'),
    }

    await waitFor(
      () =>
        countFrames(tally.fromCoordinator, 'ping') - before.coordinatorPings >= 3 &&
        countFrames(tally.fromNode, 'pong') - before.nodePongs >= 3 &&
        countFrames(tally.fromNode, 'ping') - before.nodePings >= 3,
      { timeoutMs: 6_000, label: 'three heartbeat rounds in both directions' },
    )

    // Three of the Coordinator's intervals and at least three of the node's, with
    // the same connection id throughout: nothing flapped and nothing reconnected.
    expect(node.status.state).toBe('ready')
    expect(node.status.connectionId).toBe(view.connectionId)
    expect(coordinator.node(view.nodeId)?.connectionId).toBe(view.connectionId)
    expect(coordinator.sessions()).toHaveLength(1)
    expect(events.filter(event => event.type === 'ready')).toHaveLength(1)
    expect(events.filter(event => event.type === 'closed')).toHaveLength(0)
  })

  // ------------------------------------------------------------ 7. revocation

  it('closes the link on revocation and the node takes the credential-refusal path', async () => {
    // A long `maxDelayMs` keeps the node in `auth_failed` for the duration of the
    // assertions instead of retrying every 150 ms: that retry delay *is* the
    // documented behaviour for a refused credential, and it is observable here.
    const node = createNode({ reconnectMaxDelayMs: 5_000 })
    const view = await connectReady(node)

    const revoked = coordinator.revokeNode(view.nodeId)
    expect(revoked.revoked).toBe(true)

    // The node leaves `ready` and names the reason in its own vocabulary.
    await waitFor(() => node.status.state === 'auth_failed', {
      timeoutMs: 5_000,
      label: "the node to report its auth_failed state",
    })
    expect(node.status.state).not.toBe('ready')
    expect(node.status.connectionId).toBeUndefined()
    // Its slow, bounded retry budget is armed rather than a hot reconnect loop.
    expect(events.some(event => event.type === 'closed')).toBe(true)

    // The Coordinator's side of the same event: registered, revoked, offline.
    await waitFor(() => coordinator.node(view.nodeId)?.state !== 'ready', {
      timeoutMs: 2_000,
      label: 'the Coordinator to drop the connection',
    })
    expect(coordinator.listNodes().filter(entry => entry.state === 'ready')).toHaveLength(0)
    expect(coordinator.node(view.nodeId)?.revoked).toBe(true)
    expect(coordinator.sessions().filter(session => session.state === 'ready')).toHaveLength(0)
  })

  // --------------------------------------------- 8. why the link actually ended

  it('reports a refused credential in the node status a Coordinator can read', async () => {
    const node = createNode({ reconnectMaxDelayMs: 5_000 })
    const view = await connectReady(node)
    coordinator.revokeNode(view.nodeId)

    await waitFor(() => node.status.state === 'auth_failed', {
      timeoutMs: 5_000,
      label: "the node to report its auth_failed state",
    })
    // The state is right, and it is the node's own vocabulary for a refused
    // credential (`connector.ts` AUTH_CLOSE_CODES -> enterAuthFailed).
    expect(node.status.state).toBe('auth_failed')

    // This test found a real defect on the node side, since fixed: the connector
    // recorded the cause in `connector.snapshot.lastError`
    // (`node/auth-failed`), but `DshNodeHost.status` built its snapshot from
    // `this.currentError`, which only host-level failures (invalid config, unusable
    // identity file) ever write. The one surface an operator or a Coordinator can
    // read — `ctx.dshNode.status()`, `nodeAdmin/status`, `nodeAdmin/describe` —
    // therefore reported `state: 'auth_failed'` with no code and no message, and a
    // revoked token was indistinguishable from a crash loop. The node now falls
    // back to the connector's snapshot, and this assertion is what keeps it.
    expect(node.status.lastError?.code).toBe('node/auth-failed')
  })

  // ------------------------------------------------------------- 9. reconnect

  it('a Coordinator restarted on the same port ends up with exactly one ready connection', async () => {
    const node = createNode()
    const first = await connectReady(node)
    const port = addressOf(coordinator).port

    await coordinator.stop()
    await waitFor(() => node.status.state !== 'ready', {
      timeoutMs: 5_000,
      label: 'the node to notice that the Coordinator stopped',
    })
    expect(coordinator.listNodes().filter(view => view.state === 'ready')).toHaveLength(0)

    // A node's Coordinator URL is fixed, so a restart is only observable by a real
    // node if the new listener takes the port the old one freed. Port 0 would hand
    // out a fresh port and the node would never come back.
    const restarted = createCoordinator({ port })
    await restarted.start()

    await waitFor(() => restarted.listNodes().some(view => view.state === 'ready'), {
      timeoutMs: 8_000,
      label: 'the node to reconnect to the restarted Coordinator',
    })
    const views = restarted.listNodes()
    expect(views).toHaveLength(1)
    const second = views[0]
    if (second === undefined) throw new Error('the restarted Coordinator has no node')
    expect(second.state).toBe('ready')
    expect(second.nodeId).toBe(first.nodeId)
    // A new connection, not a resurrected one.
    expect(second.connectionId).toBeTruthy()
    expect(second.connectionId).not.toBe(first.connectionId)
    expect(node.status.connectionId).toBe(second.connectionId)
    // Exactly one live connection, and it is the ready one.
    expect(restarted.stats().sessions).toBe(1)
    expect(restarted.sessions().filter(session => session.state === 'ready')).toHaveLength(1)

    // And the new link is not merely present: it serves calls.
    expect(await restarted.invoke(second.nodeId, ECHO, { after: 'restart' })).toEqual({
      echoed: { after: 'restart' },
    })
  })

  // --------------------------------------------------------- 10. no duplicates

  it('never reports two live connections for one node as ready', async () => {
    const first = createNode()
    const firstView = await connectReady(first)

    // A second DSH process on the same machine looks exactly like this: the same
    // persisted identity file, so the same `nodeId`, and a second outbound socket.
    const second = createNode()
    await second.start()

    await waitFor(() => coordinator.node(firstView.nodeId)?.connectionId !== firstView.connectionId, {
      timeoutMs: 5_000,
      label: 'the newer connection to replace the older one',
    })

    const view = coordinator.node(firstView.nodeId)
    expect(view?.state).toBe('ready')
    // The invariant from COORDINATOR.md §3.2: a node id maps to one live
    // connection, and never to two that are both ready.
    const readySessions = coordinator.sessions().filter(session => session.state === 'ready')
    expect(readySessions).toHaveLength(1)
    expect(readySessions[0]?.connectionId).toBe(view?.connectionId)
    expect(coordinator.listNodes().filter(entry => entry.state === 'ready')).toHaveLength(1)

    // The displaced connection is told not to reconnect (`reconnect: false`), so
    // it stops for good rather than fighting for the identity.
    await waitFor(() => first.status.state === 'stopped', {
      timeoutMs: 3_000,
      label: 'the displaced connection to stop',
    })
    expect(second.status.state).toBe('ready')
    expect(second.status.connectionId).toBe(view?.connectionId)
    expect([first.status.state, second.status.state].filter(state => state === 'ready')).toHaveLength(1)

    await waitFor(() => coordinator.sessions().length === 1, {
      timeoutMs: 3_000,
      label: 'the replaced session to be forgotten',
    })
  })

  // ------------------------------------------------- 11. capability disagreement

  it('reads `namespaces` as "the node decides here", and refuses a namespace it never mentioned', async () => {
    const node = createNode()
    const view = await connectReady(node)

    // The node's declaration: `namespaces` lists *every* namespace it will
    // dispatch, including the one whose methods it just enumerated; the digest is
    // computed over the opaque subset alone. That is the field's contract — it
    // guarantees the negative (a namespace absent from it is never dispatched), not
    // that every namespace in it is unenumerable.
    const summary = node.capabilitySummary()
    expect(summary.namespaces).toEqual([NS])
    expect(summary.remoteSurfaceHash).toBe(surfaceHash(summary.remotes, []))

    // Consequence at the Coordinator's gate: inside a namespace the node will
    // dispatch, a method absent from `remotes` may still exist, so the node is the
    // authority — a typo comes back as `node/capability-unavailable` rather than
    // being refused locally with `coordinator/capability-mismatch`.
    const forwarded = await catchFailure(coordinator.invoke(view.nodeId, `${NS}/nonexistent`, {}))
    expect(forwarded.code).toBe('node/capability-unavailable')
    expect(forwarded.code).not.toBe('coordinator/capability-mismatch')
    // It really did reach the local Gateway, which is the authority that refused it.
    expect(gateway.invocations.map(entry => entry.method)).toEqual(['nonexistent'])

    // The Coordinator's own gate does still fire for a namespace the node never
    // mentioned — and then nothing is sent at all.
    const refusedLocally = await catchFailure(coordinator.invoke(view.nodeId, 'nope/missing', {}))
    expect(refusedLocally.code).toBe('coordinator/capability-mismatch')
    expect(gateway.invocations).toHaveLength(1)
  })
})
