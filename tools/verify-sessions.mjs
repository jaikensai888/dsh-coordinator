#!/usr/bin/env node
/**
 * End-to-end driver for the session surface: create, prompt, follow.
 *
 * This is the same path the bundled UI takes, exercised without a browser, so a
 * failure can be attributed: if this passes and the page misbehaves, the bug is in
 * the page; if this fails, the page was never going to work.
 *
 * It only talks to `/api`, so it runs against the fake node or a real DSH node
 * alike. Against a real node a prompt **really runs a turn** — point it at a
 * disposable profile.
 *
 * Usage:
 *   node tools/verify-sessions.mjs --api http://127.0.0.1:39491
 *
 * Flags:
 *   --api <url>          Coordinator base URL (default http://127.0.0.1:39472)
 *   --api-token <token>  bearer token for the operator API
 *   --node <nodeId>      node to use (default: the first ready one)
 *   --cwd <path>         working directory for the created session
 *   --text <message>     prompt to send (default: a marker string)
 *   --timeout <ms>       how long to wait for events (default 15000)
 *   --keep               do not cancel the follow stream before exiting
 *   --json               print raw API answers
 *
 * @module dsh-coordinator/tools/verify-sessions
 */

const options = parseArgs(process.argv.slice(2))
const base = options.api.replace(/\/+$/u, '')
const checks = []

/** Record one check and print it. */
function check(ok, label, detail) {
  checks.push(ok)
  const mark = ok ? 'PASS' : 'FAIL'
  process.stdout.write(`${mark} ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

/** Call the operator API and return the parsed body plus the status. */
async function api(path, body) {
  const headers = { 'content-type': 'application/json' }
  if (options.apiToken !== undefined) headers.authorization = `Bearer ${options.apiToken}`
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (options.json) process.stdout.write(`  ${path} -> ${response.status} ${text.slice(0, 400)}\n`)
  return { status: response.status, body: parsed, text }
}

/** Wait for a ready node, and return the one to use. */
async function pickNode() {
  const deadline = Date.now() + 10_000
  for (;;) {
    const { body } = await api('/api/nodes')
    const nodes = Array.isArray(body?.value) ? body.value : []
    const ready = nodes.filter(node => node.state === 'ready')
    const chosen = options.node === undefined
      ? ready[0]
      : ready.find(node => node.nodeId === options.node)
    if (chosen !== undefined) return chosen
    if (Date.now() > deadline) {
      const detail = options.node === undefined
        ? 'no node reached ready'
        : `node "${options.node}" is not ready (ready: ${ready.map(n => n.nodeId).join(', ') || 'none'})`
      throw new Error(detail)
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** Read NDJSON lines from a follow stream, calling `onFrame` for each. */
async function readFrames(response, onFrame, signal) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') onFrame(JSON.parse(line))
      }
    }
  } catch (error) {
    if (signal?.aborted !== true) throw error
  }
}

/** Parse argv. */
function parseArgs(argv) {
  const parsed = {
    api: 'http://127.0.0.1:39472',
    apiToken: undefined,
    node: undefined,
    cwd: undefined,
    text: `verify-sessions ${new Date().toISOString()}`,
    timeout: 15_000,
    keep: false,
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
      case '--api': parsed.api = value(); break
      case '--api-token': parsed.apiToken = value(); break
      case '--node': parsed.node = value(); break
      case '--cwd': parsed.cwd = value(); break
      case '--text': parsed.text = value(); break
      case '--timeout': parsed.timeout = Number(value()); break
      case '--keep': parsed.keep = true; break
      case '--json': parsed.json = true; break
      case '--help':
        process.stdout.write('see the module doc comment in tools/verify-sessions.mjs\n')
        process.exit(0)
        break
      default:
        throw new Error(`unknown flag "${flag}"`)
    }
  }
  return parsed
}

/** Run every check. */
async function main() {
  // 1. The page itself, so a UI regression is caught here rather than in a browser.
  const page = await fetch(`${base}/ui`)
  const html = page.status === 200 ? await page.text() : ''
  check(page.status === 200, 'the UI page is served at /ui', `HTTP ${page.status}`)
  check(html.includes('/api/session/follow'), 'the page references the follow route')

  // 2. A node to drive.
  const node = await pickNode()
  check(true, 'a ready node was found', `${node.nodeId} (${node.capabilityCount} capabilities)`)

  const capabilities = await api(`/api/capabilities?nodeId=${encodeURIComponent(node.nodeId)}`)
  const remotes = capabilities.body?.value?.remotes ?? []
  const modes = new Map(remotes.map(remote => [remote.endpoint, remote.mode]))
  check(modes.get('session/create') === 'unary', 'the node advertises session/create as unary')
  check(modes.get('session/prompt') === 'unary', 'the node advertises session/prompt as unary')
  check(modes.get('session/follow') === 'stream', 'the node advertises session/follow as a stream')

  // 3. Create.
  const created = await api('/api/session/create', {
    nodeId: node.nodeId,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  })
  const sessionId = created.body?.value?.sessionId
  check(created.status === 200 && typeof sessionId === 'string', 'POST /api/session/create returned a sessionId', sessionId)
  if (typeof sessionId !== 'string') return

  // 4. It shows up in the list the UI renders.
  const listed = await api('/api/sessions', { nodeId: node.nodeId })
  const items = Array.isArray(listed.body?.value?.items) ? listed.body.value.items : []
  check(
    items.some(item => item.sessionId === sessionId),
    'POST /api/sessions lists the new session',
    `${items.length} session(s)`,
  )

  // 5. Follow, then prompt — in that order, so the reply cannot arrive before there
  //    is a stream listening for it.
  const controller = new AbortController()
  const headers = { 'content-type': 'application/json' }
  if (options.apiToken !== undefined) headers.authorization = `Bearer ${options.apiToken}`
  const streamResponse = await fetch(`${base}/api/session/follow`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ nodeId: node.nodeId, sessionId, assistantStream: true }),
    signal: controller.signal,
  })
  check(streamResponse.status === 200, 'POST /api/session/follow opened a stream', `HTTP ${streamResponse.status}`)
  check(
    (streamResponse.headers.get('content-type') ?? '').includes('ndjson'),
    'the follow response is NDJSON',
    streamResponse.headers.get('content-type') ?? '',
  )

  const seen = { open: false, snapshot: 0, user: 0, assistant: 0, error: undefined, end: false }
  const done = new Promise(resolve => {
    const timer = setTimeout(resolve, options.timeout)
    void readFrames(streamResponse, envelope => {
      if (envelope.type === 'open') seen.open = true
      else if (envelope.type === 'data') {
        const frame = envelope.value ?? {}
        if (frame.type === 'snapshot') seen.snapshot += 1
        else if (frame.type === 'event') {
          if (frame.event?.type === 'user-message') seen.user += 1
          if (frame.event?.type === 'assistant-message') seen.assistant += 1
        }
      } else if (envelope.type === 'error') seen.error = envelope.error
      else if (envelope.type === 'end') seen.end = true
      if (seen.user > 0 && seen.assistant > 0) {
        clearTimeout(timer)
        resolve()
      }
    }, controller.signal).finally(() => { clearTimeout(timer); resolve() })
  })

  // Give the snapshot a moment to land before prompting: a prompt sent first would
  // legitimately race its own echo.
  await new Promise(resolve => setTimeout(resolve, 300))

  const prompted = await api('/api/session/prompt', { nodeId: node.nodeId, sessionId, text: options.text })
  check(prompted.body?.ok === true, 'POST /api/session/prompt was accepted', prompted.body?.value?.accepted)

  await done

  check(seen.open, 'the stream announced itself with an open frame')
  check(seen.snapshot === 1, 'the stream carried exactly one snapshot', `count=${seen.snapshot}`)
  check(seen.user === 1, 'the prompt came back as a user-message event', `count=${seen.user}`)
  check(seen.assistant === 1, 'the node produced an assistant-message event', `count=${seen.assistant}`)
  check(seen.error === undefined, 'the stream reported no error', seen.error === undefined ? undefined : JSON.stringify(seen.error))

  if (!options.keep) controller.abort()

  // 6. Nothing leaked.
  const stats = await api('/api/stats')
  const active = stats.body?.value?.activeStreams
  check(active === 0, 'no follow stream leaked', `activeStreams=${active}`)
}

try {
  await main()
} catch (error) {
  check(false, 'the run completed without throwing', error.message)
}

const failed = checks.filter(ok => !ok).length
process.stdout.write(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`} (${checks.length} total)\n`)
process.exitCode = failed === 0 ? 0 : 1
