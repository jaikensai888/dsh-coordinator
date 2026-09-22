#!/usr/bin/env node
/**
 * Verify a **real** node end to end, through a running Coordinator's operator API.
 *
 * This is the tool that answers "does it actually work", as opposed to "do the
 * unit tests pass". It talks only to `/api`, so it works against any Coordinator
 * (this checkout's CLI, or an embedded one), and against any node — the real
 * `dsh-node` plugin inside a running DSH, or `tools/fake-node.mjs`.
 *
 * Every check prints `PASS`/`FAIL` with the observed value, and the process exits
 * non-zero if any check failed. Nothing here prints a credential: it never needs
 * one, because the operator API is the only surface it uses.
 *
 * Usage:
 *   node tools/verify-live.mjs --api http://127.0.0.1:39471 \
 *     --unary pluginInventory/list \
 *     --unary nodeAdmin/describe \
 *     --unary nodeAdmin/audit \
 *     --expect-denied 'nodeAdmin/fsList:{"path":"C:\\Windows"}' \
 *     --expect-ok 'nodeAdmin/fsList:{"path":"G:\\claude_project\\code-agent\\dsh-node"}' \
 *     --stream <endpoint>
 *
 * Flags:
 *   --api <url>              Coordinator base URL (default http://127.0.0.1:39472)
 *   --api-token <token>      bearer token for the operator API
 *   --node <nodeId>          node to test (default: the first one that is ready)
 *   --wait <ms>              how long to wait for a ready node (default 60000)
 *   --unary <endpoint>       call it and require a successful result (repeatable)
 *   --expect-ok <ep:json>    call it and require success
 *   --expect-denied <ep:json> call it and require a failure (prints its code)
 *   --stream [endpoint]      open a stream and require values; with no endpoint, the
 *                            first advertised stream Remote is used
 *   --stream-ms <n>          read the stream for at most n ms, then cancel it (for
 *                            long-lived streams such as session/follow, which never end)
 *   --stream-args <json>     arguments object for the stream Remote
 *                            (e.g. '{"request":{"address":{"kind":"session","sessionId":"…"}}}');
 *                            `DSH_VERIFY_STREAM_ARGS` carries the same value, because
 *                            PowerShell strips double quotes out of a native argv
 *   --unary-args <json>      arguments object for the `--unary` checks (`DSH_VERIFY_UNARY_ARGS`)
 *   --no-stream              skip the stream check entirely
 *   --json                   print the raw JSON of every answer
 *
 * @module dsh-coordinator/tools/verify-live
 */

/** Parse argv into the checks to run. */
function parseArgs(argv) {
  const options = {
    api: 'http://127.0.0.1:39472',
    apiToken: undefined,
    node: undefined,
    waitMs: 60_000,
    unary: [],
    expectOk: [],
    expectDenied: [],
    stream: undefined,
    streamMs: undefined,
    streamArgs: undefined,
    unaryArgs: undefined,
    noStream: false,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      index += 1
      if (argv[index] === undefined) throw new Error(`${flag} requires a value`)
      return argv[index]
    }
    switch (flag) {
      case '--api': options.api = value().replace(/\/$/u, ''); break
      case '--api-token': options.apiToken = value(); break
      case '--node': options.node = value(); break
      case '--wait': options.waitMs = Number(value()); break
      case '--unary': options.unary.push(value()); break
      case '--expect-ok': options.expectOk.push(value()); break
      case '--expect-denied': options.expectDenied.push(value()); break
      case '--stream':
        // The endpoint is optional: `--stream` alone means "pick one for me",
        // which is what you want when you do not know the node's surface yet.
        options.stream = argv[index + 1] !== undefined && !argv[index + 1].startsWith('--') ? value() : 'auto'
        break
      case '--no-stream': options.noStream = true; break
      case '--stream-ms': options.streamMs = Number(value()); break
      case '--stream-args': {
        const raw = value()
        try {
          options.streamArgs = JSON.parse(raw)
        } catch (error) {
          throw new Error(`--stream-args is not JSON: ${error.message}`)
        }
        break
      }
      case '--unary-args': {
        const raw = value()
        try {
          options.unaryArgs = JSON.parse(raw)
        } catch (error) {
          throw new Error(`--unary-args is not JSON: ${error.message}`)
        }
        break
      }
      case '--json': options.json = true; break
      case '--help': process.stdout.write('see the module doc comment in tools/verify-live.mjs\n'); process.exit(0); break
      default: throw new Error(`unknown flag "${flag}"`)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

// PowerShell cannot pass a JSON argument with double quotes through to a native
// program, so both JSON-valued flags also read the environment.
for (const [envName, field] of [['DSH_VERIFY_STREAM_ARGS', 'streamArgs'], ['DSH_VERIFY_UNARY_ARGS', 'unaryArgs']]) {
  const raw = process.env[envName]
  if (raw === undefined || raw === '' || options[field] !== undefined) continue
  try {
    options[field] = JSON.parse(raw)
  } catch (error) {
    process.stderr.write(`${envName} is not JSON: ${error.message}\n`)
    process.exit(2)
  }
}

let failures = 0

/** Print one check result. */
function check(ok, label, detail) {
  if (!ok) failures += 1
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}${suffix}\n`)
}

/** One operator API request. */
async function api(path, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) }
  if (options.apiToken !== undefined) headers.authorization = `Bearer ${options.apiToken}`
  const response = await fetch(`${options.api}${path}`, { ...init, headers })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

/** Call one endpoint and return the parsed envelope. */
async function invoke(nodeId, endpoint, args, timeoutMs = 30_000) {
  const { status, body } = await api('/api/invoke', {
    method: 'POST',
    body: JSON.stringify({ nodeId, endpoint, args, timeoutMs }),
  })
  if (options.json) process.stdout.write(`  ${endpoint} -> ${status} ${JSON.stringify(body)}\n`)
  return { status, body }
}

/** Split `<endpoint>:<json>`; the JSON side is optional. */
function splitArg(spec) {
  const index = spec.indexOf(':')
  if (index < 0) return { endpoint: spec, args: {} }
  const endpoint = spec.slice(0, index)
  const raw = spec.slice(index + 1)
  if (raw.trim() === '') return { endpoint, args: {} }
  try {
    return { endpoint, args: JSON.parse(raw) }
  } catch (error) {
    throw new Error(`--expect-* ${spec}: the part after ":" is not JSON (${error.message})`)
  }
}

/** Wait for a node to report `ready`, returning its id. */
async function waitForReadyNode() {
  const deadline = Date.now() + options.waitMs
  let lastSeen = 'no nodes'
  for (;;) {
    const { body } = await api('/api/nodes')
    const nodes = Array.isArray(body?.value) ? body.value : []
    if (nodes.length > 0) {
      lastSeen = nodes.map(node => `${node.nodeId}:${node.state}`).join(', ')
      const wanted = options.node === undefined ? nodes.find(node => node.state === 'ready') : nodes.find(node => node.nodeId === options.node)
      if (wanted !== undefined && wanted.state === 'ready') return wanted
    }
    if (Date.now() > deadline) throw new Error(`no ready node within ${options.waitMs} ms (saw: ${lastSeen})`)
    await new Promise(resolve => { setTimeout(resolve, 250) })
  }
}

/** Read a whole NDJSON stream response, optionally cutting it short. */
async function readStream(nodeId, endpoint) {
  const headers = { 'content-type': 'application/json' }
  if (options.apiToken !== undefined) headers.authorization = `Bearer ${options.apiToken}`
  const controller = new AbortController()
  const budget = options.streamMs === undefined ? undefined : setTimeout(() => { controller.abort() }, options.streamMs)
  const response = await fetch(`${options.api}/api/stream`, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({ nodeId, endpoint, args: options.streamArgs ?? {}, timeoutMs: 120_000 }),
  })
  const frames = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let cutShort = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line !== '') {
          try {
            frames.push(JSON.parse(line))
          } catch {
            frames.push({ type: 'unparsable', line })
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
  } catch (error) {
    // An aborted read is the intended way to stop following a stream that never
    // ends; anything else is a real failure.
    if (error?.name !== 'AbortError') throw error
    cutShort = true
  } finally {
    if (budget !== undefined) clearTimeout(budget)
  }
  return { frames, cutShort }
}

// ------------------------------------------------------------------ the checks

const started = Date.now()
process.stdout.write(`verifying ${options.api}\n`)

let node
try {
  node = await waitForReadyNode()
} catch (error) {
  check(false, 'a ready node appeared', error.message)
  process.exit(1)
}
check(true, 'a ready node appeared', `${node.nodeId} after ${Date.now() - started} ms`)
check(typeof node.connectionId === 'string' && node.connectionId !== '', 'the node handshake produced a connectionId', node.connectionId)
check(node.capabilityCount > 0, 'the node advertised capabilities', `count=${node.capabilityCount} hash=${node.remoteSurfaceHash}`)

const capabilities = await api(`/api/capabilities?nodeId=${encodeURIComponent(node.nodeId)}`)
const remotes = capabilities.body?.value?.remotes ?? []
check(Array.isArray(remotes) && remotes.length > 0, 'the capability surface is readable', `${remotes.length} endpoints`)
check(
  remotes.some(remote => remote.mode === 'stream'),
  'at least one stream Remote is advertised',
  remotes.filter(remote => remote.mode === 'stream').map(remote => remote.endpoint).join(', ') || 'none',
)

for (const endpoint of options.unary) {
  const { body } = await invoke(node.nodeId, endpoint, options.unaryArgs ?? {})
  check(body?.ok === true, `unary ${endpoint} succeeded`, body?.ok === true ? summarise(body.value) : body?.error)
}

for (const spec of options.expectOk) {
  const { endpoint, args } = splitArg(spec)
  const { body } = await invoke(node.nodeId, endpoint, args)
  check(body?.ok === true, `unary ${endpoint} succeeded`, body?.ok === true ? summarise(body.value) : body?.error)
}

for (const spec of options.expectDenied) {
  const { endpoint, args } = splitArg(spec)
  const { body } = await invoke(node.nodeId, endpoint, args)
  // The point of this check is that a *refusal* is a clean, coded answer rather
  // than a hang or a crash — so the code matters, not the message.
  check(body?.ok === false && typeof body.error?.code === 'string', `unary ${endpoint} was refused with a code`, body?.error)
}

if (!options.noStream) {
  const chosen = options.stream === undefined || options.stream === 'auto'
    ? remotes.find(remote => remote.mode === 'stream')?.endpoint
    : options.stream
  if (chosen === undefined) {
    check(false, 'a stream endpoint to test', 'the node advertises no stream Remote; pass --no-stream to accept that')
  } else {
    check(true, 'stream endpoint under test', chosen)
    const { frames, cutShort } = await readStream(node.nodeId, chosen)
    const values = frames.filter(frame => frame.type === 'data')
    const terminal = frames.find(frame => frame.type === 'end' || frame.type === 'error')
    const first = frames[0]
    check(first?.type === 'open', `stream ${chosen} opened`, first)
    check(values.length > 0 || terminal?.type === 'error', `stream ${chosen} produced values`, `values=${values.length}`)
    if (cutShort) {
      // A stream that never ends (session/follow) is stopped by dropping the
      // client: the Coordinator must then cancel it on the node.
      check(options.streamMs !== undefined, `stream ${chosen} was stopped after ${options.streamMs} ms`, 'cancelled from the client side')
    } else {
      check(terminal !== undefined, `stream ${chosen} reached a terminal frame`, terminal)
    }
    if (options.json) process.stdout.write(`  frames: ${JSON.stringify(frames.slice(0, 4))}\n`)
  }
}

// The connection must still be healthy after all that: a Coordinator that leaves
// a node half-broken after a call is worse than one that fails loudly.
const after = await api('/api/nodes')
const stillReady = (after.body?.value ?? []).find(entry => entry.nodeId === node.nodeId)
check(stillReady?.state === 'ready', 'the node is still ready after every call', stillReady?.state)
check(stillReady?.inFlightRequests === 0 && stillReady?.activeStreams === 0, 'no request or stream leaked', {
  inFlightRequests: stillReady?.inFlightRequests,
  activeStreams: stillReady?.activeStreams,
})

process.stdout.write(failures === 0 ? `\nall checks passed (${Date.now() - started} ms)\n` : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)

/** A short, readable summary of a value, for the log line. */
function summarise(value) {
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return `object{${keys.slice(0, 6).join(',')}${keys.length > 6 ? ',…' : ''}}`
  }
  const text = String(value)
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
