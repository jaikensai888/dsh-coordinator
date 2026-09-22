/**
 * The clock and timer seam.
 *
 * Every deadline in this service (handshake, request, stream idle, heartbeat)
 * goes through here, so a test can drive time instead of sleeping on it. That
 * matters more than usual for this service: two of its guarantees — "a unary call
 * settles exactly once" and "a half-open link is detected" — are only observable
 * across time.
 *
 * @module dsh-coordinator/timers
 */

/** A scheduled callback that can still be cancelled. */
export interface TimerHandle {
  /** Cancel the callback. Idempotent. */
  cancel(): void
}

/** Injectable time source. */
export interface TimerSource {
  /** Current wall-clock milliseconds. */
  now(): number
  /**
   * Schedule `callback` after `ms` milliseconds.
   * @param callback - invoked once unless cancelled.
   * @param ms - delay in milliseconds.
   */
  setTimeout(callback: () => void, ms: number): TimerHandle
}

/** The real clock. */
export const systemTimers: TimerSource = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    // A pending timer must never keep the process alive on its own: the server
    // owns its own lifetime through `stop()`.
    handle.unref?.()
    return { cancel: () => { clearTimeout(handle) } }
  },
}

/** Clamp a caller-supplied duration into a usable range. */
export function clampDuration(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
