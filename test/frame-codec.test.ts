/**
 * The frame codec is this service's outer boundary: every inbound byte is
 * decoded and validated here before any session logic sees it, and every
 * outbound frame is sized here.
 *
 * Two promises shape these tests:
 *
 * - a frame that is refused is **never reinterpreted** — an unknown type, a
 *   Coordinator-only type, another protocol version, or an oversized payload all
 *   stop at the codec, with a stable `reason` so the transport can tell a version
 *   mismatch (never retryable) from everything else;
 * - nothing a refusal reports may echo the frame body — a rejected `hello` may
 *   carry a bearer token, so the credential is asserted absent from every
 *   message and every detail of every rejection path.
 *
 * @module dsh-coordinator/test/frame-codec
 */

import { describe, expect, it } from 'vitest'
import { CoordinatorError, isCoordinatorError } from '../src/errors.js'
import {
  decodeFrame,
  encodeFrame,
  frameByteLength,
  isProtocolVersionFailure,
  parseEndpoint,
  toFrameText,
} from '../src/frame-codec.js'
import {
  COORDINATOR_FRAME_TYPES,
  NODE_FRAME_TYPES,
  PROTOCOL_VERSION,
  type PingFrame,
  type RpcRequestFrame,
} from '../src/protocol.js'
import { sampleCapabilities } from './helpers.js'

/** A ceiling high enough that tests not about the limit never reach it. */
const NO_LIMIT = 8 * 1024 * 1024

/** A distinctive credential, so a leak into an error message is unmistakable. */
const TOKEN = 'tok-9f3a-never-logged'

/** Run `run`, expecting a refusal, and return the failure it raised. */
function thrownBy(run: () => unknown): CoordinatorError {
  try {
    run()
  } catch (error) {
    if (isCoordinatorError(error)) return error
    throw error
  }
  throw new Error('expected the call to throw a CoordinatorError')
}

/** Decode, expecting a refusal, and return the failure. */
function refusal(text: string, maxFrameBytes: number = NO_LIMIT): CoordinatorError {
  return thrownBy(() => decodeFrame(text, maxFrameBytes))
}

/** A complete, valid `hello`, with the credential every refusal test needs. */
const HELLO: Record<string, unknown> = {
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  nodeId: 'alpha',
  mode: 'full-access',
  auth: { type: 'bearer', token: TOKEN },
}

/** A complete, valid `ready`. */
const READY: Record<string, unknown> = {
  type: 'ready',
  protocolVersion: PROTOCOL_VERSION,
  nodeId: 'alpha',
  capabilities: sampleCapabilities(),
}

/** A complete, valid successful `rpc.result`. */
const RPC_RESULT: Record<string, unknown> = {
  type: 'rpc.result',
  protocolVersion: PROTOCOL_VERSION,
  nodeId: 'alpha',
  requestId: 'r1',
  result: { ok: true, value: 1 },
}

/** A complete, valid `stream.data`. */
const STREAM_DATA: Record<string, unknown> = {
  type: 'stream.data',
  protocolVersion: PROTOCOL_VERSION,
  nodeId: 'alpha',
  streamId: 's1',
  seq: 1,
  value: 'first',
}

/**
 * Serialize one frame as a node would, with a field overridden or removed.
 *
 * `JSON.stringify` drops `undefined` values, which is how a variant deletes a
 * required field instead of blanking it — exactly what a node that forgot the
 * field would put on the wire.
 * @param frame - the base frame.
 * @param overrides - fields to replace, or to drop when `undefined`.
 * @returns the wire text.
 */
function frameText(frame: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...frame, ...overrides })
}

describe('parseEndpoint', () => {
  it('splits a canonical endpoint into its namespace and method', () => {
    expect(parseEndpoint('pluginInventory/list')).toEqual({ namespace: 'pluginInventory', method: 'list' })
    expect(parseEndpoint('session/watch')).toEqual({ namespace: 'session', method: 'watch' })
  })

  it('refuses anything that is not exactly two non-empty segments', () => {
    for (const endpoint of ['a', 'a/b/c', '/b', 'a/', '', '/', 'a//b', '/a/b/']) {
      expect(parseEndpoint(endpoint)).toBeUndefined()
    }
  })

  it('refuses an endpoint that is not a string', () => {
    const refused: readonly unknown[] = [null, undefined, 42, 0, true, {}, [], ['a', 'b']]
    for (const value of refused) expect(parseEndpoint(value)).toBeUndefined()
  })
})

describe('decodeFrame: direction, version and envelope', () => {
  it('decodes a complete hello frame with its credential intact', () => {
    const frame = decodeFrame(frameText(HELLO, { nodeName: 'Alpha', role: 'worker' }), NO_LIMIT)
    expect(frame).toEqual({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: 'alpha',
      nodeName: 'Alpha',
      role: 'worker',
      mode: 'full-access',
      auth: { type: 'bearer', token: TOKEN },
    })
  })

  it('refuses a payload that is not JSON', () => {
    const text = '{"type":"hello",'
    const error = refusal(text)
    expect(error.code).toBe('coordinator/protocol-invalid')
    expect(error.details).toEqual({ reason: 'not-json', bytes: frameByteLength(text) })
  })

  it('refuses JSON that is not an object', () => {
    for (const text of ['"hello"', '[1,2]', 'null', '42', 'true']) {
      expect(refusal(text).details['reason']).toBe('not-object')
    }
  })

  it('refuses a frame whose type is missing or unknown', () => {
    expect(refusal(frameText(HELLO, { type: 'no.such.frame' })).details['reason']).toBe('unknown-type')
    expect(refusal(frameText(HELLO, { type: 'no.such.frame' })).details['type']).toBe('no.such.frame')

    const missing = refusal(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, nodeId: 'alpha' }))
    expect(missing.details['type']).toBe('undefined')

    expect(refusal(JSON.stringify({ type: 42, protocolVersion: PROTOCOL_VERSION, nodeId: 'alpha' })).details['type']).toBe('number')
  })

  it('refuses every frame type only the Coordinator may send', () => {
    const coordinatorOnly = [...COORDINATOR_FRAME_TYPES].filter(type => !NODE_FRAME_TYPES.has(type))
    expect(coordinatorOnly.length).toBeGreaterThan(0)
    for (const type of coordinatorOnly) {
      const error = refusal(frameText(HELLO, { type }))
      expect(error.details['reason']).toBe('wrong-direction')
      expect(error.details['type']).toBe(type)
    }
  })

  it('refuses a frame that declares another protocol version', () => {
    const error = refusal(frameText(HELLO, { protocolVersion: 'dsh-node/2' }))
    expect(error.code).toBe('coordinator/protocol-invalid')
    expect(error.details).toEqual({
      reason: 'protocol-version',
      type: 'hello',
      expected: PROTOCOL_VERSION,
      received: 'dsh-node/2',
    })

    expect(refusal(JSON.stringify({ type: 'ping', nodeId: 'alpha' })).details['received']).toBe('undefined')
    expect(refusal(JSON.stringify({ type: 'ping', protocolVersion: 1, nodeId: 'alpha' })).details['received']).toBe('number')
  })

  it('recognises the protocol-version failure and nothing else', () => {
    expect(isProtocolVersionFailure(refusal(frameText(HELLO, { protocolVersion: 'dsh-node/2' })))).toBe(true)
    expect(isProtocolVersionFailure(refusal(frameText(HELLO, { mode: undefined })))).toBe(false)
    expect(isProtocolVersionFailure(refusal(frameText(HELLO, { type: 'no.such.frame' })))).toBe(false)
    expect(isProtocolVersionFailure(refusal(frameText(HELLO, { type: 'hello.ok' })))).toBe(false)
    expect(isProtocolVersionFailure(refusal('not json'))).toBe(false)
    expect(isProtocolVersionFailure(refusal('x'.repeat(64), 32))).toBe(false)
    expect(isProtocolVersionFailure(new CoordinatorError('coordinator/protocol-invalid', 'other', { reason: 'not-object' }))).toBe(false)
    expect(isProtocolVersionFailure(new Error('not a coordinator failure'))).toBe(false)
    expect(isProtocolVersionFailure(undefined)).toBe(false)
  })

  it('requires a nodeId on every frame', () => {
    const error = refusal(JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION }))
    expect(error.code).toBe('coordinator/protocol-invalid')
    expect(error.details['reason']).toBe('invalid-field')
    expect(error.message).toContain('nodeId')
    expect(refusal(JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: '' })).details['reason']).toBe('invalid-field')
  })
})

describe('decodeFrame: the size limit', () => {
  it('refuses an oversized frame before it tries to parse it', () => {
    const error = refusal('x'.repeat(64), 32)
    expect(error.code).toBe('coordinator/frame-too-large')
    expect(error.details).toEqual({ bytes: 64, maxFrameBytes: 32 })
  })

  it('measures the limit in UTF-8 bytes rather than characters', () => {
    const text = JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: 'é'.repeat(20) })
    const characters = text.length
    const bytes = frameByteLength(text)
    expect(bytes).toBeGreaterThan(characters)
    // A character-counting limit would accept this frame; the byte limit refuses it.
    expect(refusal(text, characters).code).toBe('coordinator/frame-too-large')
    expect(decodeFrame(text, bytes).type).toBe('ping')
  })

  it('accepts a frame that is exactly at the byte limit', () => {
    const text = JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: 'alpha' })
    expect(decodeFrame(text, frameByteLength(text)).type).toBe('ping')
  })
})

describe('decodeFrame: per-type required fields', () => {
  it('refuses a hello frame that omits its mode', () => {
    for (const overrides of [{ mode: undefined }, { mode: '' }, { mode: 7 }]) {
      const error = refusal(frameText(HELLO, overrides))
      expect(error.code).toBe('coordinator/protocol-invalid')
      expect(error.details['reason']).toBe('invalid-field')
    }
  })

  it('refuses a hello frame that omits part of its credential', () => {
    for (const overrides of [
      { auth: { type: 'bearer' } },
      { auth: { type: 'bearer', token: '' } },
      { auth: { token: TOKEN } },
      { auth: { type: '', token: TOKEN } },
    ]) {
      expect(refusal(frameText(HELLO, overrides)).details['reason']).toBe('invalid-field')
    }
  })

  it('refuses a hello frame whose auth is not a plain object', () => {
    for (const auth of [TOKEN, null, [], 42, true]) {
      expect(refusal(frameText(HELLO, { auth })).details['reason']).toBe('invalid-field')
    }
  })

  it('refuses a hello frame whose display metadata has the wrong type', () => {
    expect(refusal(frameText(HELLO, { nodeName: 42 })).details['reason']).toBe('invalid-field')
    expect(refusal(frameText(HELLO, { role: 42 })).details['reason']).toBe('invalid-field')
    expect(decodeFrame(frameText(HELLO, { nodeName: 'Alpha', role: 'worker' }), NO_LIMIT)).toMatchObject({ type: 'hello' })
  })

  it('refuses a ready frame that does not describe its capability surface', () => {
    const variants: readonly Record<string, unknown>[] = [
      { capabilities: undefined },
      { capabilities: 'nope' },
      { capabilities: { ...sampleCapabilities(), remotes: 'nope' } },
      { capabilities: { ...sampleCapabilities(), remotes: [null] } },
      { capabilities: { ...sampleCapabilities(), remotes: [{ mode: 'unary' }] } },
      { capabilities: { ...sampleCapabilities(), remotes: [{ endpoint: 'pluginInventory/list' }] } },
      { capabilities: { ...sampleCapabilities(), remotes: [{ endpoint: 'pluginInventory/list', mode: 'unary ' }] } },
      { capabilities: { ...sampleCapabilities(), remoteSurfaceHash: undefined } },
      { capabilities: { ...sampleCapabilities(), namespaces: 'nope' } },
    ]
    for (const overrides of variants) {
      const error = refusal(frameText(READY, overrides))
      expect(error.code).toBe('coordinator/protocol-invalid')
      expect(error.details['reason']).toBe('invalid-field')
    }
    expect(decodeFrame(frameText(READY), NO_LIMIT)).toMatchObject({ type: 'ready' })
  })

  it('reads a missing value key on a successful rpc.result as an undefined value', () => {
    // A Remote that returns nothing encodes as `{ok:true}`: JSON has no way to
    // spell an undefined value, so the key disappears. Refusing that frame would
    // make an empty success unrepresentable — and, because a refused frame on a
    // ready connection is ignored, would leave the caller waiting out its whole
    // deadline for a call that had already succeeded.
    expect(JSON.stringify({ ok: true, value: undefined })).toBe('{"ok":true}')
    expect(decodeFrame(frameText(RPC_RESULT, { result: { ok: true } }), NO_LIMIT)).toMatchObject({
      type: 'rpc.result',
      result: { ok: true },
    })

    // `null` is a value and must survive as itself, not be confused with absence.
    expect(decodeFrame(frameText(RPC_RESULT, { result: { ok: true, value: null } }), NO_LIMIT)).toMatchObject({
      type: 'rpc.result',
      result: { ok: true, value: null },
    })

    // A success result still has to be an object with a boolean `ok`.
    for (const result of [{}, { value: 1 }, { ok: 'true' }, 'done', null]) {
      expect(refusal(frameText(RPC_RESULT, { result })).details['reason']).toBe('invalid-field')
    }
  })

  it('requires a usable failure on a failed rpc.result', () => {
    for (const result of [
      { ok: false },
      { ok: false, error: 'boom' },
      { ok: false, error: { code: 'session/not-found' } },
      { ok: false, error: { message: 'gone' } },
      { ok: false, error: { code: 'session/not-found', message: 'gone', details: [] } },
    ]) {
      expect(refusal(frameText(RPC_RESULT, { result })).details['reason']).toBe('invalid-field')
    }
    // `ok` must be a boolean, not something truthy.
    expect(refusal(frameText(RPC_RESULT, { result: { value: 1 } })).details['reason']).toBe('invalid-field')
    expect(refusal(frameText(RPC_RESULT, { result: { ok: 'true', value: 1 } })).details['reason']).toBe('invalid-field')
    expect(refusal(frameText(RPC_RESULT, { result: 'done' })).details['reason']).toBe('invalid-field')
    expect(
      decodeFrame(
        frameText(RPC_RESULT, { result: { ok: false, error: { code: 'session/not-found', message: 'gone', details: { id: 'x' } } } }),
        NO_LIMIT,
      ),
    ).toMatchObject({ type: 'rpc.result', result: { ok: false, error: { code: 'session/not-found' } } })
  })

  it('requires a stream id and a numeric seq on stream.data', () => {
    for (const overrides of [{ streamId: undefined }, { streamId: '' }, { seq: undefined }, { seq: '1' }, { seq: null }, { seq: true }]) {
      expect(refusal(frameText(STREAM_DATA, overrides)).details['reason']).toBe('invalid-field')
    }
    // "seq starts at 1" is the stream hub's rule, not the codec's: a structurally
    // valid frame is decoded and judged by the session.
    expect(decodeFrame(frameText(STREAM_DATA, { seq: 0 }), NO_LIMIT)).toMatchObject({ seq: 0 })
    expect(decodeFrame(frameText(STREAM_DATA, { seq: 7 }), NO_LIMIT)).toMatchObject({ seq: 7 })
  })

  it('treats a missing value key on stream.data as a yielded undefined', () => {
    // Same rule as `rpc.result`: a stream that yields `undefined` sends no `value`
    // key, and `seq` is what proves the frame is otherwise intact.
    expect(refusal(frameText(STREAM_DATA, { seq: undefined })).details['reason']).toBe('invalid-field')
    expect(decodeFrame(frameText(STREAM_DATA, { value: undefined }), NO_LIMIT)).toMatchObject({ seq: 1 })
    expect(decodeFrame(frameText(STREAM_DATA, { value: null }), NO_LIMIT)).toMatchObject({ value: null })
    expect(decodeFrame(frameText(STREAM_DATA, { value: false }), NO_LIMIT)).toMatchObject({ value: false })
  })

  it('requires a count on both terminal stream frames', () => {
    const end = { type: 'stream.end', protocolVersion: PROTOCOL_VERSION, nodeId: 'alpha', streamId: 's1' }
    const failure = { code: 'node/backpressure', message: 'too fast' }
    expect(refusal(frameText(end)).message).toContain('count')
    expect(refusal(frameText(end, { count: '2' })).details['reason']).toBe('invalid-field')
    expect(refusal(frameText({ ...end, type: 'stream.error', error: failure })).message).toContain('count')
    expect(refusal(frameText({ ...end, type: 'stream.error', count: 2 })).message).toContain('error')
    expect(decodeFrame(frameText(end, { count: 2 }), NO_LIMIT)).toMatchObject({ type: 'stream.end', count: 2 })
    expect(decodeFrame(frameText({ ...end, type: 'stream.error', count: 0, error: failure }), NO_LIMIT)).toMatchObject({
      type: 'stream.error',
      count: 0,
    })
    expect(decodeFrame(frameText({ ...end, type: 'stream.ready' }), NO_LIMIT)).toMatchObject({ type: 'stream.ready' })
  })

  it('refuses a close frame whose optional fields have the wrong type', () => {
    const close = { type: 'close', protocolVersion: PROTOCOL_VERSION, nodeId: 'alpha' }
    expect(refusal(frameText(close, { reconnect: 'yes' })).details['reason']).toBe('invalid-field')
    expect(refusal(frameText(close, { code: 42 })).details['reason']).toBe('invalid-field')
    expect(refusal(frameText(close, { reason: 42 })).details['reason']).toBe('invalid-field')
    expect(decodeFrame(frameText(close, { code: 'node/going-away', reason: 'bye', reconnect: true }), NO_LIMIT)).toMatchObject({
      type: 'close',
      reconnect: true,
    })
    expect(decodeFrame(frameText(close), NO_LIMIT)).toMatchObject({ type: 'close' })
    expect(decodeFrame(frameText(close, { type: 'pong' }), NO_LIMIT)).toMatchObject({ type: 'pong' })
  })
})

describe('refusal safety', () => {
  it('never echoes the credential a refused frame carried', () => {
    const frames: readonly { readonly text: string; readonly maxFrameBytes?: number }[] = [
      { text: frameText(HELLO, { mode: undefined }) },
      { text: frameText(HELLO, { protocolVersion: 'dsh-node/2' }) },
      { text: frameText(HELLO, { auth: TOKEN }) },
      { text: frameText(HELLO, { nodeId: '' }) },
      { text: frameText(HELLO, { nodeName: 'x'.repeat(200) }), maxFrameBytes: 64 },
      { text: frameText(HELLO, { type: 'rpc.request' }) },
      { text: `{"type":"hello","auth":{"token":"${TOKEN}"` },
    ]

    for (const entry of frames) {
      // Guard the guard: the frame really does carry the credential.
      expect(entry.text).toContain(TOKEN)
      const error = refusal(entry.text, entry.maxFrameBytes ?? NO_LIMIT)
      expect(error.code).toMatch(/^coordinator\/(protocol-invalid|frame-too-large)$/)
      expect(JSON.stringify({ code: error.code, message: error.message, details: error.details })).not.toContain(TOKEN)
    }
  })
})

describe('encodeFrame', () => {
  it('serializes an outbound frame the node can read', () => {
    const frame: RpcRequestFrame = {
      type: 'rpc.request',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: 'alpha',
      requestId: 'r1',
      endpoint: 'pluginInventory/list',
      payload: { args: { limit: 5 } },
    }
    expect(JSON.parse(encodeFrame(frame, NO_LIMIT))).toEqual(frame)
  })

  it('refuses to emit a frame over the byte limit', () => {
    const frame: RpcRequestFrame = {
      type: 'rpc.request',
      protocolVersion: PROTOCOL_VERSION,
      nodeId: 'alpha',
      requestId: 'r1',
      endpoint: 'pluginInventory/list',
      payload: { args: { blob: 'x'.repeat(200) } },
    }
    const error = thrownBy(() => encodeFrame(frame, 64))
    expect(error.code).toBe('coordinator/frame-too-large')
    expect(error.details).toEqual({
      type: 'rpc.request',
      bytes: frameByteLength(JSON.stringify(frame)),
      maxFrameBytes: 64,
    })
  })

  it('emits a frame that is exactly at the byte limit', () => {
    const frame: PingFrame = { type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: 'alpha' }
    const text = JSON.stringify(frame)
    expect(encodeFrame(frame, frameByteLength(text))).toBe(text)
  })

  it('sizes an outbound frame in UTF-8 bytes', () => {
    const frame: PingFrame = { type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: 'é'.repeat(20) }
    const text = JSON.stringify(frame)
    const bytes = frameByteLength(text)
    expect(bytes).toBeGreaterThan(text.length)
    expect(thrownBy(() => encodeFrame(frame, text.length)).code).toBe('coordinator/frame-too-large')
    expect(encodeFrame(frame, bytes)).toBe(text)
  })
})

describe('toFrameText and frameByteLength', () => {
  it('reads every payload shape the socket layer can deliver', () => {
    const text = '{"type":"ping","nodeId":"é"}'
    const bytes = new TextEncoder().encode(text)
    expect(toFrameText(text)).toBe(text)
    expect(toFrameText(Buffer.from(text))).toBe(text)
    expect(toFrameText(bytes)).toBe(text)
    expect(toFrameText(bytes.buffer)).toBe(text)
  })

  it('joins a payload that arrived as an array of chunks', () => {
    const text = '{"type":"ping","nodeId":"alpha"}'
    const half = Math.floor(text.length / 2)
    expect(toFrameText([Buffer.from(text.slice(0, half)), Buffer.from(text.slice(half))])).toBe(text)
    expect(toFrameText([new TextEncoder().encode('{"type":'), new TextEncoder().encode('"ping"}')])).toBe('{"type":"ping"}')
    expect(toFrameText([])).toBe('')
  })

  it('counts UTF-8 bytes rather than characters', () => {
    expect(frameByteLength('')).toBe(0)
    expect(frameByteLength('abc')).toBe(3)
    expect(frameByteLength('é')).toBe(2)
    expect(frameByteLength('中文')).toBe(6)
    expect(frameByteLength('🙂')).toBe(4)
    expect(frameByteLength('{"nodeId":"é"}')).toBe(Buffer.byteLength('{"nodeId":"é"}', 'utf8'))
  })

  it('decodes a frame that arrived split across several chunks', () => {
    const text = JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION, nodeId: 'alpha' })
    const third = Math.ceil(text.length / 3)
    const chunks = [text.slice(0, third), text.slice(third, third * 2), text.slice(third * 2)].map(part => Buffer.from(part))
    expect(decodeFrame(chunks, NO_LIMIT).type).toBe('ping')
  })
})
