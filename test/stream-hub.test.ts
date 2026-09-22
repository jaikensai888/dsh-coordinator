/**
 * Streams are the one part of the protocol with no flow control: the only lever
 * over a node producing faster than this service consumes is `stream.cancel`, and
 * the only thing keeping a value sequence honest is `seq`.
 *
 * The tests below are grouped by the caller-visible promise each one defends:
 * values arrive in order, a stream terminates exactly once, a consumer that
 * stops reading is noticed, and every failure the node reported survives to the
 * consumer with the node's own error code attached.
 *
 * @module dsh-coordinator/test/stream-hub
 */

import { describe, expect, it } from 'vitest'
import { CoordinatorError, isCoordinatorError, type RemoteFailure } from '../src/errors.js'
import { RemoteStream, StreamHub, type StreamTermination } from '../src/stream-hub.js'
import { createManualTimers, settle, type ManualTimers } from './helpers.js'

const ENDPOINT = 'session/watch'

interface Sent {
  readonly streamId: string
  readonly reason: string
}

interface Fixture {
  readonly hub: StreamHub
  readonly timers: ManualTimers
  /** Every `stream.cancel` the hub asked the transport to send. */
  readonly sent: Sent[]
}

/** A hub on a virtual clock whose frame sink records what it is asked to send. */
function createHub(options: { readonly maxStreams?: number; readonly defaultTimeoutMs?: number; readonly maxBufferedValues?: number } = {}): Fixture {
  const timers = createManualTimers()
  const sent: Sent[] = []
  const hub = new StreamHub({
    maxStreams: options.maxStreams ?? 8,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 1_000,
    maxBufferedValues: options.maxBufferedValues ?? 8,
    send: (streamId, reason) => {
      sent.push({ streamId, reason })
      return true
    },
    timers,
  })
  return { hub, timers, sent }
}

/** Open one stream on a hub, with the endpoint every test shares. */
function openStream(
  hub: StreamHub,
  streamId: string,
  options: { readonly timeoutMs?: number; readonly maxBufferedValues?: number } = {},
): RemoteStream {
  return hub.open({
    streamId,
    endpoint: ENDPOINT,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBufferedValues === undefined ? {} : { maxBufferedValues: options.maxBufferedValues }),
  })
}

/** A stream built directly, for the invariants that live on the handle itself. */
function createStream(timers: ManualTimers, options: { readonly streamId?: string } = {}): RemoteStream {
  return new RemoteStream(
    {
      streamId: options.streamId ?? 's1',
      endpoint: ENDPOINT,
      maxBufferedValues: 8,
      timeoutMs: 1_000,
      onIdle: () => {},
    },
    () => {},
    (callback, ms) => timers.setTimeout(callback, ms),
  )
}

/** Run `run`, expecting a refusal, and return the failure. */
function thrownBy(run: () => unknown): CoordinatorError {
  try {
    run()
  } catch (error) {
    if (isCoordinatorError(error)) return error
    throw error
  }
  throw new Error('expected the call to throw a CoordinatorError')
}

/** The failure behind a termination that was expected to fail. */
function failureOf(termination: StreamTermination): RemoteFailure {
  if (termination.ok) throw new Error('expected the stream to fail')
  return termination.error
}

/** Await a rejected promise, expecting a `CoordinatorError`. */
async function rejectionOf(promise: Promise<unknown>): Promise<CoordinatorError> {
  try {
    await promise
  } catch (error) {
    if (isCoordinatorError(error)) return error
    throw error
  }
  throw new Error('expected the promise to reject')
}

/** Drain a stream the way a consumer does. */
async function collect(stream: RemoteStream): Promise<unknown[]> {
  const seen: unknown[] = []
  for await (const value of stream) seen.push(value)
  return seen
}

describe('sequence numbers', () => {
  it('accepts seq starting at 1 and stepping by 1', async () => {
    const { hub } = createHub()
    const stream = openStream(hub, 's1')
    expect(hub.onData('s1', 1, 'first')).toBe(true)
    expect(hub.onData('s1', 2, 'second')).toBe(true)
    expect(stream.count).toBe(2)
    expect(stream.buffered).toBe(2)

    expect(hub.onTerminal('s1', { ok: true, count: 2 })).toBe(true)
    expect(await collect(stream)).toEqual(['first', 'second'])
  })

  it('fails and terminates the stream when a seq is skipped', async () => {
    const { hub, timers, sent } = createHub()
    const stream = openStream(hub, 's1')
    expect(hub.onData('s1', 1, 'first')).toBe(true)

    expect(hub.onData('s1', 3, 'third')).toBe(false)
    const termination = await stream.closed
    expect(termination).toMatchObject({ ok: false, reason: 'protocol' })
    expect(failureOf(termination).code).toBe('coordinator/protocol-invalid')
    expect(failureOf(termination).details).toEqual({
      streamId: 's1',
      endpoint: ENDPOINT,
      expected: 2,
      received: 3,
    })
    // A node whose frames this service cannot accept is still producing: the
    // local termination must also tell it to stop.
    expect(sent).toEqual([{ streamId: 's1', reason: expect.stringContaining('expected seq 2') }])

    expect(stream.terminated).toBe(true)
    expect(hub.get('s1')).toBeUndefined()
    expect(hub.size).toBe(0)
    expect(timers.pending()).toBe(0)
    // The stream is gone, so a later frame for it is dropped rather than appended.
    expect(hub.onData('s1', 4, 'fourth')).toBe(false)
  })

  it('fails and terminates the stream when a seq repeats', async () => {
    const { hub } = createHub()
    const stream = openStream(hub, 's1')
    expect(hub.onData('s1', 1, 'first')).toBe(true)

    expect(hub.onData('s1', 1, 'repeated')).toBe(false)
    const termination = await stream.closed
    expect(termination).toMatchObject({ ok: false, reason: 'protocol' })
    expect(failureOf(termination).code).toBe('coordinator/protocol-invalid')
    expect(failureOf(termination).details).toEqual({
      streamId: 's1',
      endpoint: ENDPOINT,
      expected: 2,
      received: 1,
    })
    expect(hub.size).toBe(0)
  })

  it('fails and terminates the stream when seq goes backwards or is not a whole number', async () => {
    const { hub } = createHub()
    const backwards = openStream(hub, 's1')
    for (const [seq, value] of [[1, 'a'], [2, 'b'], [3, 'c']] as const) hub.onData('s1', seq, value)
    expect(hub.onData('s1', 2, 'b-again')).toBe(false)
    expect(failureOf(await backwards.closed).details).toEqual({
      streamId: 's1',
      endpoint: ENDPOINT,
      expected: 4,
      received: 2,
    })

    const fractional = openStream(hub, 's2')
    expect(hub.onData('s2', 1, 'a')).toBe(true)
    expect(hub.onData('s2', 1.5, 'half')).toBe(false)
    expect(failureOf(await fractional.closed).details).toEqual({
      streamId: 's2',
      endpoint: ENDPOINT,
      expected: 2,
      received: 1.5,
    })
    expect(hub.size).toBe(0)
  })
})

describe('terminal frames', () => {
  it('resolves closed once and stops routing when the node ends the stream before failing it', async () => {
    const { hub } = createHub()
    const stream = openStream(hub, 's1')
    let resolutions = 0
    void stream.closed.then(() => { resolutions += 1 })
    hub.onData('s1', 1, 'first')

    expect(hub.onTerminal('s1', { ok: true, count: 1 })).toBe(true)
    expect(hub.onTerminal('s1', { ok: false, error: { code: 'node/backpressure', message: 'too late', details: {} }, count: 1 })).toBe(false)
    await settle()

    expect(resolutions).toBe(1)
    expect(await stream.closed).toEqual({ ok: true, count: 1, reason: 'end' })
    expect(stream.terminated).toBe(true)
    expect(hub.size).toBe(0)
  })

  it('lets the first terminal outcome decide, whichever of end and error arrives first', async () => {
    const timers = createManualTimers()
    const failure: RemoteFailure = { code: 'node/backpressure', message: 'too fast', details: {} }

    const failedFirst = createStream(timers, { streamId: 's1' })
    failedFirst.fail(failure, 'protocol')
    failedFirst.end(5)
    expect(await failedFirst.closed).toEqual({ ok: false, error: failure, count: 0, reason: 'protocol' })

    const endedFirst = createStream(timers, { streamId: 's2' })
    endedFirst.end(3)
    endedFirst.fail(failure, 'protocol')
    expect(await endedFirst.closed).toEqual({ ok: true, count: 3, reason: 'end' })

    expect(timers.pending()).toBe(0)
  })

  it('refuses a ready frame for a stream that already terminated', async () => {
    const timers = createManualTimers()
    const stream = createStream(timers)
    stream.end(0)
    expect(thrownBy(() => stream.markReady()).code).toBe('coordinator/stream-closed')
    expect(stream.ready).toBe(false)
    expect(stream.terminated).toBe(true)
  })

  it('reports an unknown stream id for every routed frame without cancelling anything', () => {
    const { hub, sent } = createHub()
    expect(hub.onReady('ghost')).toBe(false)
    expect(hub.onData('ghost', 1, 'value')).toBe(false)
    expect(hub.onTerminal('ghost', { ok: true, count: 0 })).toBe(false)
    expect(hub.onTerminal('ghost', { ok: false, error: { code: 'node/backpressure', message: 'late', details: {} }, count: 0 })).toBe(false)
    expect(hub.cancel('ghost', 'nobody is listening')).toBeUndefined()
    expect(hub.get('ghost')).toBeUndefined()
    expect(sent).toEqual([])
  })
})

describe('buffering', () => {
  it('fails a stream whose consumer falls further behind than the buffer allows', async () => {
    const { hub, timers } = createHub({ maxBufferedValues: 2 })
    const stream = openStream(hub, 's1', { maxBufferedValues: 2 })
    expect(hub.onData('s1', 1, 'first')).toBe(true)
    expect(hub.onData('s1', 2, 'second')).toBe(true)

    expect(hub.onData('s1', 3, 'third')).toBe(false)
    const termination = await stream.closed
    expect(termination).toMatchObject({ ok: false, reason: 'backpressure', count: 3 })
    expect(failureOf(termination).code).toBe('coordinator/backpressure')
    expect(failureOf(termination).details).toMatchObject({ streamId: 's1', endpoint: ENDPOINT, buffered: 3 })

    expect(stream.terminated).toBe(true)
    expect(hub.size).toBe(0)
    expect(timers.pending()).toBe(0)
  })

  it('cancels the node stream that overran the buffer', async () => {
    // SUSPECTED SOURCE BUG — `RemoteStream.push` fails a stream that overran its
    // buffer with `coordinator/backpressure` (src/stream-hub.ts:192-202) but a
    // RemoteStream has no access to the hub's frame sink: `stream.cancel` is sent
    // only by `StreamHub.cancel`, by the idle deadline, and by
    // `failAll(..., notifyNode: true)`. The overflow path terminates the stream
    // locally and its terminal callback removes it from the hub's map, so a later
    // `hub.cancel(id)` returns undefined and sends nothing either — there is no
    // path left that can ever release the stream on the node.
    // Expected: exactly one `stream.cancel` for that stream, since the module doc
    // (item 1) makes `stream.cancel` the only lever over a node that is producing
    // faster than this service consumes. Observed: no frame at all, so the node
    // keeps yielding into a stream the Coordinator has already dropped.
    const { hub, sent } = createHub({ maxBufferedValues: 1 })
    const stream = openStream(hub, 's1', { maxBufferedValues: 1 })
    hub.onData('s1', 1, 'first')
    expect(hub.onData('s1', 2, 'second')).toBe(false)
    expect(failureOf(await stream.closed).code).toBe('coordinator/backpressure')

    expect(sent).toHaveLength(1)
    expect(sent[0]?.streamId).toBe('s1')
  })
})

describe('the idle deadline', () => {
  it('fails a stream that goes idle and cancels it on the node', async () => {
    const { hub, timers, sent } = createHub({ defaultTimeoutMs: 1_000 })
    const stream = openStream(hub, 's1')

    await timers.advance(999)
    expect(stream.terminated).toBe(false)

    await timers.advance(1)
    const termination = await stream.closed
    expect(termination).toMatchObject({ ok: false, reason: 'timeout' })
    expect(failureOf(termination).code).toBe('coordinator/request-timeout')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.streamId).toBe('s1')
    expect(sent[0]?.reason).toContain('produced nothing for too long')
    expect(hub.size).toBe(0)
    expect(timers.pending()).toBe(0)
  })

  it('keeps an actively producing stream alive past the idle deadline', async () => {
    const { hub, timers, sent } = createHub({ defaultTimeoutMs: 100 })
    const stream = openStream(hub, 's1')

    await timers.advance(90)
    expect(hub.onData('s1', 1, 'first')).toBe(true)
    await timers.advance(90)
    // t = 180: a deadline armed once at t = 0 would have fired at t = 100.
    expect(stream.terminated).toBe(false)
    expect(sent).toEqual([])

    await timers.advance(20)
    expect(stream.terminated).toBe(true)
    expect(failureOf(await stream.closed).code).toBe('coordinator/request-timeout')
    expect(sent).toHaveLength(1)
  })
})

describe('cancellation', () => {
  it('terminates the stream and sends exactly one cancel frame with the reason', async () => {
    const { hub, timers, sent } = createHub()
    const stream = openStream(hub, 's1')
    hub.onData('s1', 1, 'first')

    const failure = hub.cancel('s1', 'the caller went away')
    expect(failure?.code).toBe('coordinator/stream-closed')
    // The frame names the stream and carries the caller's reason inside it: the
    // node's log is the only place an operator sees this.
    expect(sent).toEqual([{ streamId: 's1', reason: expect.stringContaining('the caller went away') }])

    const termination = await stream.closed
    expect(termination).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(failureOf(termination)).toBe(failure)
    expect(hub.size).toBe(0)
    expect(timers.pending()).toBe(0)

    // Cancelling again cannot send a second frame: the stream is already gone.
    expect(hub.cancel('s1', 'again')).toBeUndefined()
    expect(sent).toHaveLength(1)
  })

  it('cancels the stream on the node when the caller aborts', async () => {
    const { hub, sent } = createHub()
    const controller = new AbortController()
    const stream = hub.open({ streamId: 's1', endpoint: ENDPOINT, signal: controller.signal })

    controller.abort()
    const termination = await stream.closed
    expect(termination).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(failureOf(termination).code).toBe('coordinator/stream-closed')
    expect(sent).toEqual([{ streamId: 's1', reason: expect.stringContaining('the caller aborted') }])
    expect(hub.size).toBe(0)
  })

  it('fails a stream whose caller had already aborted without sending anything', async () => {
    const { hub, sent } = createHub()
    const controller = new AbortController()
    controller.abort()
    const stream = hub.open({ streamId: 's1', endpoint: ENDPOINT, signal: controller.signal })

    const termination = await stream.closed
    expect(termination).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(failureOf(termination).code).toBe('coordinator/request-aborted')
    expect(failureOf(termination).details).toEqual({ endpoint: ENDPOINT })
    expect(hub.size).toBe(0)
    // The hub never sent `stream.open`, so there is nothing to cancel.
    expect(sent).toEqual([])
  })
})

describe('failAll', () => {
  it('fails every stream and notifies the node for each when asked', async () => {
    const { hub, timers, sent } = createHub()
    const streams = [openStream(hub, 's1'), openStream(hub, 's2')]
    const failure: RemoteFailure = { code: 'coordinator/connection-lost', message: 'the link dropped', details: {} }

    expect(hub.failAll(failure, 'disconnected', true)).toBe(2)
    expect(sent.map(entry => entry.streamId).sort()).toEqual(['s1', 's2'])
    expect(sent.every(entry => entry.reason === 'the link dropped')).toBe(true)

    for (const stream of streams) {
      const termination = await stream.closed
      expect(termination).toMatchObject({ ok: false, reason: 'disconnected' })
      expect(failureOf(termination)).toBe(failure)
    }
    expect(hub.size).toBe(0)
    expect(timers.pending()).toBe(0)
  })

  it('fails every stream without sending anything when the link is already gone', async () => {
    const { hub, sent } = createHub()
    const streams = [openStream(hub, 's1'), openStream(hub, 's2')]
    const failure: RemoteFailure = { code: 'coordinator/shutdown', message: 'shutting down', details: {} }

    expect(hub.failAll(failure)).toBe(2)
    expect(sent).toEqual([])
    for (const stream of streams) {
      const termination = await stream.closed
      expect(termination).toMatchObject({ ok: false, reason: 'disconnected' })
      expect(failureOf(termination)).toBe(failure)
    }
    expect(hub.size).toBe(0)
    expect(hub.failAll(failure)).toBe(0)
  })
})

describe('admission control', () => {
  it('refuses a stream id that is already open', () => {
    const { hub } = createHub()
    openStream(hub, 's1')
    const error = thrownBy(() => openStream(hub, 's1'))
    expect(error.code).toBe('coordinator/invalid-arguments')
    expect(error.details).toEqual({ streamId: 's1' })
    expect(hub.size).toBe(1)
  })

  it('refuses an empty stream id', () => {
    const { hub } = createHub()
    const error = thrownBy(() => openStream(hub, ''))
    expect(error.code).toBe('coordinator/invalid-arguments')
    expect(hub.size).toBe(0)
  })

  it('refuses a stream beyond the limit and frees the slot when one terminates', async () => {
    const { hub } = createHub({ maxStreams: 1 })
    const first = openStream(hub, 's1')

    const error = thrownBy(() => openStream(hub, 's2'))
    expect(error.code).toBe('coordinator/stream-limit')
    expect(error.details).toEqual({ maxStreams: 1, endpoint: ENDPOINT })
    expect(hub.size).toBe(1)

    expect(hub.onTerminal('s1', { ok: true, count: 0 })).toBe(true)
    expect(hub.size).toBe(0)
    expect(() => openStream(hub, 's2')).not.toThrow()
    expect(hub.ids()).toEqual(['s2'])
    expect(await first.closed).toMatchObject({ ok: true, reason: 'end' })
  })

  it('never hands out the same stream id twice', () => {
    const { hub } = createHub()
    const ids = new Set<string>()
    for (let index = 0; index < 200; index += 1) ids.add(hub.nextStreamId())
    expect(ids.size).toBe(200)

    const prefixed = hub.nextStreamId('stream')
    expect(ids.has(prefixed)).toBe(false)
    expect(prefixed.startsWith('stream-')).toBe(true)

    const stream = openStream(hub, hub.nextStreamId('open'))
    expect(stream.streamId.startsWith('open-')).toBe(true)
  })
})

describe('the async iterator', () => {
  it('yields the values in order and returns when the node ends the stream', async () => {
    const { hub } = createHub()
    const stream = openStream(hub, 's1')
    hub.onData('s1', 1, 'first')
    hub.onData('s1', 2, 'second')
    hub.onData('s1', 3, 'third')
    expect(hub.onTerminal('s1', { ok: true, count: 3 })).toBe(true)

    expect(await collect(stream)).toEqual(['first', 'second', 'third'])
    expect(stream.count).toBe(3)
    expect(await stream.closed).toEqual({ ok: true, count: 3, reason: 'end' })
  })

  it('hands a value to a consumer that was already waiting for one', async () => {
    const { hub } = createHub()
    const stream = openStream(hub, 's1')
    const iterator = stream[Symbol.asyncIterator]()
    const waiting = iterator.next()
    expect(stream.buffered).toBe(0)

    expect(hub.onData('s1', 1, 'first')).toBe(true)
    expect(await waiting).toEqual({ value: 'first', done: false })

    expect(hub.onTerminal('s1', { ok: true, count: 1 })).toBe(true)
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  })

  it('throws the failure the node reported, with the node error code intact', async () => {
    const { hub } = createHub()
    const stream = openStream(hub, 's1')
    const failure: RemoteFailure = { code: 'session/not-found', message: 'no such session', details: { sessionId: 'x' } }
    hub.onData('s1', 1, 'first')
    hub.onTerminal('s1', { ok: false, error: failure, count: 1 })

    const iterator = stream[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ value: 'first', done: false })

    const error = await rejectionOf(iterator.next())
    expect(error.code).toBe('session/not-found')
    expect(error.message).toBe('no such session')
    expect(error.details).toEqual({ sessionId: 'x' })
  })

  it('yields a literal undefined instead of treating it as the end of the stream', async () => {
    const { hub } = createHub()
    const stream = openStream(hub, 's1')
    expect(hub.onData('s1', 1, undefined)).toBe(true)
    expect(hub.onData('s1', 2, 'after')).toBe(true)
    expect(stream.buffered).toBe(2)

    expect(hub.onTerminal('s1', { ok: true, count: 2 })).toBe(true)
    expect(await collect(stream)).toEqual([undefined, 'after'])
  })

  it('abandons the stream on the node when a consumer breaks out of for await', async () => {
    const { hub, timers, sent } = createHub()
    const stream = openStream(hub, 's1')
    hub.onData('s1', 1, 'first')
    hub.onData('s1', 2, 'second')

    const seen: unknown[] = []
    for await (const value of stream) {
      seen.push(value)
      break
    }
    await settle()

    expect(seen).toEqual(['first'])
    expect(stream.terminated).toBe(true)
    expect(hub.get('s1')).toBeUndefined()
    expect(hub.size).toBe(0)
    expect(timers.pending()).toBe(0)
    // Breaking out is this side deciding to stop, and the node has no other way to
    // learn that: without the cancel frame it would keep producing into a socket
    // nobody reads, and every later frame would be dropped as an unknown stream.
    expect(await stream.closed).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(sent).toEqual([{ streamId: 's1', reason: expect.stringContaining('stopped reading') }])
  })
})
