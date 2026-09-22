/**
 * `parseArgs` and `loadNodesFile`: the CLI's contract with an operator.
 *
 * Nothing here spawns the CLI. `parseArgs` is pure, and the one piece that
 * touches the filesystem (`loadNodesFile`) is called directly against a
 * temporary file, so a broken flag is reported as a parse failure rather than as
 * a mysteriously exited process.
 *
 * @module dsh-coordinator/test/cli
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadNodesFile, parseArgs } from '../src/cli.js'
import { DEFAULT_PATH, DEFAULT_PORT } from '../src/server.js'

const TMP_DIR = fileURLToPath(new URL('.tmp/', import.meta.url))
const ENV_TOKEN = 'DSH_COORDINATOR_TEST_TOKEN'
const ENV_EMPTY = 'DSH_COORDINATOR_TEST_EMPTY'

afterEach(async () => {
  delete process.env[ENV_TOKEN]
  delete process.env[ENV_EMPTY]
  await rm(TMP_DIR, { recursive: true, force: true })
})

/** Parse argv, insisting on the options form rather than a directive. */
function parseOptions(argv: readonly string[]) {
  const parsed = parseArgs(argv)
  if (!('options' in parsed)) throw new Error(`expected options, received ${JSON.stringify(parsed)}`)
  return parsed.options
}

/** Write a nodes file and return its path. */
async function writeNodesFile(name: string, contents: unknown): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true })
  const path = join(TMP_DIR, name)
  await writeFile(path, JSON.stringify(contents), 'utf8')
  return path
}

describe('parseArgs defaults', () => {
  it('defaults to a loopback listener with no nodes and the info level', () => {
    expect(parseOptions([])).toEqual({
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      path: DEFAULT_PATH,
      records: [],
      logLevel: 'info',
      traceFrames: false,
      enableApi: true,
      allowInsecureBind: false,
      noStateFile: false,
    })
  })
})

describe('node credentials', () => {
  it('collects repeated --node id:token pairs in order', () => {
    const options = parseOptions(['--node', 'alpha:token-a', '--node', 'beta:token-b'])
    expect(options.records).toEqual([
      { nodeId: 'alpha', token: 'token-a' },
      { nodeId: 'beta', token: 'token-b' },
    ])
  })

  it('refuses a --node value that is not id:token', () => {
    for (const value of ['not-a-pair', ':token', 'id:']) {
      expect(() => parseArgs(['--node', value]), value).toThrowError(/--node expects <nodeId>:<value>/)
    }
  })

  it('reads a --node-env token from the environment', () => {
    process.env[ENV_TOKEN] = 'from-the-environment'
    const options = parseOptions(['--node-env', `alpha:${ENV_TOKEN}`])
    expect(options.records).toEqual([{ nodeId: 'alpha', token: 'from-the-environment' }])
  })

  it('refuses a --node-env whose variable is empty or unset', () => {
    process.env[ENV_EMPTY] = ''
    expect(() => parseArgs(['--node-env', `alpha:${ENV_EMPTY}`]))
      .toThrowError(new RegExp(`environment variable ${ENV_EMPTY} is empty`))
    expect(() => parseArgs(['--node-env', 'alpha:DSH_COORDINATOR_TEST_ABSENT']))
      .toThrowError(/environment variable DSH_COORDINATOR_TEST_ABSENT is empty/)
  })

  it('stashes --nodes-file as a sentinel that loadNodesFile resolves', async () => {
    const path = await writeNodesFile('nodes.json', [
      { nodeId: 'alpha', token: 'token-a', nodeName: 'Alpha' },
      { nodeId: 'beta', token: 'token-b', role: 'worker' },
    ])

    const options = parseOptions(['--nodes-file', path])
    expect(options.records).toEqual([{ nodeId: '\u0000file', token: path }])

    await expect(loadNodesFile(options.records[0]?.token ?? '')).resolves.toEqual([
      { nodeId: 'alpha', token: 'token-a', nodeName: 'Alpha' },
      { nodeId: 'beta', token: 'token-b', role: 'worker' },
    ])
  })

  it('reports a nodes file that is unreadable, not an array, or missing a token', async () => {
    await expect(loadNodesFile(join(TMP_DIR, 'absent.json'))).rejects.toThrowError(/could not be read/)
    await expect(loadNodesFile(await writeNodesFile('object.json', { nodeId: 'alpha' })))
      .rejects.toThrowError(/must contain a JSON array/)
    await expect(loadNodesFile(await writeNodesFile('no-token.json', [{ nodeId: 'alpha' }])))
      .rejects.toThrowError(/record 0 needs a token/)
    await expect(loadNodesFile(await writeNodesFile('no-id.json', [{ token: 'token-a' }])))
      .rejects.toThrowError(/record 0 needs a nodeId/)
  })
})

describe('directives', () => {
  it('treats --help, -h, and --version as directives rather than options', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true })
    expect(parseArgs(['-h'])).toEqual({ help: true })
    expect(parseArgs(['--version'])).toEqual({ version: true })
  })

  it('returns a directive as soon as it appears', () => {
    expect(parseArgs(['--port', '1234', '--help'])).toEqual({ help: true })
    expect(parseArgs(['--node', 'alpha:token-a', '--version'])).toEqual({ version: true })
  })
})

describe('flag validation', () => {
  it('refuses an unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrowError('unknown flag "--nope"')
    expect(() => parseArgs(['--node', 'alpha:token-a', '--wat'])).toThrowError('unknown flag "--wat"')
  })

  it('refuses a --log-level outside the known set', () => {
    expect(() => parseArgs(['--log-level', 'verbose']))
      .toThrowError(/--log-level expects one of debug, info, warn, error, silent/)
    expect(parseOptions(['--log-level', 'warn']).logLevel).toBe('warn')
  })

  it('refuses a non-numeric value for a numeric flag', () => {
    const flags = [
      '--port',
      '--heartbeat-interval',
      '--handshake-timeout',
      '--request-timeout',
      '--stream-idle-timeout',
      '--max-streams',
      '--max-in-flight',
    ]
    for (const flag of flags) {
      expect(() => parseArgs([flag, 'soon']), flag).toThrowError(`${flag} expects a number`)
    }
  })

  it('requires a value for a flag that needs one', () => {
    expect(() => parseArgs(['--port'])).toThrowError('--port requires a value')
    expect(() => parseArgs(['--host'])).toThrowError('--host requires a value')
    expect(() => parseArgs(['--log-level'])).toThrowError('--log-level requires a value')
  })

  it('parses the numeric flags', () => {
    const options = parseOptions([
      '--port', '0',
      '--heartbeat-interval', '5000',
      '--handshake-timeout', '250',
      '--request-timeout', '1000',
      '--stream-idle-timeout', '2000',
      '--max-streams', '3',
      '--max-in-flight', '7',
    ])
    expect(options).toMatchObject({
      port: 0,
      heartbeatIntervalMs: 5000,
      handshakeTimeoutMs: 250,
      requestTimeoutMs: 1000,
      streamIdleTimeoutMs: 2000,
      maxStreams: 3,
      maxInFlightRequests: 7,
    })
  })

  it('collects the connection flags and the boolean switches', () => {
    const options = parseOptions([
      '--host', '0.0.0.0',
      '--path', '/ws',
      '--enroll-token', 'enroll-secret',
      '--api-token', 'operator-secret',
      '--no-api',
      '--allow-insecure-bind',
      '--trace-frames',
    ])
    expect(options).toMatchObject({
      host: '0.0.0.0',
      path: '/ws',
      enrollmentToken: 'enroll-secret',
      apiToken: 'operator-secret',
      enableApi: false,
      allowInsecureBind: true,
      traceFrames: true,
    })
  })
})
