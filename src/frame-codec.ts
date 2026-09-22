/**
 * Frame encoding, size limiting, and structural validation — Coordinator side.
 *
 * Independent of the node's codec by design (see `protocol.ts`). Two rules it
 * shares with the node because the protocol requires them, not because the code
 * was copied:
 *
 * - a frame that cannot be parsed, is not an object, has an unknown `type`, or
 *   declares another `protocolVersion` is **refused**, never reinterpreted;
 * - nothing that is refused is echoed back — a rejected frame may carry a
 *   credential, so its body never reaches a log or an error message.
 *
 * @module dsh-coordinator/frame-codec
 */

import { CoordinatorError } from './errors.js'
import {
  FRAME_TYPES,
  NODE_FRAME_TYPES,
  PROTOCOL_VERSION,
  type AnyFrame,
  type NodeInboundFrame,
} from './protocol.js'

/** Raw socket payload shapes `ws` can deliver. */
export type RawFrameData = string | Buffer | ArrayBuffer | Uint8Array | readonly Buffer[] | readonly Uint8Array[]

/** Normalize whatever the socket layer handed us into text. */
export function toFrameText(data: RawFrameData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) {
    return Buffer.concat((data as readonly Uint8Array[]).map(part => Buffer.from(part))).toString('utf8')
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data as Uint8Array).toString('utf8')
}

/** UTF-8 byte length of a frame body. */
export function frameByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Serialize one outbound frame, refusing to emit anything oversized. */
export function encodeFrame(frame: AnyFrame, maxFrameBytes: number): string {
  const text = JSON.stringify(frame)
  const bytes = frameByteLength(text)
  if (bytes > maxFrameBytes) {
    throw new CoordinatorError(
      'coordinator/frame-too-large',
      `outbound ${frame.type} frame is ${bytes} bytes, over the ${maxFrameBytes} byte limit`,
      { type: frame.type, bytes, maxFrameBytes },
    )
  }
  return text
}

/**
 * Decode and validate one inbound frame.
 *
 * Structural only: it guarantees a well-formed frame of a type a **node** may
 * send. Whether that frame is legal in the current session state is the session's
 * decision, not the codec's.
 * @param data - raw socket payload.
 * @param maxFrameBytes - inbound ceiling, applied before parsing.
 * @returns the validated frame.
 * @throws CoordinatorError `coordinator/frame-too-large` or `coordinator/protocol-invalid`.
 */
export function decodeFrame(data: RawFrameData, maxFrameBytes: number): NodeInboundFrame {
  const text = toFrameText(data)
  const bytes = frameByteLength(text)
  if (bytes > maxFrameBytes) {
    throw new CoordinatorError(
      'coordinator/frame-too-large',
      `inbound frame is ${bytes} bytes, over the ${maxFrameBytes} byte limit`,
      { bytes, maxFrameBytes },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CoordinatorError('coordinator/protocol-invalid', 'inbound frame is not valid JSON', {
      reason: 'not-json',
      bytes,
    })
  }
  if (!isPlainObject(parsed)) {
    throw new CoordinatorError('coordinator/protocol-invalid', 'inbound frame must be a JSON object', {
      reason: 'not-object',
    })
  }

  const type = parsed['type']
  if (typeof type !== 'string' || !FRAME_TYPES.includes(type)) {
    throw new CoordinatorError('coordinator/protocol-invalid', 'inbound frame has an unknown type', {
      reason: 'unknown-type',
      type: typeof type === 'string' ? type : typeof type,
    })
  }
  if (!NODE_FRAME_TYPES.has(type)) {
    // A node must never send the Coordinator's own vocabulary; treating it as a
    // command would be exactly the confusion the direction split exists to avoid.
    throw new CoordinatorError('coordinator/protocol-invalid', `a node must not send a ${type} frame`, {
      reason: 'wrong-direction',
      type,
    })
  }

  const version = parsed['protocolVersion']
  if (version !== PROTOCOL_VERSION) {
    throw new CoordinatorError(
      'coordinator/protocol-invalid',
      `inbound ${type} frame declares an unsupported protocol version`,
      {
        reason: 'protocol-version',
        type,
        expected: PROTOCOL_VERSION,
        received: typeof version === 'string' ? version : typeof version,
      },
    )
  }

  requireString(parsed, 'nodeId', type)
  validateBody(type, parsed)
  return parsed as unknown as NodeInboundFrame
}

/** Whether a decode failure was a protocol-version mismatch. */
export function isProtocolVersionFailure(error: unknown): boolean {
  return error instanceof CoordinatorError && error.details['reason'] === 'protocol-version'
}

/** Split a canonical `<namespace>/<method>` endpoint, or `undefined`. */
export function parseEndpoint(endpoint: unknown): { namespace: string; method: string } | undefined {
  if (typeof endpoint !== 'string' || endpoint === '') return undefined
  const segments = endpoint.split('/')
  if (segments.length !== 2) return undefined
  const [namespace, method] = segments as [string, string]
  if (namespace === '' || method === '') return undefined
  return { namespace, method }
}

/** Cordis/JSON-safe plain object test. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Per-type required-field validation. */
function validateBody(type: string, frame: Record<string, unknown>): void {
  switch (type) {
    case 'hello': {
      requireString(frame, 'mode', type)
      const auth = frame['auth']
      if (!isPlainObject(auth)) throw invalid(type, 'requires a plain-object "auth" field')
      requireString(auth, 'type', `${type}.auth`)
      requireString(auth, 'token', `${type}.auth`)
      optionalString(frame, 'nodeName', type)
      optionalString(frame, 'role', type)
      return
    }
    case 'ready': {
      const capabilities = frame['capabilities']
      if (!isPlainObject(capabilities)) throw invalid(type, 'requires a plain-object "capabilities" field')
      if (!Array.isArray(capabilities['remotes'])) throw invalid(type, 'capabilities.remotes must be an array')
      for (const entry of capabilities['remotes'] as unknown[]) {
        if (!isPlainObject(entry)) throw invalid(type, 'each capability must be an object')
        requireString(entry, 'endpoint', `${type}.capabilities.remotes[]`)
        const mode = entry['mode']
        if (mode !== 'unary' && mode !== 'stream') {
          throw invalid(type, 'a capability mode must be "unary" or "stream"')
        }
      }
      requireString(capabilities, 'remoteSurfaceHash', `${type}.capabilities`)
      if (!Array.isArray(capabilities['namespaces'])) throw invalid(type, 'capabilities.namespaces must be an array')
      return
    }
    case 'rpc.result': {
      requireString(frame, 'requestId', type)
      const result = frame['result']
      if (!isPlainObject(result)) throw invalid(type, 'requires a plain-object "result" field')
      if (result['ok'] === true) {
        // A missing `value` means the Remote returned `undefined`, and that is not
        // a malformed frame: `JSON.stringify` cannot represent `undefined`, so an
        // empty success *has* to arrive as `{ok:true}`. Requiring the key would
        // make that call unrepresentable — and refusing it strands the caller
        // until its deadline on a call that already succeeded.
        return
      }
      if (result['ok'] !== false) throw invalid(type, 'result.ok must be a boolean')
      requireFailure(result['error'], type)
      return
    }
    case 'stream.ready':
      requireString(frame, 'streamId', type)
      return
    case 'stream.data':
      requireString(frame, 'streamId', type)
      requireNumber(frame, 'seq', type)
      // Same rule as `rpc.result`: a stream that yields `undefined` sends no
      // `value` key, and `seq` is what proves the frame is otherwise intact.
      return
    case 'stream.end':
      requireString(frame, 'streamId', type)
      requireNumber(frame, 'count', type)
      return
    case 'stream.error':
      requireString(frame, 'streamId', type)
      requireNumber(frame, 'count', type)
      requireFailure(frame['error'], type)
      return
    case 'close':
      optionalString(frame, 'code', type)
      optionalString(frame, 'reason', type)
      if (Object.hasOwn(frame, 'reconnect') && typeof frame['reconnect'] !== 'boolean') {
        throw invalid(type, 'field "reconnect" must be a boolean')
      }
      return
    case 'ping':
    case 'pong':
      return
    default:
      throw invalid(type, 'is not implemented by this Coordinator')
  }
}

/** Validate a failure object: `code` and `message` are required, `details` defaults. */
function requireFailure(value: unknown, type: string): void {
  if (!isPlainObject(value)) throw invalid(type, 'requires a plain-object failure')
  requireString(value, 'code', `${type}.error`)
  requireString(value, 'message', `${type}.error`)
  if (Object.hasOwn(value, 'details') && !isPlainObject(value['details'])) {
    throw invalid(type, 'error.details must be a plain object when present')
  }
}

function invalid(type: string, detail: string): CoordinatorError {
  return new CoordinatorError('coordinator/protocol-invalid', `${type} frame ${detail}`, {
    reason: 'invalid-field',
    type,
  })
}

function requireString(frame: Record<string, unknown>, field: string, type: string): string {
  const value = frame[field]
  if (typeof value !== 'string' || value === '') {
    throw invalid(type, `requires a non-empty string field ${JSON.stringify(field)}`)
  }
  return value
}

function optionalString(frame: Record<string, unknown>, field: string, type: string): void {
  const value = frame[field]
  if (value === undefined) return
  if (typeof value !== 'string') throw invalid(type, `field ${JSON.stringify(field)} must be a string when present`)
}

function requireNumber(frame: Record<string, unknown>, field: string, type: string): number {
  const value = frame[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(type, `requires a finite number field ${JSON.stringify(field)}`)
  }
  return value
}
