/**
 * The Coordinator's persisted state: the node allowlist and the enrollment rule.
 *
 * Everything in this file that matters is a **credential**. A node token is full
 * remote access to that machine, and the enrollment secret is the right to become
 * a node. So this module treats the file the way the rest of the service treats
 * credentials:
 *
 * - it is written **atomically** (temp file plus rename), because a torn write
 *   would be a Coordinator that cannot start;
 * - it is created with the tightest mode the platform honours;
 * - nothing here ever returns, logs, or throws the secret's value — errors name
 *   the file and the field, never the content.
 *
 * Why the Coordinator now writes credentials at all: the earlier design left this
 * to the embedder, on the grounds that "where a token lives and who can read it is
 * a deployment decision". That is still true, and the decision is now explicit
 * rather than absent — an operator asked for a secret they can set once and have
 * survive a restart, and a service that forgot it on every restart would be
 * pretending the problem away rather than deciding it. The defaults are chosen to
 * be the safe ones (see {@link resolveStateFile}), and the file is opt-out via
 * `--no-state-file`.
 *
 * @module dsh-coordinator/state-file
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { EnrollmentPolicy } from './node-registry.js'
import type { NodeRecord } from './protocol.js'

/** File name used when the operator names a directory or nothing at all. */
export const DEFAULT_STATE_FILE_NAME = 'coordinator-state.json'

/** Schema version of the stored document, so a future change can migrate. */
export const STATE_FILE_VERSION = 1

/** What the Coordinator remembers across restarts. */
export interface CoordinatorState {
  /** Bearer token used by the operator API, when one has been configured. */
  readonly apiToken?: string
  /** The rule by which unknown nodes may join. Absent means "closed". */
  readonly enrollment?: EnrollmentPolicy
  /** Approved nodes, revoked ones included. */
  readonly nodes: readonly NodeRecord[]
}

/** The outcome of reading the state file. */
export interface StateFileRead {
  /** Absolute path, reported so an operator can find and protect it. */
  readonly file: string
  /** Present when the file held a usable document. */
  readonly state?: CoordinatorState
  /**
   * Set when the file exists but could not be used.
   *
   * A missing file is **not** an error — it is the first run. A present-but-broken
   * file is reported rather than thrown so the service still starts, because
   * refusing to boot over a hand-edited file leaves an operator with no API to fix
   * it through.
   */
  readonly error?: string
}

/** Serialize direct callers too; Windows can reject concurrent replacement renames. */
const stateWriteQueues = new Map<string, Promise<void>>()

/**
 * Turn a configured path into an absolute file path.
 *
 * A bare name or a directory-sounding path gets {@link DEFAULT_STATE_FILE_NAME}
 * appended, so `--state-file .` and `--state-file state.json` both do what they
 * look like.
 * @param configured - the operator's path, or undefined for the default.
 * @param cwd - base directory for a relative path.
 * @returns the absolute file path.
 */
export function resolveStateFile(configured: string | undefined, cwd: string = process.cwd()): string {
  if (configured === undefined || configured.trim() === '') {
    return join(cwd, DEFAULT_STATE_FILE_NAME)
  }
  const trimmed = configured.trim()
  const looksLikeFile = /\.[A-Za-z0-9]+$/u.test(trimmed)
  const base = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
  return looksLikeFile ? base : join(base, DEFAULT_STATE_FILE_NAME)
}

/** Keep only fields this module understands, dropping anything else. */
function pickRecord(value: unknown): NodeRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const text = (field: string): string | undefined => {
    const v = raw[field]
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const nodeId = text('nodeId')
  const token = text('token')
  if (nodeId === undefined || token === undefined) return undefined
  const nodeName = text('nodeName')
  const role = text('role')
  const revokedAt = text('revokedAt')
  return {
    nodeId,
    token,
    ...(nodeName === undefined ? {} : { nodeName }),
    ...(role === undefined ? {} : { role }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  }
}

/** Read the enrollment rule, keeping only a usable shape. */
function pickEnrollment(value: unknown): EnrollmentPolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (raw['kind'] === 'closed') return { kind: 'closed' }
  if (raw['kind'] === 'shared-secret' && typeof raw['token'] === 'string' && raw['token'] !== '') {
    return { kind: 'shared-secret', token: raw['token'] }
  }
  return undefined
}

/** Read a credential while keeping blank values out of the runtime state. */
function pickApiToken(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read the persisted state.
 *
 * A missing file is the normal first run. A corrupt or unreadable one is reported
 * but never thrown: the service must still start, or an operator who hand-edited
 * the file has no way back in.
 * @param file - absolute path from {@link resolveStateFile}.
 * @returns the read outcome.
 */
export async function readStateFile(file: string): Promise<StateFileRead> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file }
    return { file, error: `could not read ${file}: ${(error as Error).message}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { file, error: `${file} is not valid JSON; ignoring it` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { file, error: `${file} must contain a JSON object; ignoring it` }
  }

  const document = parsed as Record<string, unknown>
  const version = document['version']
  if (version !== undefined && version !== STATE_FILE_VERSION) {
    return {
      file,
      error: `${file} has version ${String(version)}, expected ${String(STATE_FILE_VERSION)}; ignoring it`,
    }
  }

  const nodes = Array.isArray(document['nodes'])
    ? document['nodes'].map(pickRecord).filter((record): record is NodeRecord => record !== undefined)
    : []
  const apiToken = pickApiToken(document['apiToken'])
  const enrollment = pickEnrollment(document['enrollment'])
  return {
    file,
    state: {
      nodes,
      ...(apiToken === undefined ? {} : { apiToken }),
      ...(enrollment === undefined ? {} : { enrollment }),
    },
  }
}

/**
 * Write the state atomically, with the tightest mode the platform honours.
 *
 * Temp file plus rename: a reader sees either the previous document or the new
 * one, never a half-written credential. The temp file is removed if the rename
 * fails, so a failed save cannot leave a stray secret on disk.
 * @param file - absolute path from {@link resolveStateFile}.
 * @param state - the document to store.
 */
export function writeStateFile(file: string, state: CoordinatorState): Promise<void> {
  const previous = stateWriteQueues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => writeStateFileNow(file, state))
  stateWriteQueues.set(file, next)
  void next.then(
    () => {
      if (stateWriteQueues.get(file) === next) stateWriteQueues.delete(file)
    },
    () => {
      if (stateWriteQueues.get(file) === next) stateWriteQueues.delete(file)
    },
  )
  return next
}

async function writeStateFileNow(file: string, state: CoordinatorState): Promise<void> {
  const payload = {
    version: STATE_FILE_VERSION,
    ...(state.apiToken === undefined ? {} : { apiToken: state.apiToken }),
    ...(state.enrollment === undefined ? {} : { enrollment: state.enrollment }),
    nodes: state.nodes.map(record => ({
      nodeId: record.nodeId,
      token: record.token,
      ...(record.nodeName === undefined ? {} : { nodeName: record.nodeName }),
      ...(record.role === undefined ? {} : { role: record.role }),
      ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    })),
  }

  await mkdir(dirname(file), { recursive: true })
  /*
    The temp name is unique per write, and that is not decoration.

    A fixed `${file}.tmp` makes the whole technique a lie the moment two saves
    overlap: both writers fill the same path, the contents interleave, and whichever
    rename lands second publishes a torn document. That is not hypothetical — a real
    state file came back as one document's head followed by another's tail, and the
    loader correctly refused it, which silently dropped the enrollment secret.

    Callers are expected to serialise their saves as well. This is the layer that
    stays correct when one of them forgets.
  */
  const temporary = `${file}.${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}.tmp`
  // `mode` is honoured on POSIX and ignored on Windows. Passing it is still right,
  // and the chmod below covers filesystems where the create-time mode is masked.
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await chmod(temporary, 0o600)
  } catch {
    // Windows and some network filesystems refuse this; the create-time mode is
    // the best that can be done there, and failing the save over it would be worse.
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * A secret-free description of a state document, for logs.
 *
 * Reports **whether** a credential is present and never what it is. This is the
 * only shape of this data allowed to reach a log line.
 * @param state - the state to describe, or undefined when nothing was loaded.
 * @returns safe-to-log fields.
 */
export function describeState(state: CoordinatorState | undefined): Record<string, unknown> {
  if (state === undefined) return { loaded: false }
  const enrollment = state.enrollment
  return {
    loaded: true,
    nodes: state.nodes.length,
    revoked: state.nodes.filter(record => record.revokedAt !== undefined).length,
    apiToken: state.apiToken === undefined ? 'unset' : 'configured',
    enrollment: enrollment === undefined || enrollment.kind === 'closed'
      ? 'closed'
      : 'shared-secret',
  }
}
