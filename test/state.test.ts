/**
 * Persisted state and the enrollment route.
 *
 * The thing under test is a **credential that survives a restart**, so the tests
 * come in pairs: one that it survives, and one that it never leaks. The second is
 * the harder property to keep, because every convenient way to answer "what is the
 * current secret?" is also a way to hand it to whoever reached the port.
 *
 * @module dsh-coordinator/test/state
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Coordinator } from '../src/server.js'
import { NodeRegistry } from '../src/node-registry.js'
import { silentLogger } from '../src/log.js'
import {
  DEFAULT_STATE_FILE_NAME,
  describeState,
  readStateFile,
  resolveStateFile,
  writeStateFile,
} from '../src/state-file.js'

const SECRET = 'a-perfectly-ordinary-test-secret'
const TOKEN = 'node-token-0123456789'

const directories: string[] = []

/** A fresh scratch directory, removed after the test. */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-coordinator-state-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0, directories.length)) {
    await rm(directory, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------- path & file

describe('the state file path', () => {
  it('defaults to a named file in the working directory', () => {
    expect(resolveStateFile(undefined, 'C:\\work')).toBe(join('C:\\work', DEFAULT_STATE_FILE_NAME))
  })

  it('appends the default name when given a directory', () => {
    // `--state-file .` is what an operator types when they mean "right here", and
    // writing a *file* called "." would fail with a confusing errno.
    expect(resolveStateFile('.', 'C:\\work')).toBe(join('C:\\work', DEFAULT_STATE_FILE_NAME))
    expect(resolveStateFile('state', 'C:\\work')).toBe(join('C:\\work', 'state', DEFAULT_STATE_FILE_NAME))
  })

  it('uses a path that already looks like a file', () => {
    expect(resolveStateFile('my-state.json', 'C:\\work')).toBe(join('C:\\work', 'my-state.json'))
  })
})

describe('reading and writing the state file', () => {
  it('treats a missing file as a first run, not an error', async () => {
    const file = join(await scratch(), 'absent.json')
    const read = await readStateFile(file)
    expect(read.state).toBeUndefined()
    expect(read.error).toBeUndefined()
  })

  it('round-trips the enrollment rule and the records', async () => {
    const file = join(await scratch(), 'state.json')
    await writeStateFile(file, {
      apiToken: 'operator-secret',
      enrollment: { kind: 'shared-secret', token: SECRET },
      nodes: [{ nodeId: 'node-a', token: TOKEN, nodeName: 'desk', role: 'test' }],
    })

    const read = await readStateFile(file)
    expect(read.error).toBeUndefined()
    expect(read.state?.apiToken).toBe('operator-secret')
    expect(read.state?.enrollment).toEqual({ kind: 'shared-secret', token: SECRET })
    expect(read.state?.nodes).toEqual([{ nodeId: 'node-a', token: TOKEN, nodeName: 'desk', role: 'test' }])
  })

  it('writes with owner-only permissions where the platform honours them', async () => {
    const file = join(await scratch(), 'state.json')
    await writeStateFile(file, { nodes: [] })
    if (process.platform === 'win32') return
    const mode = (await stat(file)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('never tears the file when saves overlap', async () => {
    // The bug this exists for: two saves sharing one temp path interleave, and the
    // second rename publishes a document that is one write's head and another's
    // tail. It really happened, and the loader correctly refused the result — which
    // silently dropped the enrollment secret on the next boot.
    const file = join(await scratch(), 'state.json')
    const writes: Promise<void>[] = []
    for (let index = 0; index < 25; index += 1) {
      writes.push(writeStateFile(file, {
        enrollment: { kind: 'shared-secret', token: `secret-${index}`.padEnd(20, 'x') },
        nodes: Array.from({ length: index }, (_, n) => ({ nodeId: `node-${n}`, token: `token-${n}` })),
      }))
    }
    await Promise.all(writes)

    const read = await readStateFile(file)
    expect(read.error).toBeUndefined()
    // Any one of the 25 is a legitimate winner; a torn document is not.
    expect(read.state).toBeDefined()
    expect(typeof (read.state?.enrollment as { token?: string } | undefined)?.token).toBe('string')
  })

  it('leaves no temp files behind', async () => {
    const directory = await scratch()
    const file = join(directory, 'state.json')
    await Promise.all([
      writeStateFile(file, { nodes: [] }),
      writeStateFile(file, { nodes: [{ nodeId: 'a', token: 't' }] }),
    ])
    const leftovers = (await readdir(directory)).filter(name => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('reports a broken file instead of throwing, so the service still starts', async () => {
    const file = join(await scratch(), 'state.json')
    await writeFile(file, '{ not json', 'utf8')
    const read = await readStateFile(file)
    expect(read.state).toBeUndefined()
    expect(read.error).toContain('not valid JSON')
  })

  it('refuses a document from a future version rather than guessing at it', async () => {
    const file = join(await scratch(), 'state.json')
    await writeFile(file, JSON.stringify({ version: 99, nodes: [] }), 'utf8')
    expect((await readStateFile(file)).error).toContain('version 99')
  })

  it('drops records that are missing a credential instead of admitting a blank one', async () => {
    const file = join(await scratch(), 'state.json')
    await writeFile(file, JSON.stringify({
      version: 1,
      nodes: [{ nodeId: 'good', token: TOKEN }, { nodeId: 'no-token' }, { token: 'no-id' }, 'nonsense'],
    }), 'utf8')
    const read = await readStateFile(file)
    expect(read.state?.nodes).toEqual([{ nodeId: 'good', token: TOKEN }])
  })

  it('never puts the secret in the diagnostic shape', () => {
    const described = JSON.stringify(describeState({
      apiToken: 'operator-secret',
      enrollment: { kind: 'shared-secret', token: SECRET },
      nodes: [{ nodeId: 'node-a', token: TOKEN }],
    }))
    expect(described).not.toContain('operator-secret')
    expect(described).not.toContain(SECRET)
    expect(described).not.toContain(TOKEN)
    expect(described).toContain('shared-secret')
  })
})

// ------------------------------------------------------------ the registry

describe('changing the enrollment rule at runtime', () => {
  it('reports openness without exposing the secret', () => {
    const registry = new NodeRegistry()
    expect(registry.enrollmentOpen).toBe(false)
    registry.setEnrollment({ kind: 'shared-secret', token: SECRET })
    expect(registry.enrollmentOpen).toBe(true)
    // There is no accessor that returns the secret; this asserts the shape stays
    // that way rather than that a particular getter is absent.
    expect(Object.keys(registry as unknown as Record<string, unknown>)).not.toContain('enrollmentSecret')
  })

  it('refuses an empty secret rather than silently opening enrollment to everyone', () => {
    const registry = new NodeRegistry()
    expect(() => registry.setEnrollment({ kind: 'shared-secret', token: '' })).toThrow(/must not be empty/u)
  })

  it('admits a node that presents the new secret, and refuses the old one', () => {
    const registry = new NodeRegistry({ enrollment: { kind: 'shared-secret', token: 'old-secret' } })
    registry.authenticate({ nodeId: 'node-a', token: 'old-secret' })
    registry.setEnrollment({ kind: 'shared-secret', token: SECRET })

    expect(registry.authenticate({ nodeId: 'node-a', token: 'old-secret' })).toBeDefined()
    // The old secret is no longer an enrollment credential...
    expect(() => registry.authenticate({ nodeId: 'node-b', token: 'old-secret' })).toThrow(/not approved/u)
    // ...but the node that already enrolled with it keeps working, which is the
    // documented rule: changing the secret is not a revocation.
    expect(registry.authenticate({ nodeId: 'node-a', token: 'old-secret' }).record.nodeId).toBe('node-a')
    expect(registry.authenticate({ nodeId: 'node-b', token: SECRET }).enrolled).toBe(true)
  })

  it('closes enrollment when told to', () => {
    const registry = new NodeRegistry({ enrollment: { kind: 'shared-secret', token: SECRET } })
    registry.setEnrollment({ kind: 'closed' })
    expect(registry.enrollmentOpen).toBe(false)
    expect(() => registry.authenticate({ nodeId: 'node-a', token: SECRET })).toThrow(/not approved/u)
  })
})

// ------------------------------------------------------------- end to end

/** Call the operator API and return the envelope. */
async function api(port: number, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, body: await response.json() }
}

describe('the enrollment route and persistence', () => {
  const coordinators: Coordinator[] = []

  afterEach(async () => {
    for (const coordinator of coordinators.splice(0, coordinators.length)) await coordinator.stop()
  })

  /** Start a Coordinator on a scratch state file. */
  async function start(options: { readonly file?: string } = {}): Promise<{ coordinator: Coordinator; file: string }> {
    const file = options.file ?? join(await scratch(), 'state.json')
    const coordinator = new Coordinator({
      port: 0,
      stateFile: file,
      heartbeatIntervalMs: 30_000,
      logger: silentLogger,
    })
    coordinators.push(coordinator)
    await coordinator.start()
    return { coordinator, file }
  }

  it('reports the fact and never the value', async () => {
    const { coordinator, file } = await start()
    const { coordinator: address } = { coordinator }

    const before = await api(coordinator.address!.port, '/api/enrollment')
    expect(before.body.value).toMatchObject({ open: false, persisted: true })
    expect(before.body.value.stateFile).toBe(file)
    expect(JSON.stringify(before.body)).not.toContain(SECRET)

    await api(coordinator.address!.port, '/api/enrollment', {
      method: 'POST',
      body: JSON.stringify({ token: SECRET }),
    })

    const after = await api(coordinator.address!.port, '/api/enrollment')
    expect(after.body.value.open).toBe(true)
    expect(JSON.stringify(after.body)).not.toContain(SECRET)
  })

  it('persists the secret and restores it in a new process-shaped instance', async () => {
    const directory = await scratch()
    const file = join(directory, 'state.json')

    const first = await start({ file })
    await api(first.coordinator.address!.port, '/api/enrollment', {
      method: 'POST',
      body: JSON.stringify({ token: SECRET }),
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    await first.coordinator.stop()
    coordinators.splice(coordinators.indexOf(first.coordinator), 1)

    // What a restart looks like: same file, brand-new everything else.
    const second = await start({ file })
    expect(second.coordinator.enrollmentOpen).toBe(true)
    // And it is the *same* secret, not merely "some secret is configured".
    expect(second.coordinator.registry.authenticate({ nodeId: 'node-z', token: SECRET }).enrolled).toBe(true)
  })

  it('persists the operator token and requires it after a restart', async () => {
    const directory = await scratch()
    const file = join(directory, 'state.json')
    const first = await start({ file })
    const token = 'operator-token-that-survives'

    const configured = await api(first.coordinator.address!.port, '/api/operator-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
    expect(configured.status).toBe(200)
    expect(configured.body.value).toEqual({ configured: true, persisted: true })
    await first.coordinator.flushState()
    await first.coordinator.stop()
    coordinators.splice(coordinators.indexOf(first.coordinator), 1)

    const second = await start({ file })
    const missing = await api(second.coordinator.address!.port, '/api/nodes')
    expect(missing.status).toBe(401)
    const authorized = await api(second.coordinator.address!.port, '/api/nodes', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(authorized.status).toBe(200)
    expect(JSON.stringify(authorized.body)).not.toContain(token)
  })

  it('lets a command-line secret override the stored one, and rewrites the file', async () => {
    const directory = await scratch()
    const file = join(directory, 'state.json')
    await writeStateFile(file, { enrollment: { kind: 'shared-secret', token: 'stored-secret' }, nodes: [] })

    const coordinator = new Coordinator({
      port: 0,
      stateFile: file,
      enrollment: { kind: 'shared-secret', token: 'from-the-command-line' },
      enrollmentFromCli: true,
      logger: silentLogger,
    })
    coordinators.push(coordinator)
    await coordinator.start()

    expect(coordinator.registry.authenticate({ nodeId: 'n', token: 'from-the-command-line' }).enrolled).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 50))
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    expect(onDisk.enrollment.token).toBe('from-the-command-line')
  })

  it('keeps a stored node record across a restart', async () => {
    const directory = await scratch()
    const file = join(directory, 'state.json')

    const first = await start({ file })
    first.coordinator.addNode({ nodeId: 'node-keep', token: TOKEN, nodeName: 'kept' })
    await new Promise(resolve => setTimeout(resolve, 50))
    await first.coordinator.stop()
    coordinators.splice(coordinators.indexOf(first.coordinator), 1)

    const second = await start({ file })
    expect(second.coordinator.registry.record('node-keep')?.nodeName).toBe('kept')
  })

  it('does not persist when no state file is configured', async () => {
    const coordinator = new Coordinator({ port: 0, logger: silentLogger })
    coordinators.push(coordinator)
    await coordinator.start()
    expect(coordinator.stateFile).toBeUndefined()

    const { body } = await api(coordinator.address!.port, '/api/enrollment', {
      method: 'POST',
      body: JSON.stringify({ token: SECRET }),
    })
    expect(body.value).toMatchObject({ open: true, persisted: false })
  })

  it('rejects an empty secret and a wrong-typed one without changing anything', async () => {
    const { coordinator } = await start()
    const port = coordinator.address!.port

    for (const token of ['', '   ', 42, {}]) {
      const { status, body } = await api(port, '/api/enrollment', {
        method: 'POST',
        body: JSON.stringify({ token }),
      })
      expect(status, JSON.stringify(token)).toBe(400)
      expect(body.error.code).toBe('coordinator/invalid-arguments')
    }
    expect(coordinator.enrollmentOpen).toBe(false)
  })

  it('closes enrollment when sent null', async () => {
    const { coordinator } = await start()
    const port = coordinator.address!.port
    await api(port, '/api/enrollment', { method: 'POST', body: JSON.stringify({ token: SECRET }) })
    expect(coordinator.enrollmentOpen).toBe(true)

    const { body } = await api(port, '/api/enrollment', { method: 'POST', body: JSON.stringify({ token: null }) })
    expect(body.value.open).toBe(false)
    expect(coordinator.enrollmentOpen).toBe(false)
  })
})
