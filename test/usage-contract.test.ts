/**
 * The usage contract: normalization, strict parsing, and the "unknown is not zero"
 * rules that every total downstream depends on.
 *
 * These are fixtures, not recorded traffic. The cross-repository test
 * (`cross-implementation.test.ts`) feeds a node-shaped batch through the Coordinator
 * parser, which is what keeps the two hand-written copies of the contract honest.
 *
 * @module dsh-coordinator/test/usage-contract
 */

import { describe, expect, it } from 'vitest'
import {
  decimal,
  isTotalKnown,
  knownTokensOf,
  normalizeUsage,
  parseDecimal,
  parseUsageBatch,
  parseUsageEvent,
} from '../src/usage/types.js'

/** A minimal valid status, with overrides. */
function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    enabled: true,
    state: 'ready',
    collectorId: 'collector-1',
    startedAt: '2026-10-23T00:00:00.000Z',
    earliestAvailableSeq: '1',
    latestIssuedSeq: '3',
    ackedThroughSeq: '2',
    pendingCount: '1',
    pendingBytes: '512',
    coverage: 'complete',
    degradedSince: null,
    issueCode: null,
    ...overrides,
  }
}

/** A minimal valid attempt, with overrides. */
function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: 'attempt-1',
    startedAt: '2026-10-23T01:00:00.000Z',
    endedAt: '2026-10-23T01:00:02.000Z',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    sessionId: 'session-1',
    purpose: 'conversation',
    state: 'completed',
    usageReported: true,
    usage: {
      uncachedInputTokens: '5',
      cacheReadTokens: '3',
      cacheWriteTokens: '0',
      outputTokens: '2',
      reasoningTokens: '1',
      totalTokens: '10',
    },
    source: 'runtime',
    ...overrides,
  }
}

/** A minimal valid batch, with overrides. */
function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    collectorId: 'collector-1',
    events: [{ seq: '1', recordedAt: '2026-10-23T01:00:02.000Z', kind: 'attempt', attempt: attempt() }],
    gaps: [],
    nextSeq: '1',
    hasMore: false,
    status: status(),
    ...overrides,
  }
}

describe('normalizeUsage', () => {
  it('maps the runtime vocabulary and derives a total from all four buckets', () => {
    const normalized = normalizeUsage({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    })
    expect(normalized.reported).toBe(true)
    expect(normalized.usage.uncachedInputTokens).toBe('5')
    expect(normalized.usage.outputTokens).toBe('2')
    expect(normalized.usage.totalTokens).toBe('10')
    expect(isTotalKnown(normalized.usage)).toBe(true)
  })

  it('does not invent a total when a cache bucket is missing', () => {
    const normalized = normalizeUsage({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 3 })
    expect(normalized.usage.cacheWriteTokens).toBeNull()
    expect(normalized.usage.totalTokens).toBeNull()
    expect(isTotalKnown(normalized.usage)).toBe(false)
    // The known buckets still count towards the lower bound.
    expect(knownTokensOf(normalized.usage)).toBe(10n)
  })

  it('turns nonsense into null, never into zero', () => {
    const normalized = normalizeUsage({
      inputTokens: -1,
      outputTokens: Number.NaN,
      cacheReadTokens: 1.5,
      cacheWriteTokens: '7.5',
      totalTokens: null,
    })
    expect(normalized.usage.uncachedInputTokens).toBeNull()
    expect(normalized.usage.outputTokens).toBeNull()
    expect(normalized.usage.cacheReadTokens).toBeNull()
    expect(normalized.usage.cacheWriteTokens).toBeNull()
    expect(normalized.usage.totalTokens).toBeNull()
    expect(normalized.issues.length).toBeGreaterThan(0)
  })

  it('accepts a decimal string for a bucket, because that is the contract type', () => {
    const normalized = normalizeUsage({ inputTokens: '5', outputTokens: '2', cacheReadTokens: '3', cacheWriteTokens: '0' })
    expect(normalized.usage.cacheWriteTokens).toBe('0')
    expect(normalized.usage.totalTokens).toBe('10')
  })

  it('discards a provider total below the sum of the buckets', () => {
    const normalized = normalizeUsage({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      totalTokens: 4,
    })
    // Not replaced by the derived sum either: a contradictory provider total means
    // "unknown", and the buckets remain available as a lower bound.
    expect(normalized.usage.totalTokens).toBeNull()
    expect(knownTokensOf(normalized.usage)).toBe(10n)
    expect(normalized.issues.join(' ')).toMatch(/smaller than the known buckets/u)
  })

  it('rejects reasoning tokens larger than the output', () => {
    const normalized = normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 9 })
    expect(normalized.usage.reasoningTokens).toBeNull()
    // ... and the reasoning count is never added to the total.
    expect(normalized.usage.totalTokens).toBe('3')
  })

  it('reports nothing for an absent usage object', () => {
    const normalized = normalizeUsage(undefined)
    expect(normalized.reported).toBe(false)
    expect(normalized.usage.totalTokens).toBeNull()
  })
})

describe('parseDecimal', () => {
  it('accepts only canonical non-negative integers', () => {
    expect(parseDecimal('0')).toBe(0n)
    expect(parseDecimal('9223372036854775807')).toBe(9223372036854775807n)
    for (const bad of ['01', '-1', '1.0', '1e3', '', ' 1', 'abc']) {
      expect(parseDecimal(bad), bad).toBeUndefined()
    }
  })

  it('renders bigint without going through a JS number', () => {
    expect(decimal(9223372036854775807n)).toBe('9223372036854775807')
  })
})

describe('parseUsageBatch', () => {
  it('accepts a well-formed batch', () => {
    const parsed = parseUsageBatch(batch())
    expect(parsed.collectorId).toBe('collector-1')
    expect(parsed.events).toHaveLength(1)
    expect(parsed.events[0]?.kind).toBe('attempt')
  })

  it('refuses an unknown attempt state', () => {
    expect(() => parseUsageBatch(batch({
      events: [{ seq: '1', recordedAt: '2026-10-23T01:00:02.000Z', kind: 'attempt', attempt: attempt({ state: 'gone' }) }],
    }))).toThrow(/state/u)
  })

  it('refuses a non-canonical decimal', () => {
    expect(() => parseUsageBatch(batch({ nextSeq: '01' }))).toThrow(/decimal/u)
  })

  it('refuses a value beyond the SQLite range', () => {
    expect(() => parseUsageBatch(batch({
      events: [{
        seq: '1',
        recordedAt: '2026-10-23T01:00:02.000Z',
        kind: 'attempt',
        attempt: attempt({ usage: { uncachedInputTokens: '9223372036854775808', cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null } }),
      }],
    }))).toThrow(/SQLite/u)
  })

  it('refuses an over-long provider string', () => {
    expect(() => parseUsageBatch(batch({
      events: [{
        seq: '1',
        recordedAt: '2026-10-23T01:00:02.000Z',
        kind: 'attempt',
        attempt: attempt({ provider: 'x'.repeat(300) }),
      }],
    }))).toThrow(/longer than/u)
  })

  it('refuses an inverted replay gap', () => {
    expect(() => parseUsageBatch(batch({
      gaps: [{ fromSeq: '5', throughSeq: '3', reason: 'pruned' }],
    }))).toThrow(/must not exceed/u)
  })

  it('keeps a gap event and its reason', () => {
    const parsed = parseUsageEvent({
      seq: '2',
      recordedAt: '2026-10-23T02:00:00.000Z',
      kind: 'gap',
      fromAt: '2026-10-23T01:30:00.000Z',
      toAt: '2026-10-23T02:00:00.000Z',
      reason: 'storage-failure',
    })
    expect(parsed).toMatchObject({ kind: 'gap', reason: 'storage-failure' })
  })
})
