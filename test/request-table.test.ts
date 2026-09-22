/**
 * The request table exists for one property: a unary call settles **exactly
 * once**, whichever of the four paths reaches it first — the node's answer, the
 * deadline, the caller's abort, or a disconnect.
 *
 * Every test here therefore watches two things at once: the outcome the caller
 * receives, and whether the transport was asked to cancel work on the node
 * (`onAbandon`) — the one is allowed to happen without the other, and getting
 * that pairing wrong is how a node ends up computing a result nobody will read.
 *
 * @module dsh-coordinator/test/request-table
 */

import { describe, expect, it } from 'vitest'
import { CoordinatorError, isCoordinatorError, type RemoteFailure } from '../src/errors.js'
import { RequestTable, type AbandonReason, type RequestOutcome } from '../src/request-table.js'
import { createManualTimers, settle, type ManualTimers } from './helpers.js'

const ENDPOINT = 'pluginInventory/list'

/** One recorded `onAbandon` call. */
interface Abandoned {
  readonly requestId: string
  readonly reason: AbandonReason
  readonly failure: RemoteFailure
}

interface Fixture {
  readonly table: RequestTable
  readonly timers: ManualTimers
  readonly abandoned: Abandoned[]
}

/** A table on a virtual clock, recording every abandonment it reports. */
function createTable(options: { readonly maxInFlight?: number; readonly defaultTimeoutMs?: number } = {}): Fixture {
  const timers = createManualTimers()
  const abandoned: Abandoned[] = []
  const table = new RequestTable({
    maxInFlight: options.maxInFlight ?? 8,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 60_000,
    timers,
    onAbandon: (requestId, reason, failure) => { abandoned.push({ requestId, reason, failure }) },
  })
  return { table, timers, abandoned }
}

/** Run `run`, expecting the table to refuse, and return the failure. */
function thrownBy(run: () => unknown): CoordinatorError {
  try {
    run()
  } catch (error) {
    if (isCoordinatorError(error)) return error
    throw error
  }
  throw new Error('expected the call to throw a CoordinatorError')
}

/** The failure of an outcome that was expected to fail. */
function failureOfOutcome(outcome: RequestOutcome): RemoteFailure {
  if (outcome.ok) throw new Error('expected the call to settle as a failure')
  return outcome.error
}

describe('single settlement', () => {
  it('settles a call once and ignores every later outcome for the same id', async () => {
    const { table, timers } = createTable()
    const call = table.begin('r1', { endpoint: ENDPOINT, timeoutMs: 1_000 })
    expect(table.size).toBe(1)

    expect(table.settle('r1', { ok: true, value: 'first' })).toBe(true)
    expect(table.settle('r1', { ok: false, error: { code: 'node/late', message: 'too late', details: {} } })).toBe(false)
    expect(table.settle('r1', { ok: true, value: 'second' })).toBe(false)

    expect(await call).toEqual({ ok: true, value: 'first' })
    expect(table.size).toBe(0)
    expect(table.has('r1')).toBe(false)
    expect(timers.pending()).toBe(0)
    expect(table.failAll({ code: 'coordinator/connection-lost', message: 'gone', details: {} })).toBe(0)
  })

  it('ignores a result for a request id that is not waiting', () => {
    const { table } = createTable()
    expect(table.settle('ghost', { ok: true, value: 1 })).toBe(false)
    expect(table.settle('', { ok: true, value: 1 })).toBe(false)
  })
})

describe('deadlines', () => {
  it('fails a call that outlives its deadline and asks the transport to cancel it', async () => {
    const { table, timers, abandoned } = createTable({ defaultTimeoutMs: 5_000 })
    const call = table.begin('r1', { endpoint: ENDPOINT, timeoutMs: 250 })
    expect(timers.pending()).toBe(1)

    await timers.advance(249)
    expect(table.has('r1')).toBe(true)

    await timers.advance(1)
    const error = failureOfOutcome(await call)
    expect(error.code).toBe('coordinator/request-timeout')
    expect(error.details).toEqual({ endpoint: ENDPOINT, timeoutMs: 250 })
    expect(abandoned).toEqual([{ requestId: 'r1', reason: 'timeout', failure: error }])
    expect(table.size).toBe(0)
    expect(timers.pending()).toBe(0)
    // The deadline was the first settlement; a late answer cannot revise it.
    expect(table.settle('r1', { ok: true, value: 'late' })).toBe(false)
  })

  it('clamps a deadline of zero to the shortest enforceable one', async () => {
    const { table, timers } = createTable({ defaultTimeoutMs: 5_000 })
    const call = table.begin('r1', { endpoint: ENDPOINT, timeoutMs: 0 })
    await timers.advance(1)
    const error = failureOfOutcome(await call)
    expect(error.code).toBe('coordinator/request-timeout')
    expect(error.details).toEqual({ endpoint: ENDPOINT, timeoutMs: 1 })
  })

  it('falls back to the table default when the caller states no usable deadline', async () => {
    const { table, timers } = createTable({ defaultTimeoutMs: 5_000 })
    const call = table.begin('r1', { endpoint: ENDPOINT, timeoutMs: Number.NaN })
    await timers.advance(4_999)
    expect(table.has('r1')).toBe(true)
    await timers.advance(1)
    expect(failureOfOutcome(await call).details).toEqual({ endpoint: ENDPOINT, timeoutMs: 5_000 })
  })
})

describe('caller aborts', () => {
  it('fails a call whose signal was already aborted, without arming a deadline', async () => {
    const { table, timers } = createTable()
    const controller = new AbortController()
    controller.abort()

    const call = table.begin('r1', { endpoint: ENDPOINT, timeoutMs: 1_000, signal: controller.signal })
    expect(timers.pending()).toBe(0)
    expect(table.size).toBe(0)

    const error = failureOfOutcome(await call)
    expect(error.code).toBe('coordinator/request-aborted')
    expect(error.details).toEqual({ endpoint: ENDPOINT })
    await timers.advance(60_000)
    expect(timers.pending()).toBe(0)
  })

  it('fails a waiting call when the caller aborts and reports the abandonment', async () => {
    const { table, timers, abandoned } = createTable()
    const controller = new AbortController()
    const call = table.begin('r1', { endpoint: ENDPOINT, timeoutMs: 1_000, signal: controller.signal })
    expect(timers.pending()).toBe(1)

    controller.abort()
    const error = failureOfOutcome(await call)
    expect(error.code).toBe('coordinator/request-aborted')
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.reason).toBe('aborted')
    expect(abandoned[0]?.failure).toBe(error)

    // The deadline was released with the settlement, so it cannot fire later and
    // settle the same call a second time.
    expect(timers.pending()).toBe(0)
    await timers.advance(5_000)
    expect(abandoned).toHaveLength(1)
    expect(table.size).toBe(0)
  })

  it('releases the abort listener and the deadline once the result arrives', async () => {
    const { table, timers, abandoned } = createTable()
    const controller = new AbortController()
    const call = table.begin('r1', { endpoint: ENDPOINT, timeoutMs: 1_000, signal: controller.signal })

    expect(table.settle('r1', { ok: true, value: 1 })).toBe(true)
    expect(timers.pending()).toBe(0)

    controller.abort()
    await settle()
    expect(abandoned).toEqual([])
    expect(await call).toEqual({ ok: true, value: 1 })
  })
})

describe('failAll', () => {
  it('settles every waiting call with the given failure and reports how many it failed', async () => {
    const { table, timers, abandoned } = createTable()
    const calls = [
      table.begin('r1', { endpoint: 'a/one', timeoutMs: 1_000 }),
      table.begin('r2', { endpoint: 'b/two', timeoutMs: 1_000 }),
      table.begin('r3', { endpoint: 'c/three', timeoutMs: 1_000 }),
    ]
    const failure: RemoteFailure = { code: 'coordinator/connection-lost', message: 'the link dropped', details: {} }

    expect(table.failAll(failure)).toBe(3)
    expect(await Promise.all(calls)).toEqual([
      { ok: false, error: failure },
      { ok: false, error: failure },
      { ok: false, error: failure },
    ])
    expect(table.size).toBe(0)
    expect(timers.pending()).toBe(0)
    // There is no link left to cancel over, so the transport is not asked to.
    expect(abandoned).toEqual([])
  })

  it('reports an explicit abandonment reason for every call it fails', async () => {
    const { table, abandoned } = createTable()
    const calls = [
      table.begin('r1', { endpoint: 'a/one', timeoutMs: 1_000 }),
      table.begin('r2', { endpoint: 'b/two', timeoutMs: 1_000 }),
    ]
    const failure: RemoteFailure = { code: 'coordinator/request-timeout', message: 'the node went quiet', details: {} }

    expect(table.failAll(failure, 'timeout')).toBe(2)
    expect(abandoned.map(entry => ({ requestId: entry.requestId, reason: entry.reason }))).toEqual([
      { requestId: 'r1', reason: 'timeout' },
      { requestId: 'r2', reason: 'timeout' },
    ])
    expect(abandoned.every(entry => entry.failure === failure)).toBe(true)
    expect(await Promise.all(calls)).toEqual([{ ok: false, error: failure }, { ok: false, error: failure }])
  })
})

describe('admission control', () => {
  it('refuses a request id that is already in flight', async () => {
    const { table } = createTable()
    const first = table.begin('r1', { endpoint: ENDPOINT, timeoutMs: 1_000 })

    const error = thrownBy(() => table.begin('r1', { endpoint: 'other/method', timeoutMs: 1_000 }))
    expect(error.code).toBe('coordinator/invalid-arguments')
    expect(error.details).toEqual({ requestId: 'r1' })
    expect(table.size).toBe(1)
    expect(table.ids()).toEqual(['r1'])

    expect(table.settle('r1', { ok: true, value: 1 })).toBe(true)
    expect(await first).toEqual({ ok: true, value: 1 })
  })

  it('refuses an empty request id', () => {
    const { table } = createTable()
    const error = thrownBy(() => table.begin('', { endpoint: ENDPOINT }))
    expect(error.code).toBe('coordinator/invalid-arguments')
    expect(table.size).toBe(0)
  })

  it('refuses a call beyond the in-flight limit and admits one again after a settlement', () => {
    const { table } = createTable({ maxInFlight: 2 })
    table.begin('r1', { endpoint: 'a/one', timeoutMs: 1_000 })
    table.begin('r2', { endpoint: 'b/two', timeoutMs: 1_000 })

    const error = thrownBy(() => table.begin('r3', { endpoint: ENDPOINT, timeoutMs: 1_000 }))
    expect(error.code).toBe('coordinator/request-limit')
    expect(error.details).toEqual({ maxInFlight: 2, endpoint: ENDPOINT })
    expect(table.size).toBe(2)

    expect(table.settle('r1', { ok: true, value: 1 })).toBe(true)
    expect(() => table.begin('r3', { endpoint: ENDPOINT, timeoutMs: 1_000 })).not.toThrow()
    expect(table.ids()).toEqual(['r2', 'r3'])
  })
})

describe('introspection', () => {
  it('counts, looks up and snapshots only the calls that are still waiting', async () => {
    const { table } = createTable()
    const call = table.begin('r1', { endpoint: ENDPOINT, timeoutMs: 1_000 })

    expect(table.size).toBe(1)
    expect(table.has('r1')).toBe(true)
    expect(table.has('ghost')).toBe(false)
    expect(table.snapshot()).toEqual([{ requestId: 'r1', endpoint: ENDPOINT, startedAt: 0 }])

    expect(table.settle('r1', { ok: true, value: 1 })).toBe(true)
    expect(table.size).toBe(0)
    expect(table.has('r1')).toBe(false)
    expect(table.ids()).toEqual([])
    expect(table.snapshot()).toEqual([])
    expect(await call).toEqual({ ok: true, value: 1 })
  })

  it('stamps each waiting call with the time it began', async () => {
    const { table, timers } = createTable({ defaultTimeoutMs: 60_000 })
    const first = table.begin('r1', { endpoint: 'a/one' })
    await timers.advance(1_000)
    const second = table.begin('r2', { endpoint: 'b/two' })

    expect(table.snapshot()).toEqual([
      { requestId: 'r1', endpoint: 'a/one', startedAt: 0 },
      { requestId: 'r2', endpoint: 'b/two', startedAt: 1_000 },
    ])

    expect(table.settle('r1', { ok: true, value: 1 })).toBe(true)
    expect(table.settle('r2', { ok: true, value: 2 })).toBe(true)
    expect(await Promise.all([first, second])).toEqual([{ ok: true, value: 1 }, { ok: true, value: 2 }])
  })
})
