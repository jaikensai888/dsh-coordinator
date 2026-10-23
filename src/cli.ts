#!/usr/bin/env node
/**
 * `dsh-coordinate` — run a Coordinator from a shell, and create its administrator.
 *
 * Two jobs, one binary:
 *
 * - **`dsh-coordinate [options]`** starts the service. Persistence is a SQLite
 *   database by default; `--no-state-file` keeps everything in memory for a
 *   throwaway test and turns management login off, because there is nowhere to
 *   keep an account.
 * - **`dsh-coordinate admin init|reset-password`** creates or resets the single
 *   administrator. The password is typed at the console and never accepted as a
 *   command-line argument: an argument is visible in the process list and in shell
 *   history, which is a strange place to keep the only credential to the console.
 *
 * Credential handling is the one thing worth reading carefully:
 *
 * - `--node <nodeId>:<token>` puts a token in the process list, which is fine for
 *   a throwaway loopback test and wrong for anything else;
 * - `--node-env <nodeId>:<ENV_VAR>` reads it from the environment instead, and is
 *   the recommended form;
 * - `--nodes-file <path>` reads a JSON array of records, and the file's
 *   permissions are the operator's responsibility.
 *
 * Nothing here ever prints a token or a password.
 *
 * @module dsh-coordinator/cli
 */

import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { AuthService, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './auth.js'
import { openCoordinatorDatabase, type CoordinatorDatabase } from './database.js'
import { Coordinator, DEFAULT_PATH, DEFAULT_PORT, formatHost, isLoopback, isWildcardHost } from './server.js'
import { resolveDatabasePaths } from './state-migration.js'
import { isCoordinatorError } from './errors.js'
import { createLogger, LOG_LEVELS, type LogLevel } from './log.js'
import type { NodeRecord } from './protocol.js'

/**
 * This machine's non-loopback IPv4 addresses.
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
  /** The unified database path. */
  dbFile?: string
  /** The JSON file to import on first start. */
  migrateStateFile?: string
  noStateFile: boolean
  publicOrigin?: string
  allowedOrigins: string[]
  secureCookies: boolean
  usageSync?: boolean
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
  dsh-coordinate admin init [--db-file <path>] [--username <name>]
  dsh-coordinate admin reset-password [--db-file <path>]

Options:
  --port <n>                  TCP port to listen on (default ${DEFAULT_PORT}; 0 picks a free one)
  --host <addr>               bind address (default 127.0.0.1; non-loopback needs --allow-insecure-bind)
  --path <path>               WebSocket upgrade path (default ${DEFAULT_PATH})
  --node <nodeId>:<token>     approve a node (repeatable; the token is visible in the process list)
  --node-env <nodeId>:<VAR>   approve a node, reading its token from an environment variable (preferred)
  --nodes-file <path>         JSON array of {nodeId, token, nodeName?, role?} records
  --enroll-token <secret>     let an unknown node enroll itself by presenting this secret
  --db-file <path>            the unified SQLite database (default coordinator.sqlite)
  --migrate-state-file <path> the legacy JSON to import on first start
  --state-file <path>         deprecated: maps <name>.json to <name>.sqlite and imports it once
  --no-state-file             keep everything in memory; management login and usage sync are off
  --public-origin <origin>    the origin browsers use, e.g. http://192.168.0.13:8101
  --allowed-origin <origin>   an extra same-site origin (repeatable)
  --secure-cookies            set Secure on the session cookie (HTTPS front end only)
  --no-usage-sync             do not poll nodes for usage
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
    allowedOrigins: [],
    secureCookies: false,
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
      case '--db-file':
        options.dbFile = next()
        break
      case '--migrate-state-file':
        options.migrateStateFile = next()
        break
      case '--no-state-file':
        options.noStateFile = true
        break
      case '--public-origin':
        options.publicOrigin = next()
        break
      case '--allowed-origin':
        options.allowedOrigins.push(next())
        break
      case '--secure-cookies':
        options.secureCookies = true
        break
      case '--no-usage-sync':
        options.usageSync = false
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

/** How the administrator commands talk to the operator. */
export interface AdminCommandDeps {
  /** Ask for one secret line, with echo suppressed. */
  readonly prompt?: (question: string) => Promise<string>
  readonly stdout?: (text: string) => void
  readonly stderr?: (text: string) => void
  /** Open the database; injectable so a test can use a temporary file. */
  readonly openDatabase?: (file: string) => CoordinatorDatabase
  readonly hasTty?: boolean
}

/** Read one password from a terminal without echoing it. */
export async function promptPassword(question: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    // `readline` has no public "hide input" switch; suppressing its writer is the
    // documented-enough way to keep the password off the screen. It is never
    // echoed by this process because nothing writes it.
    const mutable = rl as unknown as { _writeToOutput?: (text: string) => void }
    mutable._writeToOutput = (text: string) => {
      if (text.includes(question)) process.stdout.write(question)
    }
    process.stdout.write(question)
    rl.question('', (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    rl.on('SIGINT', () => {
      rl.close()
      reject(new Error('cancelled'))
    })
  })
}

/** Parse `--flag value` pairs for the admin subcommands. */
function adminFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string
    if (!flag.startsWith('--')) throw new Error(`unexpected argument "${flag}"`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${flag} requires a value`)
    flags.set(flag, value)
    index += 1
  }
  for (const flag of flags.keys()) {
    if (flag !== '--db-file' && flag !== '--username') {
      throw new Error(`unknown flag "${flag}" for an admin command`)
    }
  }
  return flags
}

/**
 * Run one `admin` subcommand.
 * @param argv - arguments after `admin`.
 * @param deps - injectable prompt, streams, and database opener.
 * @returns the process exit code.
 */
export async function runAdminCommand(argv: readonly string[], deps: AdminCommandDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text) })
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text) })
  const action = argv[0]
  if (action !== 'init' && action !== 'reset-password') {
    stderr(`admin expects "init" or "reset-password"\n\n${HELP}`)
    return 2
  }
  let flags: Map<string, string>
  try {
    flags = adminFlags(argv.slice(1))
  } catch (error) {
    stderr(`${(error as Error).message}\n`)
    return 2
  }
  const username = flags.get('--username') ?? 'admin'
  if (action === 'reset-password' && flags.has('--username')) {
    stderr('reset-password keeps the existing username; --username is not accepted\n')
    return 2
  }
  const hasTty = deps.hasTty ?? (process.stdin.isTTY === true)
  if (!hasTty) {
    stderr('this command needs a terminal: the password is typed, never passed as an argument\n')
    return 2
  }

  const paths = resolveDatabasePaths({
    ...(flags.get('--db-file') === undefined ? {} : { dbFile: flags.get('--db-file') as string }),
  })
  const dbFile = paths.dbFile
  if (dbFile === null) {
    stderr('an admin command needs a database\n')
    return 2
  }

  let database: CoordinatorDatabase
  try {
    database = deps.openDatabase?.(dbFile) ?? openCoordinatorDatabase({ file: dbFile })
  } catch (error) {
    stderr(`could not open ${dbFile}: ${(error as Error).message}\n`)
    return 1
  }
  try {
    const auth = new AuthService({ db: database.db })
    const prompt = deps.prompt ?? promptPassword
    if (action === 'init') {
      if (auth.initialized) {
        stderr(`an administrator already exists in ${dbFile}; use "admin reset-password"\n`)
        return 1
      }
      const password = await prompt(`password for ${username} (${MIN_PASSWORD_LENGTH}..${MAX_PASSWORD_LENGTH} characters): `)
      const again = await prompt('repeat the password: ')
      if (password !== again) {
        stderr('the passwords do not match\n')
        return 1
      }
      await auth.initAdmin(username, password)
      stdout(`administrator "${username}" created in ${dbFile}\n`)
      return 0
    }
    if (!auth.initialized) {
      stderr(`no administrator exists in ${dbFile}; run "admin init" first\n`)
      return 1
    }
    const password = await prompt(`new password for ${auth.user?.username ?? username}: `)
    const again = await prompt('repeat the new password: ')
    if (password !== again) {
      stderr('the passwords do not match\n')
      return 1
    }
    await auth.resetPassword(password)
    stdout(`password reset in ${dbFile}; every existing session was revoked\n`)
    return 0
  } catch (error) {
    stderr(`${(error as Error).message}\n`)
    return 1
  } finally {
    database.close()
  }
}

/**
 * Run the service until a signal arrives.
 * @param argv - arguments after the executable and script.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'admin') return await runAdminCommand(argv.slice(1))

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

  /*
    Resolve the store once, here.

    `--state-file` is kept as an alias: it names a JSON file, and the contract says
    that file maps to `<name>.sqlite` beside it, imported exactly once. Resolving it
    here rather than inside `Coordinator` keeps one answer to "where is the data".
  */
  let paths: ReturnType<typeof resolveDatabasePaths>
  try {
    paths = resolveDatabasePaths({
      ...(options.dbFile === undefined ? {} : { dbFile: options.dbFile }),
      ...(options.stateFile === undefined ? {} : { stateFile: options.stateFile }),
      ...(options.migrateStateFile === undefined ? {} : { migrateStateFile: options.migrateStateFile }),
      ...(options.noStateFile ? { noStateFile: true } : {}),
    })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
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
      ...(paths.dbFile === null ? {} : { dbFile: paths.dbFile }),
      ...(paths.legacyFile === undefined ? {} : { migrateStateFile: paths.legacyFile }),
      ...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
      ...(options.allowedOrigins.length === 0 ? {} : { allowedOrigins: options.allowedOrigins }),
      ...(options.secureCookies ? { secureCookies: true } : {}),
      ...(options.usageSync === undefined ? {} : { usageSync: options.usageSync }),
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
    const origin = options.publicOrigin ?? `http://${formatHost(address.host)}:${address.port}`
    const local = `http://127.0.0.1:${address.port}`
    const servesUi = options.enableApi && coordinator.sessionsEnabled
    const remoteAdmin = coordinator.operatorTokenConfigured

    if (isWildcardHost(address.host)) {
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

    const uiSuffix = servesUi ? `; console on ${origin}/ui` : ''
    process.stderr.write(
      remoteAdmin
        ? `  operator API: ${origin}/api${uiSuffix}${isLoopback(address.host) ? '' : '  (bearer token for machine clients)'}\n`
        : `  operator API: ${local}/api${uiSuffix}  (no bearer token set: browsers use the administrator session)\n`,
    )

    if (!isLoopback(address.host)) {
      // The enrollment secret is the door key; plaintext is the wall being missing.
      // Say both facts once, at the moment the operator chose this.
      process.stderr.write(
        'insecure bind: node connections and the console are plaintext on the network. A node token is\n' +
        '  full access to that machine, and the administrator password crosses the network unencrypted\n' +
        '  on HTTP. Put TLS in front of this (wss:// and https:// via a reverse proxy) for anything wider\n' +
        '  than a trusted LAN.\n',
      )
    }
    if (options.publicOrigin !== undefined && !options.publicOrigin.startsWith('https://')) {
      process.stderr.write(
        `note: the management console is published over plain HTTP at ${options.publicOrigin}; the session\n` +
        '  cookie has no Secure bit and the password is not encrypted in transit. This is the documented\n' +
        '  first-phase posture for a trusted LAN, not a public deployment.\n',
      )
    }

    // Stated unconditionally, because "where did my secret go?" is a question an
    // operator should never have to ask a log file to answer.
    if (paths.dbFile === null) {
      process.stderr.write(
        'state: in memory only (--no-state-file); node tokens are lost on exit, management login is disabled,\n' +
        '  and usage sync is off because there is nowhere to store it\n',
      )
    } else {
      process.stderr.write(
        `state: ${paths.dbFile} (schema via ${String(coordinator.sqliteDriver)}; holds node tokens, the administrator,\n` +
        '  sessions and usage; keep it private and back it up with SQLite\'s backup API)\n',
      )
      process.stderr.write(
        coordinator.adminInitialized
          ? 'administrator: configured\n'
          : 'administrator: not created yet — run "dsh-coordinate admin init --db-file <path>" on this server\n',
      )
    }
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
