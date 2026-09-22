/**
 * Logging that cannot leak a node credential.
 *
 * The Coordinator's log is the one artifact that will be pasted into an issue or
 * a chat when something goes wrong, and the single most likely secret in it is a
 * node token: it arrives inside a `hello` frame, and logging whole frames is the
 * natural debugging instinct.
 *
 * So there is no way to log through this module without scrubbing: the secret
 * source is a *function*, consulted on every call, because the registry's records
 * change (a node enrolls, a token rotates) and a snapshot taken at startup would
 * go stale exactly when it matters.
 *
 * @module dsh-coordinator/log
 */

import { redactFrame, scrubText, type AnyFrameLike } from './errors.js'

/** Log levels, quietest last. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const

/** One log level. */
export type LogLevel = (typeof LOG_LEVELS)[number]

/** The logger shape this service uses. Deliberately not a full logging API. */
export interface CoordinatorLogger {
  /** Verbose diagnostics, off by default. */
  debug(message: string, details?: Record<string, unknown>): void
  /** Normal lifecycle transitions. */
  info(message: string, details?: Record<string, unknown>): void
  /** Recoverable problems worth an operator's attention. */
  warn(message: string, details?: Record<string, unknown>): void
  /** Failures that need action. */
  error(message: string, details?: Record<string, unknown>): void
  /** A frame, already redacted. */
  frame(direction: 'in' | 'out', frame: AnyFrameLike): void
}

/** A logger that discards everything. */
export const silentLogger: CoordinatorLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  frame: () => {},
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum level to emit. Defaults to `info`. */
  readonly level?: LogLevel
  /** Consulted on every line: the secrets to remove. */
  readonly secrets?: () => readonly string[]
  /** Where lines go. Defaults to stderr. */
  readonly sink?: (line: string) => void
  /** Whether to emit frame traces. Defaults to false. */
  readonly traceFrames?: boolean
}

/**
 * Build a redacting logger.
 * @param options - level, secret source, and sink.
 * @returns a logger safe to hand to any component.
 */
export function createLogger(options: LoggerOptions = {}): CoordinatorLogger {
  const level = options.level ?? 'info'
  const sink = options.sink ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  const threshold = LOG_LEVELS.indexOf(level)
  const trace = options.traceFrames ?? false

  const emit = (at: LogLevel, message: string, details?: Record<string, unknown>): void => {
    if (threshold < 0 || LOG_LEVELS.indexOf(at) < threshold) return
    const secrets = options.secrets?.() ?? []
    const suffix = details === undefined ? '' : ` ${safeJson(details, secrets)}`
    sink(scrubText(`${new Date().toISOString()} ${at.toUpperCase()} ${message}${suffix}`, secrets))
  }

  return {
    debug: (message, details) => { emit('debug', message, details) },
    info: (message, details) => { emit('info', message, details) },
    warn: (message, details) => { emit('warn', message, details) },
    error: (message, details) => { emit('error', message, details) },
    frame: (direction, frame) => {
      if (!trace) return
      // Redacted here rather than at the call site: a frame trace is a debugging
      // convenience, and "remember to redact before tracing" is a rule that
      // eventually gets forgotten at exactly the wrong moment.
      emit('debug', direction === 'in' ? 'frame/in' : 'frame/out', { frame: redactFrame(frame) })
    },
  }
}

/** Serialize log details, degrading to a string rather than throwing. */
function safeJson(value: unknown, secrets: readonly string[]): string {
  try {
    return scrubText(JSON.stringify(value) ?? String(value), secrets)
  } catch {
    // Circular or non-serializable context must not take down the caller that
    // was merely trying to log.
    return scrubText(String(value), secrets)
  }
}
