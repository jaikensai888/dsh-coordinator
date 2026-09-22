#!/usr/bin/env node
/**
 * A stand-in **node**: the smallest process that speaks `dsh-node/1` outward.
 *
 * It exists so the Coordinator can be exercised end to end — handshake, unary,
 * stream, heartbeat, cancellation — without a DSH install, and so a failure can be
 * attributed: if this fake and the real `dsh-node` plugin disagree, the difference
 * is a protocol bug; if they agree, the Coordinator is at fault.
 *
 * It never logs a credential: the token is redacted from every line, and frames
 * are printed with the credential replaced.
 *
 * Usage:
 *   node tools/fake-node.mjs --url ws://127.0.0.1:39472/node --token-env NODE_TOKEN
 *
 * Flags:
 *   --url <ws://…>        Coordinator URL (default ws://127.0.0.1:39472/node)
 *   --node-id <id>        identity to claim (default: a stable fake id)
 *   --node-name <name>    display name
 *   --token <token>       credential (visible in the process list)
 *   --token-env <VAR>     read the credential from the environment (preferred)
 *   --heartbeat-ms <n>    ping cadence (default 5000)
 *   --stream-count <n>    values to yield per stream (default 3)
 *   --unary-delay <ms>    delay before answering a unary call
 *   --fail <endpoint>     answer this endpoint with a business failure
 *   --log                 print every frame (redacted)
 *   --exit-after-ready    exit 0 once the handshake completes (a smoke test)
 *
 * @module dsh-node/tools/fake-node
 */

import { WebSocket } from 'ws'

const PROTOCOL_VERSION = 'dsh-node/1'
const REDACTED = '«redacted»'

/** Parse argv. */
function parseArgs(argv) {
  const options = {
    url: 'ws://127.0.0.1:39472/node',
    nodeId: 'fake-node-0001',
    nodeName: 'fake-node',
    token: undefined,
    heartbeatMs: 5_000,
    streamCount: 3,
    unaryDelay: 0,
    fail: undefined,
    log: false,
    exitAfterReady: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      index += 1
      if (argv[index] === undefined) throw new Error(`${flag} requires a value`)
      return argv[index]
    }
    switch (flag) {
      case '--url': options.url = value(); break
      case '--node-id': options.nodeId = value(); break
      case '--node-name': options.nodeName = value(); break
      case '--token': options.token = value(); break
      case '--token-env': {
        const name = value()
        options.token = process.env[name]
        if (options.token === undefined || options.token === '') throw new Error(`environment variable ${name} is empty`)
        break
      }
      case '--heartbeat-ms': options.heartbeatMs = Number(value()); break
      case '--stream-count': options.streamCount = Number(value()); break
      case '--unary-delay': options.unaryDelay = Number(value()); break
      case '--fail': options.fail = value(); break
      case '--log': options.log = true; break
      case '--exit-after-ready': options.exitAfterReady = true; break
      case '--help': process.stdout.write('see the module doc comment in tools/fake-node.mjs\n'); process.exit(0); break
      default: throw new Error(`unknown flag "${flag}"`)
    }
  }
  if (options.token === undefined) throw new Error('a token is required (--token or --token-env)')
  return options
}

const options = parseArgs(process.argv.slice(2))

/** Redact the credential from anything printed. */
function redact(text) {
  const secrets = [options.token, process.env[process.env.__FAKE_NODE_ENV ?? ''] ?? '']
  let result = String(text)
  for (const secret of secrets) {
    if (secret !== '' && secret !== undefined) result = result.split(secret).join(REDACTED)
  }
  return result
}

/** One log line, on stderr so stdout stays a clean event stream. */
function log(message, details) {
  const suffix = details === undefined ? '' : ` ${redact(JSON.stringify(details))}`
  process.stderr.write(`${new Date().toISOString()} ${message}${suffix}\n`)
}

/** Print a machine-readable event on stdout, for a driver script. */
function event(kind, details = {}) {
  process.stdout.write(`${JSON.stringify({ event: kind, ...details })}\n`)
}

/** The capability surface this fake advertises. */
const CAPABILITIES = {
  remotes: [
    { endpoint: 'demo/echo', mode: 'unary' },
    { endpoint: 'demo/tick', mode: 'stream' },
    // The session Remotes, with the same modes and the same **per-endpoint argument
    // names** the real `dsh-api-session-controller` declares. `session/list` takes
    // `_request` while `session/page`, `session/create`, `session/prompt` and
    // `session/follow` take `request`; a fake that smoothed that over would hide
    // exactly the mismatch the Coordinator has to get right.
    { endpoint: 'session/list', mode: 'unary' },
    { endpoint: 'session/page', mode: 'unary' },
    { endpoint: 'session/create', mode: 'unary' },
    { endpoint: 'session/prompt', mode: 'unary' },
    { endpoint: 'session/follow', mode: 'stream' },
  ],
  remoteSurfaceHash: 'fake-node-surface-2',
  namespaces: ['demo', 'session'],
}

/**
 * In-memory sessions, so the UI has something to list, open and talk to.
 *
 * Each session keeps its own event log and the set of streams following it: a
 * prompt appends a record and pushes it to every follower, which is what makes the
 * follow stream live rather than a one-shot replay.
 */
const sessions = new Map()
let sessionSeq = 0
let eventSeq = 0

/** One `session/follow` record: the event plus the envelope the node wraps it in. */
function record(type, data, time) {
  eventSeq += 1
  return { type: 'event', event: { type, seq: eventSeq, time: time ?? Date.now(), data } }
}

/** Push one record to every stream following a session. */
function publish(session, entry) {
  session.records.push(entry)
  for (const streamId of session.followers) {
    const state = streams.get(streamId)
    if (state === undefined || state.cancelled) continue
    state.count += 1
    send({ type: 'stream.data', streamId, seq: state.count, value: entry })
  }
}

/** The `{sessionId}` a caller asked about, however it spelled the request. */
function requestedSessionId(args) {
  const request = args?.request ?? args?._request ?? {}
  return request.sessionId ?? request.address?.sessionId
}

const socket = new WebSocket(options.url)
let connectionId
/** Live streams, so a `stream.cancel` can stop one. */
const streams = new Map()
let pingTimer

/** Send one frame with the envelope filled in. */
function send(frame) {
  const full = { protocolVersion: PROTOCOL_VERSION, nodeId: options.nodeId, ...frame }
  if (options.log) log('frame/out', full)
  socket.send(JSON.stringify(full))
}

/** Fail one unary call. */
function fail(requestId, code, message) {
  send({
    type: 'rpc.result',
    requestId,
    result: { ok: false, error: { code, message, details: {} } },
  })
}

/** Answer one unary call. */
function handleRequest(frame) {
  const args = frame.payload?.args ?? {}
  const request = args.request ?? args._request ?? {}
  const answer = () => {
    if (frame.endpoint === options.fail) {
      fail(frame.requestId, 'session/not-found', `the fake node refuses "${frame.endpoint}"`)
      return
    }
    if (frame.endpoint === 'demo/echo') {
      send({
        type: 'rpc.result',
        requestId: frame.requestId,
        result: { ok: true, value: { echoed: args, at: Date.now() } },
      })
      return
    }
    if (frame.endpoint === 'session/create') {
      sessionSeq += 1
      const sessionId = request.sessionId ?? `fake-session-${sessionSeq}`
      const session = {
        id: sessionId,
        title: sessionId,
        cwd: request.cwd ?? process.cwd(),
        createdAt: Date.now(),
        records: [],
        followers: new Set(),
      }
      session.records.push(record('session-created', { title: session.title }))
      sessions.set(sessionId, session)
      event('session-created', { sessionId })
      send({ type: 'rpc.result', requestId: frame.requestId, result: { ok: true, value: { sessionId } } })
      return
    }
    if (frame.endpoint === 'session/prompt') {
      const session = sessions.get(request.sessionId)
      if (session === undefined) {
        fail(frame.requestId, 'session/not-found', `no session "${request.sessionId}" on this fake node`)
        return
      }
      const text = (request.content ?? [])
        .map(part => (part && part.type === 'text' ? part.text : `[${part?.type ?? '?'}]`))
        .join('')
      publish(session, record('user-message', { text }))
      // Answer first, then emit the reply: a follower should see the prompt accepted
      // before the assistant's turn shows up, exactly as a real node sequences it.
      send({ type: 'rpc.result', requestId: frame.requestId, result: { ok: true, value: { accepted: true } } })
      setTimeout(() => {
        publish(session, record('assistant-message', { text: `fake node received: ${text}` }))
      }, 150)
      return
    }
    if (frame.endpoint === 'session/list') {
      const items = [...sessions.values()].map(session => ({
        sessionId: session.id,
        title: session.title,
        cwd: session.cwd,
        running: false,
        updatedAt: session.records.at(-1)?.event.time ?? session.createdAt,
      }))
      send({ type: 'rpc.result', requestId: frame.requestId, result: { ok: true, value: { items, cursor: null } } })
      return
    }
    if (frame.endpoint === 'session/page') {
      const session = sessions.get(request.sessionId)
      if (session === undefined) {
        fail(frame.requestId, 'session/not-found', `no session "${request.sessionId}" on this fake node`)
        return
      }
      send({
        type: 'rpc.result',
        requestId: frame.requestId,
        result: { ok: true, value: { sessionId: session.id, records: session.records } },
      })
      return
    }
    fail(frame.requestId, 'node/capability-unavailable', `the fake node has no "${frame.endpoint}"`)
  }
  if (options.unaryDelay > 0) setTimeout(answer, options.unaryDelay)
  else answer()
}

/** Open one stream and start producing into it. */
function handleStreamOpen(frame) {
  const streamId = frame.streamId
  if (streams.has(streamId)) {
    send({ type: 'stream.error', streamId, count: 0, error: { code: 'node/protocol-invalid', message: 'duplicate stream id', details: {} } })
    return
  }

  if (frame.endpoint === 'session/follow') {
    const sessionId = requestedSessionId(frame.payload?.args)
    const session = sessions.get(sessionId)
    if (session === undefined) {
      send({
        type: 'stream.error',
        streamId,
        count: 0,
        error: { code: 'session/not-found', message: `no session "${sessionId}" on this fake node`, details: {} },
      })
      return
    }
    const state = { cancelled: false, count: 0, timer: undefined, sessionId }
    streams.set(streamId, state)
    session.followers.add(streamId)
    send({ type: 'stream.ready', streamId, ...(frame.requestId === undefined ? {} : { requestId: frame.requestId }) })
    // Snapshot first, then live events: a follower renders the transcript from the
    // snapshot and never has to make a second call for history.
    state.count += 1
    send({
      type: 'stream.data',
      streamId,
      seq: state.count,
      value: {
        type: 'snapshot',
        header: { version: 1, id: session.id, createdAt: session.createdAt, cwd: session.cwd, isSeeded: false },
        cursor: session.records.length,
        records: session.records,
        hasMore: false,
        projections: { asOfSeq: eventSeq, values: { title: session.title } },
      },
    })
    event('session-following', { streamId, sessionId })
    return
  }

  if (frame.endpoint !== 'demo/tick') {
    send({
      type: 'stream.error',
      streamId,
      count: 0,
      error: { code: 'node/capability-unavailable', message: `the fake node has no "${frame.endpoint}"`, details: {} },
    })
    return
  }
  const state = { cancelled: false, count: 0, timer: undefined }
  streams.set(streamId, state)
  send({ type: 'stream.ready', streamId, ...(frame.requestId === undefined ? {} : { requestId: frame.requestId }) })
  const produce = () => {
    if (state.cancelled) return
    if (state.count >= options.streamCount) {
      streams.delete(streamId)
      send({ type: 'stream.end', streamId, count: state.count })
      event('stream-end', { streamId, count: state.count })
      return
    }
    state.count += 1
    send({ type: 'stream.data', streamId, seq: state.count, value: { tick: state.count } })
    state.timer = setTimeout(produce, 25)
  }
  setTimeout(produce, 10)
}

socket.on('open', () => {
  log('socket-open', { url: options.url })
  event('socket-open')
  send({
    type: 'hello',
    nodeName: options.nodeName,
    role: 'fake',
    mode: 'full-access',
    auth: { type: 'bearer', token: options.token },
    dsh: { remoteSurfaceHash: CAPABILITIES.remoteSurfaceHash },
  })
})

socket.on('message', (data) => {
  let frame
  try {
    frame = JSON.parse(data.toString('utf8'))
  } catch {
    log('frame/unparsable')
    return
  }
  if (options.log) log('frame/in', frame)

  switch (frame.type) {
    case 'hello.ok':
      connectionId = frame.connectionId
      if (connectionId === undefined) {
        // The Coordinator must send one; without it the real node stops for good.
        log('protocol-error', { reason: 'hello.ok carried no connectionId' })
        process.exitCode = 3
        socket.close(1002, 'missing connectionId')
        return
      }
      event('hello-ok', { connectionId, heartbeatIntervalMs: frame.heartbeatIntervalMs })
      send({ type: 'ready', connectionId, capabilities: CAPABILITIES })
      event('ready-sent')
      if (options.exitAfterReady) {
        setTimeout(() => { socket.close(1000, 'smoke test done'); process.exit(0) }, 50)
      }
      return
    case 'ping':
      send({ type: 'pong', ...(frame.messageId === undefined ? {} : { messageId: frame.messageId }) })
      return
    case 'pong':
      return
    case 'rpc.request':
      event('rpc-request', { endpoint: frame.endpoint, args: frame.payload?.args ?? {} })
      handleRequest(frame)
      return
    case 'rpc.cancel':
      event('rpc-cancel', { requestId: frame.requestId })
      return
    case 'stream.open':
      event('stream-open', { streamId: frame.streamId, endpoint: frame.endpoint })
      handleStreamOpen(frame)
      return
    case 'stream.cancel': {
      const state = streams.get(frame.streamId)
      if (state !== undefined) {
        state.cancelled = true
        clearTimeout(state.timer)
        streams.delete(frame.streamId)
        // A follower that is gone must stop receiving pushes: this is the node-side
        // half of the guarantee that `stream.cancel` actually frees the producer.
        if (state.sessionId !== undefined) sessions.get(state.sessionId)?.followers.delete(frame.streamId)
      }
      event('stream-cancel', { streamId: frame.streamId, hadStream: state !== undefined })
      return
    }
    case 'close':
      log('coordinator-close', { code: frame.code, reason: frame.reason, reconnect: frame.reconnect })
      event('close-frame', { code: frame.code ?? null, reconnect: frame.reconnect ?? null })
      clearInterval(pingTimer)
      socket.close(1000, 'coordinator asked')
      return
    default:
      log('frame/ignored', { type: frame.type })
  }
})

socket.on('close', (code, reason) => {
  clearInterval(pingTimer)
  log('socket-closed', { code, reason: reason.toString('utf8') })
  event('socket-closed', { code })
})

socket.on('error', (error) => {
  log('socket-error', { message: error.message })
  event('socket-error', { message: redact(error.message) })
})

pingTimer = setInterval(() => {
  if (socket.readyState === WebSocket.OPEN) send({ type: 'ping' })
}, options.heartbeatMs)
pingTimer.unref?.()

process.on('SIGINT', () => {
  clearInterval(pingTimer)
  socket.close(1000, 'fake node exiting')
  process.exit(0)
})
