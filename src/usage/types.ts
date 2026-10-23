/**
 * The usage contract, as data: types, parsers, and the one normalizer both sides
 * must agree on.
 *
 * The contract file (`docs/specs/2026-10-23-node-usage-contracts.md`) is the
 * authority for every field name here. This module exists so that "the node sent
 * something" and "the Coordinator accepted it" are decided by one piece of code
 * per side, with the same rules, instead of by whatever the query path happened
 * to expect.
 *
 * Three rules drive the implementation:
 *
 * - **Missing is null, never zero.** A provider that did not report a cache
 *   bucket has told us nothing about it; storing `0` would turn "unknown" into a
 *   measured value and a total that looks complete.
 * - **Integers are exact.** Token counts cross the wire as decimal strings and
 *   live in SQLite as 64-bit integers; JavaScript numbers appear only where a
 *   value has been proven to fit (a length, a limit, a count of rows).
 * - **A total is a lower bound unless the provider gave one.** `totalTokens` is
 *   used when present and consistent; otherwise it is derived only when all four
 *   mutually exclusive buckets are known. `knownTokens` is always
 *   `totalTokens ?? sum(known buckets)`.
 *
 * @module dsh-coordinator/usage/types
 */

import { CoordinatorError } from '../errors.js'

/** A non-negative integer as a decimal string. */
export type Decimal = string

/** A UTC ISO-8601 timestamp with millisecond precision. */
export type IsoTime = string

/** The terminal (or not yet terminal) state of one runtime attempt. */
export type AttemptState = 'running' | 'completed' | 'failed' | 'cancelled' | 'process_interrupted'

/** Why the runtime made the call. */
export type Purpose = 'conversation' | 'compaction' | 'session-title' | 'other'

/** Which collection generation produced an event. */
export type EventKind = 'attempt' | 'gap'

/** One usage sample. Every bucket is independently nullable. */
export interface UsageSample {
  readonly uncachedInputTokens: Decimal | null
  readonly cacheReadTokens: Decimal | null
  readonly cacheWriteTokens: Decimal | null
  readonly outputTokens: Decimal | null
  readonly reasoningTokens: Decimal | null
  readonly totalTokens: Decimal | null
}

/** One runtime attempt, as the node last saw it. */
export interface AttemptSnapshot {
  readonly attemptId: string
  readonly startedAt: IsoTime
  readonly endedAt: IsoTime | null
  readonly provider: string | null
  readonly model: string | null
  readonly sessionId: string | null
  readonly purpose: Purpose
  readonly state: AttemptState
  readonly usageReported: boolean
  readonly usage: UsageSample
  readonly source: 'runtime'
}

/** One immutable event in a collector's sequence. */
export type UsageEvent =
  | {
    readonly seq: Decimal
    readonly recordedAt: IsoTime
    readonly kind: 'attempt'
    readonly attempt: AttemptSnapshot
  }
  | {
    readonly seq: Decimal
    readonly recordedAt: IsoTime
    readonly kind: 'gap'
    readonly fromAt: IsoTime
    readonly toAt: IsoTime
    readonly reason: 'storage-failure' | 'capacity-limit' | 'collector-reset'
  }

/** A sequence range the node can no longer replay. */
export interface ReplayGap {
  readonly fromSeq: Decimal
  readonly throughSeq: Decimal
  readonly reason: 'pruned' | 'restore'
}

/** What a node reports about its collector. */
export interface UsageStatus {
  readonly schemaVersion: 1
  readonly enabled: boolean
  readonly state: 'ready' | 'disabled' | 'unsupported' | 'degraded'
  readonly collectorId: string | null
  readonly startedAt: IsoTime | null
  readonly earliestAvailableSeq: Decimal
  readonly latestIssuedSeq: Decimal
  readonly ackedThroughSeq: Decimal
  readonly pendingCount: Decimal
  readonly pendingBytes: Decimal
  readonly coverage: 'complete' | 'incomplete' | 'unknown'
  readonly degradedSince: IsoTime | null
  readonly issueCode: string | null
}

/** One page of events read from a node. */
export interface UsageBatch {
  readonly schemaVersion: 1
  readonly collectorId: string
  readonly events: readonly UsageEvent[]
  readonly gaps: readonly ReplayGap[]
  readonly nextSeq: Decimal
  readonly hasMore: boolean
  readonly status: UsageStatus
}

/** Totals over one filtered window. Every count is a Decimal string. */
export interface UsageTotals {
  readonly requestCount: Decimal
  readonly runningCount: Decimal
  readonly completedCount: Decimal
  readonly failedCount: Decimal
  readonly cancelledCount: Decimal
  readonly interruptedCount: Decimal
  readonly usageReportedCount: Decimal
  readonly unknownUsageCount: Decimal
  readonly totalUnknownCount: Decimal
  readonly knownTokens: Decimal
  readonly uncachedInputTokens: Decimal
  readonly cacheReadTokens: Decimal
  readonly cacheWriteTokens: Decimal
  readonly outputTokens: Decimal
  readonly bucketUnknownCounts: {
    readonly input: Decimal
    readonly cacheRead: Decimal
    readonly cacheWrite: Decimal
    readonly output: Decimal
  }
}

/** The largest value a SQLite INTEGER can hold. */
export const MAX_SQLITE_INTEGER = 9223372036854775807n

/** The largest event payload the wire contract permits. */
export const MAX_EVENT_BYTES = 16 * 1024

/** The largest string any identifier field may carry. */
export const MAX_ID_LENGTH = 128

/** The largest provider/model/session string the contract permits. */
export const MAX_TEXT_LENGTH = 256

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u

/**
 * Parse a contract Decimal.
 *
 * Strict on purpose: `1e3`, `01`, `-1`, and `"1.0"` are all rejected rather than
 * coerced, because every one of them would otherwise become a different number
 * than the sender meant.
 * @param value - the value to parse.
 * @returns the integer, or undefined when it is not a contract Decimal.
 */
export function parseDecimal(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined
  }
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) return undefined
  try {
    return BigInt(value)
  } catch {
    return undefined
  }
}

/**
 * Render an integer as a contract Decimal.
 * @param value - the integer.
 * @returns the decimal string.
 */
export function decimal(value: bigint | number): Decimal {
  return typeof value === 'bigint' ? value.toString(10) : String(Math.trunc(value))
}

/** A ledger of anomalies found while normalizing, without failing the call. */
export interface NormalizeDiagnostics {
  readonly issues: string[]
}

/** The result of normalizing one usage sample. */
export interface NormalizedUsage {
  readonly usage: UsageSample
  /** True when at least one provider field was present and usable. */
  readonly reported: boolean
  readonly issues: readonly string[]
}

/**
 * Normalize one usage sample from either vocabulary.
 *
 * Accepts the contract's names (`uncachedInputTokens`) and the runtime's
 * (`inputTokens`), because the node forwards what the runtime's `usage` chunk
 * carries and the contract names the same bucket differently. `inputTokens` in
 * the DSH runtime is the **uncached** input: the DeepSeek adapter adds
 * `cacheReadTokens` and `cacheWriteTokens` on top of it to reach the total, so
 * mapping it to `uncachedInputTokens` is the definition the provider arithmetic
 * already uses.
 *
 * A bad value never becomes zero: it becomes null and contributes an issue.
 * @param value - the raw usage object.
 * @returns the normalized sample plus whether anything was reported at all.
 */
export function normalizeUsage(value: unknown): NormalizedUsage {
  const issues: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { usage: emptyUsage(), reported: false, issues: ['usage was not an object'] }
  }
  const raw = value as Record<string, unknown>
  let reported = false

  const bucket = (names: readonly string[], label: string): bigint | null => {
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(raw, name)) continue
      const candidate = raw[name]
      if (candidate === null || candidate === undefined) continue
      reported = true
      const parsed = parseDecimal(candidate)
      if (parsed === undefined || parsed > MAX_SQLITE_INTEGER) {
        issues.push(`${label} was not a non-negative safe integer`)
        return null
      }
      return parsed
    }
    return null
  }

  const uncached = bucket(['uncachedInputTokens', 'inputTokens'], 'uncachedInputTokens')
  const cacheRead = bucket(['cacheReadTokens'], 'cacheReadTokens')
  const cacheWrite = bucket(['cacheWriteTokens'], 'cacheWriteTokens')
  const output = bucket(['outputTokens'], 'outputTokens')
  const reasoning = bucket(['reasoningTokens'], 'reasoningTokens')
  const providerTotal = bucket(['totalTokens'], 'totalTokens')

  let reasoningValid = reasoning
  if (reasoning !== null && output !== null && reasoning > output) {
    issues.push('reasoningTokens exceeded outputTokens and was discarded')
    reasoningValid = null
  }

  const buckets = [uncached, cacheRead, cacheWrite, output]
  const bucketsKnown = buckets.every(entry => entry !== null)
  const bucketSum = buckets.reduce<bigint>((sum, entry) => sum + (entry ?? 0n), 0n)

  let total: bigint | null = providerTotal
  let inconsistentTotal = false
  if (total !== null && bucketsKnown && total < bucketSum) {
    // A provider total below the sum of the parts it is supposed to contain is
    // internally inconsistent. Keeping it would understate the call; deriving the
    // sum instead would silently overrule the provider with this service's own
    // arithmetic. Neither is a measurement, so the total becomes unknown while the
    // known buckets still count towards the lower bound.
    issues.push('totalTokens was smaller than the known buckets and was discarded')
    total = null
    inconsistentTotal = true
  }
  if (total === null && !inconsistentTotal && bucketsKnown) total = bucketSum

  const usage: UsageSample = {
    uncachedInputTokens: uncached === null ? null : decimal(uncached),
    cacheReadTokens: cacheRead === null ? null : decimal(cacheRead),
    cacheWriteTokens: cacheWrite === null ? null : decimal(cacheWrite),
    outputTokens: output === null ? null : decimal(output),
    reasoningTokens: reasoningValid === null ? null : decimal(reasoningValid),
    totalTokens: total === null ? null : decimal(total),
  }
  // `reported` means "a usage object carried at least one field", not "the total
  // is complete": the contract is explicit that those are different questions.
  return { usage, reported: reported || providerTotal !== null, issues }
}

/** The all-null sample. */
export function emptyUsage(): UsageSample {
  return {
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
  }
}

/**
 * The tokens a call is known to have used.
 *
 * `totalTokens` when the provider stated one, otherwise the sum of whichever
 * buckets are known. This is the "lower bound" the UI must label as such when
 * {@link isTotalKnown} is false.
 * @param usage - a normalized sample.
 * @returns the known token count.
 */
export function knownTokensOf(usage: UsageSample): bigint {
  const total = parseDecimal(usage.totalTokens)
  if (total !== undefined) return total
  return [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens]
    .reduce<bigint>((sum, entry) => sum + (parseDecimal(entry ?? undefined) ?? 0n), 0n)
}

/**
 * Whether `totalTokens` is an actual total.
 *
 * True when the provider stated one, or when every mutually exclusive bucket is
 * known. This is the flag that decides whether a summary may present its token
 * figure as complete.
 * @param usage - a normalized sample.
 * @returns whether the total is complete.
 */
export function isTotalKnown(usage: UsageSample): boolean {
  if (usage.totalTokens !== null) return true
  return usage.uncachedInputTokens !== null &&
    usage.cacheReadTokens !== null &&
    usage.cacheWriteTokens !== null &&
    usage.outputTokens !== null
}

/** The canonical JSON of a sample, for equality checks and dedupe. */
export function canonicalUsage(usage: UsageSample): string {
  return JSON.stringify([
    usage.uncachedInputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ])
}

const ATTEMPT_STATES: ReadonlySet<string> = new Set([
  'running',
  'completed',
  'failed',
  'cancelled',
  'process_interrupted',
])

const PURPOSES: ReadonlySet<string> = new Set(['conversation', 'compaction', 'session-title', 'other'])

const GAP_REASONS: ReadonlySet<string> = new Set(['storage-failure', 'capacity-limit', 'collector-reset'])

const REPLAY_REASONS: ReadonlySet<string> = new Set(['pruned', 'restore'])

const STATUS_STATES: ReadonlySet<string> = new Set(['ready', 'disabled', 'unsupported', 'degraded'])

const COVERAGES: ReadonlySet<string> = new Set(['complete', 'incomplete', 'unknown'])

/** A contract violation, with a code the caller can branch on. */
function invalid(message: string, details: Record<string, unknown> = {}): CoordinatorError {
  return new CoordinatorError('usage/contract-invalid', message, details)
}

/** Require a string of bounded length. */
function requireText(value: unknown, field: string, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') throw invalid(`"${field}" must be a string`, { field })
  if (value.length > max) throw invalid(`"${field}" is longer than ${max} characters`, { field, length: value.length })
  return value
}

/** Require a nullable bounded string. */
function nullableText(value: unknown, field: string, max = MAX_TEXT_LENGTH): string | null {
  if (value === null || value === undefined) return null
  return requireText(value, field, max)
}

/** Require an ISO-8601 timestamp with an offset, normalized to Z. */
function requireIso(value: unknown, field: string): IsoTime {
  if (typeof value !== 'string') throw invalid(`"${field}" must be an ISO-8601 string`, { field })
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw invalid(`"${field}" is not a parseable ISO-8601 time`, { field })
  return new Date(parsed).toISOString()
}

/** Require a nullable ISO-8601 timestamp. */
function nullableIso(value: unknown, field: string): IsoTime | null {
  if (value === null || value === undefined) return null
  return requireIso(value, field)
}

/** Require a Decimal from a value that has already been shape-checked. */
function requireDecimal(value: unknown, field: string): Decimal {
  const parsed = parseDecimal(value)
  if (parsed === undefined) throw invalid(`"${field}" must be a non-negative decimal integer`, { field })
  if (parsed > MAX_SQLITE_INTEGER) {
    throw invalid(`"${field}" exceeds the SQLite INTEGER range`, { field })
  }
  return decimal(parsed)
}

/** Parse one usage sample strictly. Unlike {@link normalizeUsage}, bad input throws. */
export function parseUsage(value: unknown, field = 'usage'): UsageSample {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`"${field}" must be an object`, { field })
  }
  const raw = value as Record<string, unknown>
  const optional = (name: string): Decimal | null => {
    const entry = raw[name]
    if (entry === null || entry === undefined) return null
    return requireDecimal(entry, `${field}.${name}`)
  }
  return {
    uncachedInputTokens: optional('uncachedInputTokens'),
    cacheReadTokens: optional('cacheReadTokens'),
    cacheWriteTokens: optional('cacheWriteTokens'),
    outputTokens: optional('outputTokens'),
    reasoningTokens: optional('reasoningTokens'),
    totalTokens: optional('totalTokens'),
  }
}

/** Parse one attempt snapshot strictly. */
export function parseAttempt(value: unknown): AttemptSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('"attempt" must be an object')
  }
  const raw = value as Record<string, unknown>
  const attemptId = requireText(raw['attemptId'], 'attempt.attemptId', MAX_ID_LENGTH)
  if (attemptId === '') throw invalid('"attempt.attemptId" must not be empty')
  const state = requireText(raw['state'], 'attempt.state')
  if (!ATTEMPT_STATES.has(state)) throw invalid(`unknown attempt state "${state}"`, { state })
  const purpose = requireText(raw['purpose'], 'attempt.purpose')
  if (!PURPOSES.has(purpose)) throw invalid(`unknown purpose "${purpose}"`, { purpose })
  if (raw['source'] !== 'runtime') throw invalid('"attempt.source" must be "runtime" for v1', { source: raw['source'] })
  if (typeof raw['usageReported'] !== 'boolean') throw invalid('"attempt.usageReported" must be a boolean')
  const source = 'runtime' as const
  return {
    attemptId,
    startedAt: requireIso(raw['startedAt'], 'attempt.startedAt'),
    endedAt: nullableIso(raw['endedAt'], 'attempt.endedAt'),
    provider: nullableText(raw['provider'], 'attempt.provider'),
    model: nullableText(raw['model'], 'attempt.model'),
    sessionId: nullableText(raw['sessionId'], 'attempt.sessionId'),
    purpose: purpose as Purpose,
    state: state as AttemptState,
    usageReported: raw['usageReported'],
    usage: parseUsage(raw['usage'], 'attempt.usage'),
    source,
  }
}

/** Parse one event strictly. */
export function parseUsageEvent(value: unknown): UsageEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('an event must be an object')
  }
  const raw = value as Record<string, unknown>
  const seq = requireDecimal(raw['seq'], 'event.seq')
  if (parseDecimal(seq) === 0n) throw invalid('"event.seq" starts at 1', { seq })
  const recordedAt = requireIso(raw['recordedAt'], 'event.recordedAt')
  const kind = raw['kind']
  if (kind === 'attempt') {
    return { seq, recordedAt, kind: 'attempt', attempt: parseAttempt(raw['attempt']) }
  }
  if (kind === 'gap') {
    const reason = requireText(raw['reason'], 'event.reason')
    if (!GAP_REASONS.has(reason)) throw invalid(`unknown gap reason "${reason}"`, { reason })
    return {
      seq,
      recordedAt,
      kind: 'gap',
      fromAt: requireIso(raw['fromAt'], 'event.fromAt'),
      toAt: requireIso(raw['toAt'], 'event.toAt'),
      reason: reason as 'storage-failure' | 'capacity-limit' | 'collector-reset',
    }
  }
  throw invalid('"event.kind" must be "attempt" or "gap"', { kind })
}

/** Parse one replay gap. */
export function parseReplayGap(value: unknown): ReplayGap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('a gap must be an object')
  }
  const raw = value as Record<string, unknown>
  const fromSeq = requireDecimal(raw['fromSeq'], 'gap.fromSeq')
  const throughSeq = requireDecimal(raw['throughSeq'], 'gap.throughSeq')
  if (parseDecimal(fromSeq)! > parseDecimal(throughSeq)!) {
    throw invalid('"gap.fromSeq" must not exceed "gap.throughSeq"')
  }
  const reason = requireText(raw['reason'], 'gap.reason')
  if (!REPLAY_REASONS.has(reason)) throw invalid(`unknown replay gap reason "${reason}"`, { reason })
  return { fromSeq, throughSeq, reason: reason as 'pruned' | 'restore' }
}

/** Parse one collector status. */
export function parseUsageStatus(value: unknown): UsageStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('"status" must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw['schemaVersion'] !== 1) throw invalid('"status.schemaVersion" must be 1')
  if (typeof raw['enabled'] !== 'boolean') throw invalid('"status.enabled" must be a boolean')
  const state = requireText(raw['state'], 'status.state')
  if (!STATUS_STATES.has(state)) throw invalid(`unknown collector state "${state}"`, { state })
  const coverage = requireText(raw['coverage'], 'status.coverage')
  if (!COVERAGES.has(coverage)) throw invalid(`unknown coverage "${coverage}"`, { coverage })
  return {
    schemaVersion: 1,
    enabled: raw['enabled'],
    state: state as UsageStatus['state'],
    collectorId: nullableText(raw['collectorId'], 'status.collectorId', MAX_ID_LENGTH),
    startedAt: nullableIso(raw['startedAt'], 'status.startedAt'),
    earliestAvailableSeq: requireDecimal(raw['earliestAvailableSeq'], 'status.earliestAvailableSeq'),
    latestIssuedSeq: requireDecimal(raw['latestIssuedSeq'], 'status.latestIssuedSeq'),
    ackedThroughSeq: requireDecimal(raw['ackedThroughSeq'], 'status.ackedThroughSeq'),
    pendingCount: requireDecimal(raw['pendingCount'], 'status.pendingCount'),
    pendingBytes: requireDecimal(raw['pendingBytes'], 'status.pendingBytes'),
    coverage: coverage as UsageStatus['coverage'],
    degradedSince: nullableIso(raw['degradedSince'], 'status.degradedSince'),
    issueCode: nullableText(raw['issueCode'], 'status.issueCode'),
  }
}

/**
 * Parse a whole batch.
 *
 * Shape, not policy: sequence continuity, cursor agreement and fork detection are
 * the repository's job. This function's job is that nothing downstream ever sees
 * a value that contradicts the contract.
 * @param value - the payload from `nodeUsage/read`.
 * @returns the validated batch.
 * @throws CoordinatorError `usage/contract-invalid` on any violation.
 */
export function parseUsageBatch(value: unknown): UsageBatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('the batch must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw['schemaVersion'] !== 1) throw invalid('"schemaVersion" must be 1')
  const collectorId = requireText(raw['collectorId'], 'collectorId', MAX_ID_LENGTH)
  if (collectorId === '') throw invalid('"collectorId" must not be empty')
  const eventsRaw = raw['events']
  if (!Array.isArray(eventsRaw)) throw invalid('"events" must be an array')
  const events = eventsRaw.map(entry => parseUsageEvent(entry))
  const gapsRaw = raw['gaps'] === undefined ? [] : raw['gaps']
  if (!Array.isArray(gapsRaw)) throw invalid('"gaps" must be an array')
  const gaps = gapsRaw.map(entry => parseReplayGap(entry))
  const nextSeq = requireDecimal(raw['nextSeq'], 'nextSeq')
  if (typeof raw['hasMore'] !== 'boolean') throw invalid('"hasMore" must be a boolean')
  return {
    schemaVersion: 1,
    collectorId,
    events,
    gaps,
    nextSeq,
    hasMore: raw['hasMore'],
    status: parseUsageStatus(raw['status']),
  }
}

/** The largest event any reader may receive, serialized. */
export function eventBytes(event: UsageEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8')
}
