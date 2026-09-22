/**
 * Stable Coordinator-side failure vocabulary and the redaction helpers.
 *
 * Two families, kept separate on purpose:
 *
 * - `coordinator/*` — this service's own boundary failures (no such node, not
 *   ready, timeout, disconnect). These are the Coordinator's equivalents of the
 *   node's `node/*` codes.
 * - everything else — a failure the **node** reported, which travels through
 *   verbatim. `dsh-node` preserves business codes and `gateway/*` codes, and this
 *   service must not flatten them either; a caller deciding whether to retry needs
 *   to tell `session/not-found` from `node/backpressure`.
 *
 * @module dsh-coordinator/errors
 */

/** Every stable `coordinator/*` code this service raises. */
export const COORDINATOR_ERROR_CODES = [
  /** No registered node has that id. */
  'coordinator/node-unknown',
  /** The node's token did not match, the node is revoked, or its id is unapproved. */
  'coordinator/auth-rejected',
  /** The node is registered but has no live `ready` connection. */
  'coordinator/node-offline',
  /** A unary call exceeded the caller's deadline. */
  'coordinator/request-timeout',
  /** The caller aborted a unary call. */
  'coordinator/request-aborted',
  /** The node already has the maximum number of unary calls in flight. */
  'coordinator/request-limit',
  /** The connection dropped while the call was in flight. */
  'coordinator/connection-lost',
  /** The node never sent a usable handshake in time. */
  'coordinator/handshake-failed',
  /** The node reports a capability this Coordinator cannot use. */
  'coordinator/capability-mismatch',
  /** The remote stream was already terminated. */
  'coordinator/stream-closed',
  /** The node already has the maximum number of streams open. */
  'coordinator/stream-limit',
  /** A consumer fell too far behind and the stream was dropped. */
  'coordinator/backpressure',
  /** A caller-supplied argument was unusable. */
  'coordinator/invalid-arguments',
  /** A frame was structurally invalid or spoke another protocol version. */
  'coordinator/protocol-invalid',
  /** A frame exceeded the negotiated size limit. */
  'coordinator/frame-too-large',
  /** The node registry is full. */
  'coordinator/registry-full',
  /** This service is shutting down. */
  'coordinator/shutdown',
  /** A bug in this service; never a business outcome. */
  'coordinator/internal',
] as const

/** One `coordinator/*` code. */
export type CoordinatorErrorCode = (typeof COORDINATOR_ERROR_CODES)[number]

/** Wire-shaped failure fields, mirroring what a node sends. */
export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

/** A failure raised at this service's boundary, or forwarded from a node. */
export class CoordinatorError extends Error {
  /** Stable code: `coordinator/*` here, or the node's own code when forwarded. */
  readonly code: string
  /** Non-sensitive, JSON-serializable context. */
  readonly details: Record<string, unknown>

  /**
   * @param code - stable failure category.
   * @param message - correction-oriented diagnostic without credentials.
   * @param details - non-sensitive JSON context.
   */
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'CoordinatorError'
    this.code = code
    this.details = details
  }
}

/** Whether a value is this service's own failure. */
export function isCoordinatorError(value: unknown): value is CoordinatorError {
  return value instanceof CoordinatorError
}

/** Project any thrown value into the wire failure shape. */
export function failureOf(error: unknown): RemoteFailure {
  if (isCoordinatorError(error)) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return {
    code: 'coordinator/internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

/** The text substituted for any redacted value. */
export const REDACTED = '«redacted»'

/**
 * Replace every occurrence of every secret with {@link REDACTED}.
 *
 * The Coordinator's log is the one place a node's bearer token could leak: the
 * token arrives inside a `hello` frame and the natural debugging instinct is to
 * log that frame. Every log line goes through this first.
 * @param text - arbitrary text.
 * @param secrets - literal values to remove.
 * @returns text containing none of the secrets.
 */
export function scrubText(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret === '') continue
    result = result.split(secret).join(REDACTED)
  }
  return result
}

/**
 * Replace the credential in a frame before it is logged or stored.
 *
 * Keeps the token's *presence*, which is what a diagnosing operator needs, and
 * nothing else.
 * @param frame - any decoded frame.
 * @returns a copy safe to persist.
 */
export function redactFrame(frame: AnyFrameLike): AnyFrameLike {
  if (frame === null || typeof frame !== 'object') return frame
  const copy: Record<string, unknown> = { ...(frame as Record<string, unknown>) }
  const auth = copy['auth']
  if (auth !== undefined && typeof auth === 'object' && auth !== null) {
    const token = (auth as { token?: unknown }).token
    copy['auth'] = {
      type: (auth as { type?: unknown }).type,
      token: typeof token === 'string' && token !== '' ? REDACTED : '«absent»',
    }
  }
  return copy
}

/** Structural frame shape for {@link redactFrame}, so it needs no narrowing. */
export type AnyFrameLike = object | null | undefined
