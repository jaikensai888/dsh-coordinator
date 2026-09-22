#!/usr/bin/env node
/**
 * Verify the remaining Phase 3 management paths live, through a running Coordinator.
 *
 * Read-only except for one write inside a policy-allowed root, which is created and
 * then removed again, so the check leaves nothing behind:
 *
 *   - `nodeAdmin/skillsList`  — the skill roots and their layer labels
 *   - `nodeAdmin/status`      — the node's own diagnostic snapshot
 *   - `nodeAdmin/fsWrite`     — a real write, inside `allowedRoots`
 *   - `nodeAdmin/fsRead`      — read it back and compare
 *   - `nodeAdmin/fsRemove`    — delete it again
 *   - `nodeAdmin/skillRemove` — a bogus name, which must be *refused* with a code
 *
 * @module dsh-coordinator/tools/verify-admin
 */

const API = process.env.DSH_VERIFY_API ?? 'http://127.0.0.1:39471'
const FILE = String.raw`G:\claude_project\code-agent\dsh-node\.tmp\coordinator-write-probe.txt`
const CONTENT = `written through the coordinator at ${new Date().toISOString()}\n`

let failures = 0

/** Print one check result. */
function check(ok, label, detail) {
  if (!ok) failures += 1
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}${suffix}\n`)
}

/** One coordinator API request. */
async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return await response.json()
}

/** Call one Remote through the coordinator. */
async function invoke(nodeId, endpoint, args = {}) {
  return await api('/api/invoke', { method: 'POST', body: JSON.stringify({ nodeId, endpoint, args, timeoutMs: 20_000 }) })
}

const nodes = await api('/api/nodes')
const node = (nodes.value ?? []).find(entry => entry.state === 'ready')
if (node === undefined) {
  check(false, 'a ready node appeared', JSON.stringify(nodes))
  process.exit(1)
}
check(true, 'a ready node appeared', `${node.nodeId} (capabilities=${node.capabilityCount})`)

// ---------------------------------------------------------------- skills (read)
const skills = await invoke(node.nodeId, 'nodeAdmin/skillsList')
check(skills.ok === true, 'nodeAdmin/skillsList succeeded', skills.ok === true ? summarise(skills.value) : skills.error)
if (skills.ok === true) {
  const layers = skills.value?.layers
  const names = (skills.value?.skills ?? []).map(entry => entry.name ?? entry.id ?? '?')
  check(typeof layers === 'number' && layers > 0, 'skill roots are reported as layers', `layers=${layers}`)
  // The node reports layer labels, never host paths: that is the documented contract.
  check(
    JSON.stringify(skills.value).includes('\\\\') === false,
    'the skill listing exposes layer labels, not host paths',
    JSON.stringify(skills.value).slice(0, 80),
  )
  check(Array.isArray(names), 'skills are listed', `${names.length}: ${names.slice(0, 6).join(', ')}`)
}

// ---------------------------------------------------------------- status
const status = await invoke(node.nodeId, 'nodeAdmin/status')
check(status.ok === true, 'nodeAdmin/status succeeded', status.ok === true ? summarise(status.value) : status.error)
if (status.ok === true) {
  check(status.value?.state === 'ready', 'the node reports itself ready', status.value?.state)
  check(typeof status.value?.nodeId === 'string', 'the status carries the node identity', status.value?.nodeId)
}

// ---------------------------------------------------------------- write path
const write = await invoke(node.nodeId, 'nodeAdmin/fsWrite', { path: FILE, content: CONTENT })
check(write.ok === true, 'nodeAdmin/fsWrite landed inside an allowed root', write.ok === true ? summarise(write.value) : write.error)

const read = await invoke(node.nodeId, 'nodeAdmin/fsRead', { path: FILE })
check(read.ok === true, 'nodeAdmin/fsRead read it back', read.ok === true ? summarise(read.value) : read.error)
if (read.ok === true) {
  const text = read.value?.content ?? read.value?.text ?? ''
  check(text === CONTENT, 'the content round-tripped unchanged', `${text.length} bytes`)
}

const remove = await invoke(node.nodeId, 'nodeAdmin/fsRemove', { path: FILE })
check(remove.ok === true, 'nodeAdmin/fsRemove deleted it again', remove.ok === true ? summarise(remove.value) : remove.error)

// ---------------------------------------------------------------- refused paths
const denied = await invoke(node.nodeId, 'nodeAdmin/fsWrite', {
  path: String.raw`C:\Windows\Temp\coordinator-should-not-exist.txt`,
  content: 'nope\n',
})
check(
  denied.ok === false && typeof denied.error?.code === 'string',
  'a write outside every allowed root was refused with a code',
  denied.error,
)

const bogus = await invoke(node.nodeId, 'nodeAdmin/skillRemove', { name: 'definitely-not-an-installed-skill-xyz' })
check(
  bogus.ok === false && typeof bogus.error?.code === 'string',
  'removing a skill that does not exist was refused with a documented code',
  bogus.error,
)
check(
  bogus.ok === false && bogus.error?.code === 'nodeAdmin/not-found',
  'the refusal uses nodeAdmin/not-found, not a raw gateway/internal',
  bogus.ok === false ? bogus.error?.code : undefined,
)
check(
  bogus.ok === false && /[A-Za-z]:\\/.test(String(bogus.error?.message ?? '')) === false,
  'the refusal does not leak an absolute host path',
  bogus.ok === false ? bogus.error?.message : undefined,
)

// ---------------------------------------------------------------- still healthy
const after = await api('/api/nodes')
const still = (after.value ?? []).find(entry => entry.nodeId === node.nodeId)
check(still?.state === 'ready', 'the node is still ready after every call', still?.state)
check(
  still?.inFlightRequests === 0 && still?.activeStreams === 0,
  'nothing leaked',
  `inFlight=${still?.inFlightRequests} streams=${still?.activeStreams}`,
)

process.stdout.write(failures === 0 ? '\nall admin checks passed\n' : `\n${failures} check(s) failed\n`)
// `process.exitCode`, not `process.exit()`: an immediate exit while libuv is
// closing a fetch handle aborts the process on Windows, which would turn a clean
// report into a crash with no message.
process.exitCode = failures === 0 ? 0 : 1

/** A short, readable summary of a value. */
function summarise(value) {
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return `object{${keys.slice(0, 7).join(',')}${keys.length > 7 ? ',…' : ''}}`
  }
  const text = String(value)
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
