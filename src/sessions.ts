/**
 * The session Remotes this service knows by name.
 *
 * This module is the **one** place in the Coordinator that names a DSH business
 * Remote, and it exists because the alternative is worse: without it, every caller
 * — a UI, a script, a future orchestrator — has to hard-code five endpoint names,
 * three different wrapper-argument names, and the exact shape of a prompt payload.
 * That is the same five constants copied into every caller instead of stored once,
 * except each copy can drift.
 *
 * The concession is bounded on purpose:
 *
 * 1. **Endpoints and argument names are configuration**, not logic, and every one
 *    of them has a default that matches a real `dsh-node`;
 * 2. **the request object is the caller's**, wrapped and forwarded — see
 *    {@link buildPromptRequest} for the single exception, and why it is one;
 * 3. **the node stays the authority**: a node that does not serve these Remotes
 *    answers with its own `node/capability-unavailable`, and this service adds no
 *    fallback.
 *
 * The argument names are per-endpoint rather than shared because they really are
 * different on the node. `session/list` takes `_request`; `session/page`,
 * `session/create`, `session/prompt` and `session/follow` all take `request`. A
 * single shared name cannot express that, and getting it wrong is not a subtle
 * failure — the node's Gateway rejects the call with `gateway/arguments-invalid`
 * before the business method ever runs.
 *
 * @module dsh-coordinator/sessions
 */

import { CoordinatorError } from './errors.js'
import { parseEndpoint } from './frame-codec.js'

/** Default endpoint behind {@link SessionsOptions.listEndpoint}. */
export const DEFAULT_SESSION_LIST_ENDPOINT = 'session/list'

/** Default endpoint behind {@link SessionsOptions.pageEndpoint}. */
export const DEFAULT_SESSION_PAGE_ENDPOINT = 'session/page'

/** Default endpoint behind {@link SessionsOptions.createEndpoint}. */
export const DEFAULT_SESSION_CREATE_ENDPOINT = 'session/create'

/** Default endpoint behind {@link SessionsOptions.promptEndpoint}. */
export const DEFAULT_SESSION_PROMPT_ENDPOINT = 'session/prompt'

/** Default endpoint behind {@link SessionsOptions.followEndpoint}. */
export const DEFAULT_SESSION_FOLLOW_ENDPOINT = 'session/follow'

/** Default idle deadline for a quiet `session/follow` stream: five minutes. */
export const DEFAULT_SESSION_FOLLOW_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Wrapper argument for `session/list`.
 *
 * Verified against `@deepseek-ai/dsh-api-session-controller` 0.1.5-rc.2, whose
 * descriptor declares this endpoint's single parameter as `_request`, and against
 * the client, which calls `sessionApi.list(args._request)`.
 */
export const DEFAULT_SESSION_LIST_ARGUMENT = '_request'

/**
 * Wrapper argument for `session/page`.
 *
 * `request`, **not** `_request`: the node's descriptor names this parameter
 * `request`, and the client reads `const page = request` out of the call payload.
 * Sharing one argument name across both views is what made the page view fail on a
 * real node while every unit test still passed.
 */
export const DEFAULT_SESSION_PAGE_ARGUMENT = 'request'

/** Wrapper argument for `session/create`, `session/prompt` and `session/follow`. */
export const DEFAULT_SESSION_REQUEST_ARGUMENT = 'request'

/** Default delivery mode for a prompt: append to the session's turn queue. */
export const DEFAULT_PROMPT_MODE: PromptMode = 'queue'

/** How a prompt is delivered to a session that may already be running a turn. */
export type PromptMode =
  /** Append behind whatever the session is doing. */
  | 'queue'
  /** Interrupt the current turn. */
  | 'steer'

/**
 * How the Coordinator names and wraps the session Remotes.
 *
 * Turning {@link SessionsOptions.enabled} off removes every session route from
 * both the library and the operator API, and the static UI with them: a
 * Coordinator that has been told not to know about sessions should not serve a page
 * that only knows how to talk about them.
 */
export interface SessionsOptions {
  /** Install the session routes at all. Defaults to true. */
  readonly enabled?: boolean
  /** Endpoint behind `listSessions`. */
  readonly listEndpoint?: string
  /** Argument that wraps the list request object. */
  readonly listRequestArgument?: string
  /** Endpoint behind `pageSessions`. */
  readonly pageEndpoint?: string
  /** Argument that wraps the page request object. */
  readonly pageRequestArgument?: string
  /** Endpoint behind `createSession`. */
  readonly createEndpoint?: string
  /** Endpoint behind `promptSession`. */
  readonly promptEndpoint?: string
  /** Endpoint behind `followSession`. */
  readonly followEndpoint?: string
  /** Argument that wraps the create / prompt / follow request object. */
  readonly requestArgument?: string
  /** Delivery mode used when a prompt does not state one. Defaults to `queue`. */
  readonly promptMode?: PromptMode
  /**
   * Idle deadline for a follow stream.
   *
   * Defaults to {@link DEFAULT_SESSION_FOLLOW_IDLE_TIMEOUT_MS}. A follow stream is
   * legitimately quiet while the agent thinks, so a deployment that follows long
   * sessions can raise this rather than be surprised by a dropped stream.
   */
  readonly followIdleTimeoutMs?: number
  /** Buffered-value ceiling for a follow stream. Defaults to `maxBufferedValues`. */
  readonly followMaxBufferedValues?: number
}

/** A fully resolved {@link SessionsOptions}. */
export interface ResolvedSessionsOptions {
  readonly enabled: boolean
  readonly listEndpoint: string
  readonly listRequestArgument: string
  readonly pageEndpoint: string
  readonly pageRequestArgument: string
  readonly createEndpoint: string
  readonly promptEndpoint: string
  readonly followEndpoint: string
  readonly requestArgument: string
  readonly promptMode: PromptMode
  readonly followIdleTimeoutMs: number | undefined
  readonly followMaxBufferedValues: number | undefined
}

/**
 * Fill in every default and refuse a configuration that cannot work.
 *
 * A typo in an endpoint name or an empty argument name is a startup failure rather
 * than a runtime 400: both are mistakes an operator makes once, at configure time,
 * and the failure is much cheaper to read here than from a node's
 * `gateway/arguments-invalid` three layers down.
 * @param options - the caller's configuration.
 * @returns the resolved configuration.
 * @throws CoordinatorError `coordinator/invalid-arguments` on a bad name.
 */
export function resolveSessionsOptions(options: SessionsOptions = {}): ResolvedSessionsOptions {
  return {
    enabled: options.enabled ?? true,
    listEndpoint: endpointName(options.listEndpoint, DEFAULT_SESSION_LIST_ENDPOINT, 'listEndpoint'),
    listRequestArgument: argumentName(
      options.listRequestArgument,
      DEFAULT_SESSION_LIST_ARGUMENT,
      'listRequestArgument',
    ),
    pageEndpoint: endpointName(options.pageEndpoint, DEFAULT_SESSION_PAGE_ENDPOINT, 'pageEndpoint'),
    pageRequestArgument: argumentName(
      options.pageRequestArgument,
      DEFAULT_SESSION_PAGE_ARGUMENT,
      'pageRequestArgument',
    ),
    createEndpoint: endpointName(options.createEndpoint, DEFAULT_SESSION_CREATE_ENDPOINT, 'createEndpoint'),
    promptEndpoint: endpointName(options.promptEndpoint, DEFAULT_SESSION_PROMPT_ENDPOINT, 'promptEndpoint'),
    followEndpoint: endpointName(options.followEndpoint, DEFAULT_SESSION_FOLLOW_ENDPOINT, 'followEndpoint'),
    requestArgument: argumentName(
      options.requestArgument,
      DEFAULT_SESSION_REQUEST_ARGUMENT,
      'requestArgument',
    ),
    // Absent means "use the default", not "an invalid value": the validator is for a
    // caller who *did* state a mode, and passing `undefined` through it would make
    // every default construction throw.
    promptMode: options.promptMode === undefined
      ? DEFAULT_PROMPT_MODE
      : promptMode(options.promptMode, 'promptMode'),
    followIdleTimeoutMs: optionalDuration(
      options.followIdleTimeoutMs ?? DEFAULT_SESSION_FOLLOW_IDLE_TIMEOUT_MS,
      'followIdleTimeoutMs',
    ),
    followMaxBufferedValues: optionalCount(options.followMaxBufferedValues, 'followMaxBufferedValues'),
  }
}

// ------------------------------------------------------------------ requests

/** What a caller may ask {@link buildCreateRequest} for. */
export interface CreateSessionInput {
  /** Working directory for the new session. */
  readonly cwd?: string
  /** Workspace to create the session inside. */
  readonly workspaceId?: string
  /** Pre-chosen session id. The node generates one when this is absent. */
  readonly sessionId?: string
  /** Agent preset to run the session with. */
  readonly agentPreset?: string
  /** Escape hatch: the node's own request object, sent verbatim. */
  readonly request?: Readonly<Record<string, unknown>>
}

/** What a caller may ask {@link buildPromptRequest} for. */
export interface PromptSessionInput {
  /** Session to prompt. */
  readonly sessionId?: string
  /** Plain text to send. Expanded into a one-part text content array. */
  readonly text?: string
  /** Pre-built content parts, used verbatim instead of {@link PromptSessionInput.text}. */
  readonly content?: readonly unknown[]
  /** Delivery mode. Defaults to the configured {@link SessionsOptions.promptMode}. */
  readonly mode?: PromptMode
  /** Correlation id. Generated when absent, because the node requires one. */
  readonly requestId?: string
  /** IANA time zone, so the node can render timestamps the way the caller sees them. */
  readonly clientTimeZone?: string
  /** Escape hatch: the node's own request object, sent verbatim. */
  readonly request?: Readonly<Record<string, unknown>>
}

/** What a caller may ask {@link buildFollowRequest} for. */
export interface FollowSessionInput {
  /** Session to follow. Expanded into `{address: {kind: 'session', sessionId}}`. */
  readonly sessionId?: string
  /** A pre-built address, used verbatim instead of {@link FollowSessionInput.sessionId}. */
  readonly address?: Readonly<Record<string, unknown>>
  /** Cap on the history the snapshot carries. */
  readonly maxMessages?: number
  /** Ask the node to stream assistant output as it is produced. */
  readonly assistantStream?: boolean
  /** Escape hatch: the node's own request object, sent verbatim. */
  readonly request?: Readonly<Record<string, unknown>>
}

/**
 * Build the `session/create` request object.
 * @param input - the fields to send.
 * @returns the node's own request shape.
 * @throws CoordinatorError `coordinator/invalid-arguments` for a wrong-typed field.
 */
export function buildCreateRequest(input: CreateSessionInput = {}): Readonly<Record<string, unknown>> {
  if (input.request !== undefined) return plainObject(input.request, 'request')
  return compact({
    workspaceId: optionalText(input.workspaceId, 'workspaceId'),
    cwd: optionalText(input.cwd, 'cwd'),
    sessionId: optionalText(input.sessionId, 'sessionId'),
    agentPreset: optionalText(input.agentPreset, 'agentPreset'),
  })
}

/**
 * Build the `session/prompt` request object.
 *
 * This is the one place the Coordinator shapes a business payload rather than
 * forwarding it, and the reason is that the node's shape is unusually hostile to a
 * caller who only wants to say something: a prompt is
 * `{requestId, sessionId, mode, content: [{type: 'text', text}]}`, where
 * `requestId` is mandatory and `content` is a tagged union. Assembling that by hand
 * in every caller — a UI click handler, a test script — is how the same three
 * fields get spelled slightly differently in each of them.
 *
 * The escape hatch is deliberate: {@link PromptSessionInput.request} and
 * {@link PromptSessionInput.content} bypass the expansion entirely, so an image or
 * file prompt is not blocked by this convenience.
 * @param input - the message to send.
 * @param options - the configured default mode, and a request-id generator.
 * @returns the node's own request shape.
 * @throws CoordinatorError `coordinator/invalid-arguments` when the input is unusable.
 */
export function buildPromptRequest(
  input: PromptSessionInput,
  options: { readonly defaultMode: PromptMode; readonly generateRequestId: () => string },
): Readonly<Record<string, unknown>> {
  if (input.request !== undefined) return plainObject(input.request, 'request')
  const sessionId = requiredText(input.sessionId, 'sessionId')
  const content = promptContent(input)
  const requestId = optionalText(input.requestId, 'requestId') ?? options.generateRequestId()
  const mode = input.mode === undefined ? options.defaultMode : promptMode(input.mode, 'mode')
  return compact({
    requestId,
    sessionId,
    mode,
    content,
    clientTimeZone: optionalText(input.clientTimeZone, 'clientTimeZone'),
  })
}

/**
 * Build the `session/follow` request object.
 * @param input - which session to follow, and how much history to ask for.
 * @returns the node's own request shape.
 * @throws CoordinatorError `coordinator/invalid-arguments` when neither a session
 * id nor an address is given.
 */
export function buildFollowRequest(input: FollowSessionInput = {}): Readonly<Record<string, unknown>> {
  if (input.request !== undefined) return plainObject(input.request, 'request')
  const address = input.address === undefined
    ? { kind: 'session', sessionId: requiredText(input.sessionId, 'sessionId') }
    : plainObject(input.address, 'address')
  return compact({
    address,
    maxMessages: optionalCount(input.maxMessages, 'maxMessages'),
    assistantStream: optionalBoolean(input.assistantStream, 'assistantStream'),
  })
}

/** Resolve the content array for a prompt, expanding plain text when asked to. */
function promptContent(input: PromptSessionInput): readonly unknown[] {
  if (input.content !== undefined) {
    if (!Array.isArray(input.content)) {
      throw new CoordinatorError('coordinator/invalid-arguments', '"content" must be an array of content parts', {})
    }
    return input.content
  }
  const text = requiredText(input.text, 'text')
  return [{ type: 'text', text }]
}

// ------------------------------------------------------------------ internals

/** Drop `undefined` values, so the node's exact-argument check sees only real fields. */
function compact(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

function plainObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" must be a plain object`, {
      field,
      received: Array.isArray(value) ? 'array' : typeof value,
    })
  }
  return value as Readonly<Record<string, unknown>>
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" must be a non-empty string`, { field })
  }
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requiredText(value, field)
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" must be a boolean`, { field })
  }
  return value
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      `"${field}" must be a non-negative integer`,
      { field },
    )
  }
  return value
}

/** A duration, when present, must be a positive finite number. */
function optionalDuration(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CoordinatorError('coordinator/invalid-arguments', `"${field}" must be a positive number`, { field })
  }
  return Math.trunc(value)
}

function promptMode(value: unknown, field: string): PromptMode {
  if (value !== 'queue' && value !== 'steer') {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      `"${field}" must be "queue" or "steer"`,
      { field, received: typeof value === 'string' ? value : typeof value },
    )
  }
  return value
}

/** A configured endpoint must be a `<namespace>/<method>` pair. */
function endpointName(value: string | undefined, fallback: string, field: string): string {
  const endpoint = value ?? fallback
  if (parseEndpoint(endpoint) === undefined) {
    throw new CoordinatorError(
      'coordinator/invalid-arguments',
      `sessions.${field} must be a <namespace>/<method> endpoint, received "${endpoint}"`,
      { field, endpoint },
    )
  }
  return endpoint
}

/** A configured wrapper argument must be a plausible, non-empty name. */
function argumentName(value: string | undefined, fallback: string, field: string): string {
  const name = value ?? fallback
  if (name.trim() === '') {
    throw new CoordinatorError('coordinator/invalid-arguments', `sessions.${field} must not be empty`, { field })
  }
  return name
}
