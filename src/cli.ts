#!/usr/bin/env node
/**
 * `dsh-coordinate` — run a Coordinator from a shell.
 *
 * Exists because the service's most useful verification is not a unit test: it is
 * a real DSH node dialling in from another process and answering a real Remote.
 * That needs a standalone process with a configurable port, which is this file.
 *
 * Credential handling is the one thing worth reading carefully:
 *
 * - `--node <nodeId>:<token>` puts a token in the process list, which is fine for
 *   a throwaway loopback test and wrong for anything else;
 * - `--node-env <nodeId>:<ENV_VAR>` reads it from the environment instead, and is
 *   the recommended form;
 * - `--nodes-file <path>` reads a JSON array of records, and the file's
 *   permissions are the operator's responsibility (spec §7: this file grants
 *   remote access to other machines).
 *
 * Nothing here ever prints a token.
 *
 * @module dsh-coordinator/cli
 */

import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Coordinator, DEFAULT_PATH, DEFAULT_PORT, formatHost, isLoopback, isWildcardHost } from './server.js'
import { DEFAULT_STATE_FILE_NAME } from './state-file.js'
import { isCoordinatorError } from './errors.js'
import { createLogger, LOG_LEVELS, type LogLevel } from './log.js'
import type { NodeRecord } from './protocol.js'

/**
 * This machine's non-loopback IPv4 addresses.
 *
 * Exists because a wildcard bind cannot be described by the string it was
 * configured with: the operator needs the address a *peer* would type.
 * @returns the addresses, or an empty array on a machine with no network.
 */
function reachableAddresses(): string[] {
  const addresses: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address)
    }
  }
  return addresses
}

/** What the CLI was asked to do. */
interface CliOptions {
  port: number
  host: string
  path: string
  records: NodeRecord[]
  enrollmentToken?: string
  apiToken?: string
  logLevel: LogLevel
  traceFrames: boolean
  enableApi: boolean
  allowInsecureBind: boolean
  /** Where to persist state, or undefined when `--no-state-file` was given. */
  stateFile?: string
  noStateFile: boolean
  heartbeatIntervalMs?: number
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
  streamIdleTimeoutMs?: number
  maxStreams?: number
  maxInFlightRequests?: number
}

/** One line of help text per flag. */
const HELP = `dsh-coordinate — accept outbound DSH node connections and forward Remote calls.

Usage:
  dsh-coordinate [options]

Options:
  --port <n>                  TCP port to listen on (default ${DEFAULT_PORT}; 0 picks a free one)
  --host <addr>               bind address (default 127.0.0.1; non-loopback needs --allow-insecure-bind)
  --path <path>               WebSocket upgrade path (default ${DEFAULT_PATH})
  --node <nodeId>:<token>     approve a node (repeatable; the token is visible in the process list)
  --node-env <nodeId>:<VAR>   approve a node, reading its token from an environment variable (preferred)
  --nodes-file <path>         JSON array of {nodeId, token, nodeName?, role?} records
  --enroll-token <secret>     let an unknown node enroll itself by presenting this secret
  --state-file <path>         where to persist the registry and the enrollment secret
                              (default ${DEFAULT_STATE_FILE_NAME} in the working directory)
  --no-state-file             keep everything in memory; nothing is written to disk
  --api-token <token>         require this bearer token on the operator API
  --no-api                    do not install the operator API
  --allow-insecure-bind       permit a non-loopback bind (put TLS in front of it)
  --heartbeat-interval <ms>   ping cadence handed to nodes in hello.ok
  --handshake-timeout <ms>    how long to wait for a node's hello
  --request-timeout <ms>      default deadline for a unary call
  --stream-idle-timeout <ms>  default idle deadline for a stream
  --max-streams <n>           concurrent streams per node
  --max-in-flight <n>         concurrent unary calls per node
  --log-level <level>         one of ${LOG_LEVELS.join(', ')} (default info)
  --trace-frames              log every frame, redacted (debugging only)
  --help                      print this text
  --version                   print the version
`

/** Parse one `id:value` pair. */
function parsePair(value: string, flag: string): { id: string; value: string } {
  const index = value.indexOf(':')
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`${flag} expects <nodeId>:<value>, received "${value}"`)
  }
  return { id: value.slice(0, index), value: value.slice(index + 1) }
}

/**
 * Parse argv.
 * @param argv - arguments after the executable and script.
 * @returns the resolved options, or a directive to print help/version.
 */
export function parseArgs(argv: readonly string[]): { help: true } | { version: true } | { options: CliOptions } {
  const options: CliOptions = {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    path: DEFAULT_PATH,
    records: [],
    logLevel: 'info',
    traceFrames: false,
    enableApi: true,
    allowInsecureBind: false,
    noStateFile: false,
  }
  const numeric = (name: string, raw: string | undefined): number => {
    const value = Number(raw)
    if (raw === undefined || !Number.isFinite(value)) throw new Error(`${name} expects a number, received "${raw ?? ''}"`)
    return value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string
    const next = (): string => {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error(`${flag} requires a value`)
      return value
    }
    switch (flag) {
      case '--help':
      case '-h':
        return { help: true }
      case '--version':
        return { version: true }
      case '--port':
        options.port = numeric(flag, next())
        break
      case '--host':
        options.host = next()
        break
      case '--path':
        options.path = next()
        break
      case '--node': {
        const pair = parsePair(next(), flag)
        options.records.push({ nodeId: pair.id, token: pair.value })
        break
      }
      case '--node-env': {
        const pair = parsePair(next(), flag)
        const token = process.env[pair.value]
        if (token === undefined || token === '') {
          throw new Error(`--node-env ${pair.id}:${pair.value} — environment variable ${pair.value} is empty`)
        }
        options.records.push({ nodeId: pair.id, token })
        break
      }
      case '--nodes-file':
        // Read in `main`, where the read can be awaited and reported.
        options.records.push({ nodeId: '\u0000file', token: next() })
        break
      case '--enroll-token':
        options.enrollmentToken = next()
        break
      case '--state-file':
        options.stateFile = next()
        break
      case '--no-state-file':
        options.noStateFile = true
        break
      case '--api-token':
        options.apiToken = next()
        break
      case '--no-api':
        options.enableApi = false
        break
      case '--allow-insecure-bind':
        options.allowInsecureBind = true
        break
      case '--heartbeat-interval':
        options.heartbeatIntervalMs = numeric(flag, next())
        break
      case '--handshake-timeout':
        options.handshakeTimeoutMs = numeric(flag, next())
        break
      case '--request-timeout':
        options.requestTimeoutMs = numeric(flag, next())
        break
      case '--stream-idle-timeout':
        options.streamIdleTimeoutMs = numeric(flag, next())
        break
      case '--max-streams':
        options.maxStreams = numeric(flag, next())
        break
      case '--max-in-flight':
        options.maxInFlightRequests = numeric(flag, next())
        break
      case '--log-level': {
        const level = next()
        if (!LOG_LEVELS.includes(level as LogLevel)) {
          throw new Error(`--log-level expects one of ${LOG_LEVELS.join(', ')}, received "${level}"`)
        }
        options.logLevel = level as LogLevel
        break
      }
      case '--trace-frames':
        options.traceFrames = true
        break
      default:
        throw new Error(`unknown flag "${flag}"`)
    }
  }
  return { options }
}

/** Load a node-record file, keeping the tokens out of every log line. */
export async function loadNodesFile(path: string): Promise<NodeRecord[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`--nodes-file ${path} could not be read: ${(error as Error).message}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`--nodes-file ${path} must contain a JSON array`)
  return parsed.map((entry, index) => {
    const record = entry as Partial<NodeRecord>
    if (typeof record.nodeId !== 'string' || record.nodeId === '') {
      throw new Error(`--nodes-file ${path}: record ${index} needs a nodeId`)
    }
    if (typeof record.token !== 'string' || record.token === '') {
      throw new Error(`--nodes-file ${path}: record ${index} needs a token`)
    }
    return {
      nodeId: record.nodeId,
      token: record.token,
      ...(record.nodeName === undefined ? {} : { nodeName: record.nodeName }),
      ...(record.role === undefined ? {} : { role: record.role }),
    }
  })
}

/**
 * Run the service until a signal arrives.
 * @param argv - arguments after the executable and script.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`)
    return 2
  }
  if ('help' in parsed) {
    process.stdout.write(HELP)
    return 0
  }
  if ('version' in parsed) {
    const { COORDINATOR_VERSION } = await import('./index.js')
    process.stdout.write(`${COORDINATOR_VERSION}\n`)
    return 0
  }

  const { options } = parsed
  // `--nodes-file` was stashed as a sentinel so one loop could handle every flag;
  // resolve it before anything else looks at the list.
  const fileEntries = options.records.filter(record => record.nodeId === '\u0000file')
  options.records = options.records.filter(record => record.nodeId !== '\u0000file')
  for (const entry of fileEntries) {
    try {
      options.records.push(...await loadNodesFile(entry.token))
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`)
      return 2
    }
  }

  const logger = createLogger({
    level: options.logLevel,
    traceFrames: options.traceFrames,
    secrets: () => [
      ...options.records.map(record => record.token),
      ...(options.enrollmentToken === undefined ? [] : [options.enrollmentToken]),
      ...(options.apiToken === undefined ? [] : [options.apiToken]),
    ],
  })

  let coordinator: Coordinator
  try {
    coordinator = new Coordinator({
      port: options.port,
      host: options.host,
      path: options.path,
      records: options.records,
      // Persistence is on by default: a secret set in the UI that vanished on the
      // next restart would make "configure it once" a lie. The path is printed at
      // startup so it is never a surprise, and `--no-state-file` opts out.
      ...(options.noStateFile ? {} : { stateFile: options.stateFile ?? DEFAULT_STATE_FILE_NAME }),
      enrollmentFromCli: options.enrollmentToken !== undefined,
      ...(options.enrollmentToken === undefined
        ? {}
        : { enrollment: { kind: 'shared-secret', token: options.enrollmentToken } as const }),
      ...(options.apiToken === undefined ? {} : { apiToken: options.apiToken }),
      enableApi: options.enableApi,
      allowInsecureBind: options.allowInsecureBind,
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
      ...(options.maxStreams === undefined ? {} : { maxStreams: options.maxStreams }),
      ...(options.maxInFlightRequests === undefined ? {} : { maxInFlightRequests: options.maxInFlightRequests }),
      logger,
      onEvent: (event) => {
        if (event.type === 'ready') {
          logger.info('coordinator/node-connected', {
            nodeId: event.nodeId,
            connectionId: event.connectionId,
            remotes: event.capabilities.remotes.length,
            streams: event.capabilities.remotes.filter(remote => remote.mode === 'stream').length,
            surfaceChanged: event.surfaceChanged,
          })
        } else if (event.type === 'auth-rejected') {
          logger.warn('coordinator/node-refused', { nodeId: event.nodeId, reason: event.reason })
        } else if (event.type === 'closed') {
          logger.info('coordinator/node-disconnected', { nodeId: event.nodeId, code: event.code })
        }
      },
    })
  } catch (error) {
    if (isCoordinatorError(error)) {
      process.stderr.write(`${error.code}: ${error.message}\n`)
      return 2
    }
    throw error
  }

  try {
    const address = await coordinator.start()
    const origin = `http://${formatHost(address.host)}:${address.port}`
    const local = `http://127.0.0.1:${address.port}`
    const servesUi = options.enableApi && coordinator.sessionsEnabled
    // The two privileges are decided separately now, so the banner has to report
    // them separately: where nodes may dial from, and where administration works.
    // The token may have been restored from the state file or configured through
    // the localhost UI, so the coordinator is the source of truth here.
    const remoteAdmin = coordinator.operatorTokenConfigured

    if (isWildcardHost(address.host)) {
      // `0.0.0.0` listens on every interface, but no other machine can *dial* it.
      // Printing it as the node URL would hand over a configuration that cannot
      // work, and the resulting timeout reads like a firewall problem.
      const usable = reachableAddresses()
      process.stderr.write(`ready: listening on every interface, port ${address.port}\n`)
      if (usable.length === 0) {
        process.stderr.write('  no non-loopback IPv4 address was found, so nodes on other machines cannot reach this\n')
      } else {
        process.stderr.write(
          `  nodes on other machines dial one of: ${usable.map(ip => `ws://${ip}:${address.port}/node`).join('  ')}\n`,
        )
      }
    } else {
      process.stderr.write(`ready: nodes dial ${address.url}\n`)
    }

    const uiSuffix = servesUi ? `; UI on ${local}/ui` : ''
    process.stderr.write(
      remoteAdmin
        ? `  operator API: ${origin}/api${uiSuffix}${isLoopback(address.host) ? '' : '  (reachable from the network, bearer token required)'}\n`
        : `  operator API: ${local}/api${uiSuffix}  (this machine only${isLoopback(address.host) ? '' : '; pass --api-token to administer remotely'})\n`,
    )

    if (!isLoopback(address.host)) {
      // The enrollment secret is the door key; plaintext is the wall being missing.
      // Say both facts once, at the moment the operator chose this.
      process.stderr.write(
        'insecure bind: node connections are plaintext on the network. A node token is full\n' +
        '  access to that machine, so put TLS in front of this (wss:// via a reverse proxy) and\n' +
        '  prefer per-node tokens over the shared secret. The operator API is unaffected — it is\n' +
        `  ${remoteAdmin ? 'token-gated' : 'fenced to this machine'}.\n`,
      )
    }

    // Stated unconditionally, because "where did my secret go?" is a question an
    // operator should never have to ask a log file to answer.
    const state = coordinator.stateFile
    process.stderr.write(
      state === undefined
        ? 'state: in memory only (--no-state-file); node tokens and the enrollment secret are lost on exit\n'
        : `state: ${state} (holds node tokens and the enrollment secret; keep it private)\n`,
    )
    if (coordinator.enrollmentOpen) {
      process.stderr.write('enrollment: open — an unknown node presenting the shared secret is admitted\n')
    }
  } catch (error) {
    process.stderr.write(`could not listen: ${(error as Error).message}\n`)
    return 1
  }

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    process.stderr.write(`${signal} received; closing node connections\n`)
    void coordinator.stop().then(() => { process.exit(0) })
  }
  process.on('SIGINT', () => { shutdown('SIGINT') })
  process.on('SIGTERM', () => { shutdown('SIGTERM') })

  // The process lives until a signal: the listener holds it open on purpose, and
  // the signal handlers above are what ends it.
  return await new Promise<number>(() => {})
}

// Run when executed as a script, stay importable from tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(code => { process.exitCode = code })
}
