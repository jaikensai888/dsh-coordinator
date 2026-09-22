/**
 * Shared test fixtures for the Coordinator suite.
 *
 * Two rules keep this file useful rather than a place where tests hide:
 *
 * - everything here is **observable** (a socket that records frames, a clock a
 *   test advances by hand, a predicate waiter) and none of it asserts;
 * - the in-memory socket double speaks the real frame vocabulary, so a test that
 *   passes against it is testing the service's logic, not a shortcut.
 *
 * @module dsh-coordinator/test/helpers
 */

import { WebSocket } from 'ws'
import { encodeFrame, toFrameText, type RawFrameData } from '../src/frame-codec.js'
import type { CoordinatorSocket } from '../src/session.js'
import type { TimerHandle, TimerSource } from '../src/timers.js'
import { PROTOCOL_VERSION, type AnyFrame, type NodeCapabilitySummary } from '../src/protocol.js'

/** WebSocket `readyState` for an open socket. */
export const OPEN = 1
/** WebSocket `readyState` after `close()`. */
export const CLOSED = 3

/** A clock the test drives. */
export interface ManualTimers extends TimerSource {
  /** Run every callback scheduled at or before `now + ms`, advancing the clock. */
  advance(ms: number): Promise<void>
  /** Current virtual time. */
  now(): number
  /** Number of callbacks still scheduled. */
  pending(): number
}

/**
 * A virtual clock.
 *
 * Advancing hops through a macrotask first so that promises already resolved at
 * the current instant (a handler that `await`s) settle before the next timer
 * fires — without that, a test can observe an intermediate state that production
 * never exposes.
 * @returns the clock.
 */
export function createManualTimers(): ManualTimers {
  let current = 0
  let seq = 0
  const scheduled = new Map<number, { at: number; callback: () => void }>()

  return {
    now: () => current,
    setTimeout: (callback, ms) => {
      seq += 1
      const id = seq
      scheduled.set(id, { at: current + Math.max(0, ms), callback })
      const handle: TimerHandle = { cancel: () => { scheduled.delete(id) } }
      return handle
    },
    pending: () => scheduled.size,
    advance: async (ms) => {
      const target = current + ms
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
        const next = due[0]
        if (next === undefined) break
        scheduled.delete(next[0])
        current = next[1].at
        next[1].callback()
        // Let anything the callback resolved run before the next timer.
        await new Promise<void>(resolve => { setImmediate(resolve) })
      }
      current = target
      await new Promise<void>(resolve => { setImmediate(resolve) })
    },
  }
}

/** A recorded outbound frame. */
export interface SentFrame {
  readonly type: string
  readonly [key: string]: unknown
}

/**
 * An in-memory socket that records what the service sends and lets a test inject
 * inbound frames.
 */
export interface ScriptedSocket extends CoordinatorSocket {
  /** Frames the service has sent, decoded. */
  readonly sent: SentFrame[]
  /** Frames of one type the service has sent. */
  ofType(type: string): SentFrame[]
  /** The most recent frame of a type, or undefined. */
  lastOfType(type: string): SentFrame | undefined
  /** Deliver a frame as if the node sent it. */
  receive(frame: Record<string, unknown>): void
  /** Deliver raw text, for malformed-frame tests. */
  receiveRaw(text: string): void
  /** Simulate the peer closing the socket. */
  remoteClose(code?: number, reason?: string): void
  /** Whether `close()` was called, with its arguments. */
  readonly closeCalls: readonly { readonly code: number | undefined; readonly reason: string | undefined }[]
  /** Whether `terminate()` was called. */
  terminated(): boolean
}

/**
 * Build a scripted socket.
 * @param options - whether the socket starts open.
 * @returns the double.
 */
export function createScriptedSocket(options: { readonly open?: boolean } = {}): ScriptedSocket {
  let readyState = options.open === false ? CLOSED : OPEN
  const sent: SentFrame[] = []
  const closeCalls: { code: number | undefined; reason: string | undefined }[] = []
  const messageListeners: ((data: RawFrameData) => void)[] = []
  const closeListeners: ((code: number, reason: unknown) => void)[] = []
  const errorListeners: ((error: Error) => void)[] = []
  let terminated = false

  return {
    get readyState(): number {
      return readyState
    },
    sent,
    closeCalls,
    terminated: () => terminated,
    ofType: type => sent.filter(frame => frame.type === type),
    lastOfType: type => [...sent].reverse().find(frame => frame.type === type),
    send: (data: string) => {
      if (readyState !== OPEN) throw new Error('send on a closed socket')
      sent.push(JSON.parse(data) as SentFrame)
    },
    close: (code?: number, reason?: string) => {
      closeCalls.push({ code, reason })
      if (readyState === CLOSED) return
      readyState = CLOSED
      // `ws` emits `close` asynchronously; matching that ordering is what makes
      // the teardown paths testable rather than entangled with `close()`.
      queueMicrotask(() => {
        for (const listener of closeListeners) listener(code ?? 1005, reason ?? '')
      })
    },
    terminate: () => {
      terminated = true
      if (readyState === CLOSED) return
      readyState = CLOSED
      queueMicrotask(() => {
        for (const listener of closeListeners) listener(1006, 'terminated')
      })
    },
    receive: (frame: Record<string, unknown>) => {
      const text = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...frame })
      for (const listener of messageListeners) listener(text)
    },
    receiveRaw: (text: string) => {
      for (const listener of messageListeners) listener(text)
    },
    remoteClose: (code = 1006, reason = 'peer closed') => {
      readyState = CLOSED
      for (const listener of closeListeners) listener(code, reason)
    },
    on: (event: 'message' | 'close' | 'error', listener: (...args: never[]) => void): unknown => {
      if (event === 'message') messageListeners.push(listener as (data: RawFrameData) => void)
      else if (event === 'close') closeListeners.push(listener as (code: number, reason: unknown) => void)
      else errorListeners.push(listener as (error: Error) => void)
      return undefined
    },
  }
}

/** A capability summary with one unary and one stream Remote. */
export function sampleCapabilities(overrides: Partial<NodeCapabilitySummary> = {}): NodeCapabilitySummary {
  return {
    remotes: [
      { endpoint: 'pluginInventory/list', mode: 'unary' },
      { endpoint: 'session/watch', mode: 'stream' },
    ],
    remoteSurfaceHash: 'surface-1',
    namespaces: [],
    ...overrides,
  }
}

/** The `hello` frame a node sends, with sensible test defaults. */
export function helloFrame(options: {
  readonly nodeId: string
  readonly token: string
  readonly mode?: string
  readonly nodeName?: string
}): Record<string, unknown> {
  return {
    type: 'hello',
    nodeId: options.nodeId,
    ...(options.nodeName === undefined ? {} : { nodeName: options.nodeName }),
    mode: options.mode ?? 'full-access',
    auth: { type: 'bearer', token: options.token },
  }
}

/** The `ready` frame a node sends after `hello.ok`. */
export function readyFrame(options: {
  readonly nodeId: string
  readonly connectionId?: string
  readonly capabilities?: NodeCapabilitySummary
}): Record<string, unknown> {
  return {
    type: 'ready',
    nodeId: options.nodeId,
    ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    capabilities: options.capabilities ?? sampleCapabilities(),
  }
}

/** Wait until a predicate holds, polling on the macrotask queue. */
export async function waitFor(
  predicate: () => boolean,
  options: { readonly timeoutMs?: number; readonly label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 2_000)
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.label ?? 'condition'}`)
    await new Promise<void>(resolve => { setTimeout(resolve, 5) })
  }
}

/** Let every already-queued microtask and macrotask run. */
export async function settle(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
}

/** A real WebSocket client speaking the node's side of the protocol. */
export interface FakeNodeClient {
  readonly socket: WebSocket
  /** Performs `hello` then `ready`, waiting for `hello.ok` in between. */
  handshake(options?: { readonly connectionId?: string; readonly capabilities?: NodeCapabilitySummary }): Promise<{
    readonly connectionId: string
    readonly heartbeatIntervalMs?: number
    readonly maxFrameBytes?: number
    readonly acceptedMode?: string
  }>
  /** Send one frame with the protocol envelope filled in. */
  send(frame: Record<string, unknown>): void
  /** Every frame received, decoded in order. */
  readonly received: SentFrame[]
  /**
   * Await the next frame of a type **arriving after this call**.
   *
   * Cursor-based rather than consuming: a test can wait for the same type twice
   * (`ping`, then the next `ping`) without the first wait having eaten the frame it
   * matched.
   */
  next(type: string, timeoutMs?: number): Promise<SentFrame>
  /** Await the socket closing. */
  closed(timeoutMs?: number): Promise<{ readonly code: number; readonly reason: string }>
  /** Close the underlying socket. */
  destroy(): void
}

/**
 * Connect to a Coordinator as a node would.
 * @param url - the Coordinator's WebSocket URL.
 * @param options - identity and credential to present.
 * @returns the client.
 */
export async function connectFakeNode(
  url: string,
  options: { readonly nodeId: string; readonly token: string; readonly mode?: string; readonly nodeName?: string },
): Promise<FakeNodeClient> {
  const socket = new WebSocket(url)
  const received: SentFrame[] = []
  const waiters: { type: string; from: number; resolve: (frame: SentFrame) => void }[] = []
  const closeWaiters: ((value: { code: number; reason: string }) => void)[] = []

  socket.on('message', (data) => {
    const frame = JSON.parse(toFrameText(data as RawFrameData)) as SentFrame
    const index = received.length
    received.push(frame)
    for (const waiter of [...waiters]) {
      if (waiter.type !== frame.type || index < waiter.from) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(frame)
    }
  })
  socket.on('close', (code, reason) => {
    for (const resolve of closeWaiters.splice(0, closeWaiters.length)) {
      resolve({ code, reason: toFrameText(reason as RawFrameData) })
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => { resolve() })
    socket.once('error', reject)
  })

  const client: FakeNodeClient = {
    socket,
    received,
    send: (frame) => {
      socket.send(encodeFrame({ protocolVersion: PROTOCOL_VERSION, ...frame } as unknown as AnyFrame, 8 * 1024 * 1024))
    },
    next: (type, timeoutMs = 2_000) => new Promise<SentFrame>((resolve, reject) => {
      const waiter: { type: string; from: number; resolve: (frame: SentFrame) => void } = {
        type,
        from: received.length,
        resolve: (frame) => { clearTimeout(timer); resolve(frame) },
      }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`timed out waiting for a ${type} frame`))
      }, timeoutMs)
      waiters.push(waiter)
    }),
    closed: (timeoutMs = 2_000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('timed out waiting for the socket to close')) }, timeoutMs)
      closeWaiters.push((value) => { clearTimeout(timer); resolve(value) })
    }),
    destroy: () => { socket.terminate() },
    handshake: async (handshakeOptions = {}) => {
      client.send(helloFrame({ nodeId: options.nodeId, token: options.token, ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.nodeName === undefined ? {} : { nodeName: options.nodeName }) }))
      const ok = await client.next('hello.ok')
      client.send(readyFrame({
        nodeId: options.nodeId,
        connectionId: handshakeOptions.connectionId ?? (ok['connectionId'] as string),
        ...(handshakeOptions.capabilities === undefined ? {} : { capabilities: handshakeOptions.capabilities }),
      }))
      return {
        connectionId: ok['connectionId'] as string,
        ...(ok['heartbeatIntervalMs'] === undefined ? {} : { heartbeatIntervalMs: ok['heartbeatIntervalMs'] as number }),
        ...(ok['maxFrameBytes'] === undefined ? {} : { maxFrameBytes: ok['maxFrameBytes'] as number }),
        ...(ok['acceptedMode'] === undefined ? {} : { acceptedMode: ok['acceptedMode'] as string }),
      }
    },
  }
  return client
}
