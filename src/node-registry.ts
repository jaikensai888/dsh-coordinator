/**
 * The node registry: identity/credential bindings plus the live connection state.
 *
 * Two things are deliberately kept apart here:
 *
 * - **Record** — what the operator approved: a `nodeId`, its token, display
 *   metadata, and an optional revocation stamp. This is the authorization input.
 * - **View** — what a client may see: connection state, capability digest, and
 *   counters. Never the token, never anything derived from it.
 *
 * The rule from spec §9.2 is implemented literally: a token is only ever
 * accepted together with the `nodeId` it was issued for, and `nodeName` / `role`
 * never take part in an authorization decision.
 *
 * @module dsh-coordinator/node-registry
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { CoordinatorError } from './errors.js'
import type {
  NodeCapability,
  NodeCapabilitySummary,
  NodeConnectionState,
  NodeRecord,
  NodeView,
} from './protocol.js'

/** Default cap on registered nodes; a registry is an allowlist, not a crowd. */
export const DEFAULT_MAX_NODES = 256

/** How the registry learns about nodes it has never seen. */
export type EnrollmentPolicy =
  /** Only pre-registered `nodeId`s are accepted. The default. */
  | { readonly kind: 'closed' }
  /**
   * A node that presents {@link EnrollmentPolicy.token} as its bearer token is
   * registered on the spot, keeping that token.
   *
   * This exists because a node mints its own `nodeId` (it is persisted in the
   * node's identity file) before it ever talks to a Coordinator, so there is no
   * way for an operator to pre-register the id without reading it off the node
   * first. It is off by default because it means the shared secret alone admits
   * an unknown machine.
   */
  | { readonly kind: 'shared-secret'; readonly token: string }

/** Options for {@link NodeRegistry}. */
export interface NodeRegistryOptions {
  /** Nodes approved up front. */
  readonly records?: readonly NodeRecord[]
  /** Defaults to `{kind: 'closed'}`. */
  readonly enrollment?: EnrollmentPolicy
  /** Maximum number of records. Defaults to {@link DEFAULT_MAX_NODES}. */
  readonly maxNodes?: number
  /** Millisecond clock, injectable for tests. */
  readonly now?: () => number
  /**
   * Called after any change to the record list, so an embedder can persist it.
   *
   * The registry does **not** write credentials to disk itself: where a token
   * lives and who can read it is a deployment decision (spec §7), and a service
   * that silently drops bearer tokens into the working directory would be
   * making that decision by accident. A host that wants persistence passes
   * {@link onStateChanged} and owns the file.
   */
  readonly onRecordsChanged?: (records: readonly NodeRecord[]) => void
  /**
   * Called after any change that a persisted state file would need to record:
   * the record list, or the enrollment policy.
   *
   * Separate from {@link onRecordsChanged} because the enrollment secret is not a
   * record — it is the rule by which records come into existence — and a host
   * that persisted only the records would restore an allowlist nobody can join.
   */
  readonly onStateChanged?: () => void
}

/** Live connection facts the registry tracks per node. */
interface LiveState {
  connectionId: string
  state: NodeConnectionState
  connectedAt: string
  lastSeenAt: string
  surfaceHash?: string
  capabilities?: NodeCapabilitySummary
  inFlightRequests: number
  activeStreams: number
}

/** The outcome of a successful authentication. */
export interface AuthOutcome {
  readonly record: NodeRecord
  /** True when this handshake created the record (shared-secret enrollment). */
  readonly enrolled: boolean
  /**
   * True when the credential is **also** the enrollment secret, i.e. the
   * operator should rotate it to a per-node token.
   */
  readonly enrollmentSecret: boolean
}

/** The result of binding a capability summary to a connection. */
export interface CapabilityBinding {
  /** True when the advertised surface differs from the previous handshake. */
  readonly changed: boolean
  readonly previousHash?: string
  readonly remoteSurfaceHash: string
}

/**
 * Approved nodes plus their live connection state.
 *
 * Not a Map subclass: every mutation that touches a credential goes through a
 * named method so the audit surface is enumerable.
 */
export class NodeRegistry {
  readonly #records = new Map<string, NodeRecord>()
  readonly #live = new Map<string, LiveState>()
  /** Mutable: an operator may change the enrollment rule while the service runs. */
  #enrollment: EnrollmentPolicy
  readonly #maxNodes: number
  readonly #now: () => number
  readonly #onChanged: ((records: readonly NodeRecord[]) => void) | undefined
  readonly #onStateChanged: (() => void) | undefined

  /** @param options - registry configuration. */
  constructor(options: NodeRegistryOptions = {}) {
    this.#enrollment = options.enrollment ?? { kind: 'closed' }
    this.#maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
    this.#now = options.now ?? (() => Date.now())
    this.#onChanged = options.onRecordsChanged
    this.#onStateChanged = options.onStateChanged
    for (const record of options.records ?? []) this.addRecord(record)
  }

  /** Whether unknown nodes may enroll themselves. */
  get enrollmentPolicy(): EnrollmentPolicy {
    return this.#enrollment
  }

  /**
   * Replace the enrollment rule.
   *
   * Takes effect on the **next** handshake, not on connections already open: an
   * operator changing the secret has not thereby decided to eject the nodes that
   * enrolled under the old one, and doing so silently would look like a random
   * disconnect from the node's side. Revoking is the explicit way to eject.
   * @param policy - the new rule.
   */
  setEnrollment(policy: EnrollmentPolicy): void {
    if (policy.kind === 'shared-secret' && policy.token === '') {
      throw new CoordinatorError(
        'coordinator/invalid-arguments',
        'an enrollment secret must not be empty (use {kind: "closed"} to disable enrollment)',
        {},
      )
    }
    this.#enrollment = policy
    this.#notifyState()
    this.#notify()
  }

  /**
   * Whether a node could enroll right now.
   *
   * Deliberately reports the **fact**, never the secret: this is what a UI may
   * show. There is no getter for the secret itself anywhere on this class, so a
   * caller cannot leak one by accident.
   */
  get enrollmentOpen(): boolean {
    return this.#enrollment.kind === 'shared-secret' && this.#enrollment.token !== ''
  }

  /** Every approved node, including revoked ones, in insertion order. */
  records(): readonly NodeRecord[] {
    return [...this.#records.values()]
  }

  /** Look up one record, token included. Callers must not log the result. */
  record(nodeId: string): NodeRecord | undefined {
    return this.#records.get(nodeId)
  }

  /**
   * Approve a node, or replace an existing approval.
   * @param record - the identity/credential binding.
   * @returns the stored record.
   * @throws CoordinatorError `coordinator/invalid-arguments` on an empty id/token.
   */
  addRecord(record: NodeRecord): NodeRecord {
    const nodeId = record.nodeId.trim()
    if (nodeId === '') {
      throw new CoordinatorError('coordinator/invalid-arguments', 'a node record needs a non-empty nodeId', {})
    }
    if (record.token === '') {
      throw new CoordinatorError('coordinator/invalid-arguments', `node "${nodeId}" needs a non-empty token`, {
        nodeId,
      })
    }
    if (!this.#records.has(nodeId) && this.#records.size >= this.#maxNodes) {
      throw new CoordinatorError(
        'coordinator/registry-full',
        `the registry already holds ${this.#maxNodes} nodes`,
        { maxNodes: this.#maxNodes },
      )
    }
    const stored: NodeRecord = {
      nodeId,
      token: record.token,
      ...(record.nodeName === undefined ? {} : { nodeName: record.nodeName }),
      ...(record.role === undefined ? {} : { role: record.role }),
      ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    }
    this.#records.set(nodeId, stored)
    this.#notify()
    this.#notifyState()
    return stored
  }

  /**
   * Replace a node's token, keeping the rest of the record.
   * @param nodeId - the node to rotate.
   * @param token - the new token.
   * @returns the updated record.
   */
  rotateToken(nodeId: string, token: string): NodeRecord {
    const existing = this.#records.get(nodeId)
    if (existing === undefined) throw unknownNode(nodeId)
    return this.addRecord({ ...existing, token })
  }

  /**
   * Refuse future handshakes for a node.
   * @param nodeId - the node to revoke.
   * @returns the revoked record.
   */
  revoke(nodeId: string): NodeRecord {
    const existing = this.#records.get(nodeId)
    if (existing === undefined) throw unknownNode(nodeId)
    return this.addRecord({ ...existing, revokedAt: new Date(this.#now()).toISOString() })
  }

  /**
   * Re-approve a revoked node.
   * @param nodeId - the node to restore.
   * @returns the restored record.
   */
  restore(nodeId: string): NodeRecord {
    const existing = this.#records.get(nodeId)
    if (existing === undefined) throw unknownNode(nodeId)
    const { nodeId: id, token, nodeName, role } = existing
    return this.addRecord({
      nodeId: id,
      token,
      ...(nodeName === undefined ? {} : { nodeName }),
      ...(role === undefined ? {} : { role }),
    })
  }

  /**
   * Decide whether a `hello` may proceed.
   *
   * A revoked node, an unknown node, and a wrong token all produce the same
   * wire-level failure: telling an unauthenticated peer whether an id exists
   * would turn the handshake into a node-enumeration oracle. The distinction is
   * kept in `details.reason` for the operator's own log, which never leaves this
   * process.
   * @param input - the credential claim from the `hello` frame, plus the display
   * metadata the node volunteered. The metadata is **stored, never consulted**:
   * spec §9.2 keeps `nodeName` out of every authorization decision, and the only
   * reason to keep it at all is that a UI showing five raw uuids tells an operator
   * nothing about which machine is which.
   * @returns the accepted record.
   * @throws CoordinatorError `coordinator/auth-rejected`.
   */
  authenticate(input: {
    readonly nodeId: string
    readonly token: string
    readonly nodeName?: string
    readonly role?: string
  }): AuthOutcome {
    const record = this.#records.get(input.nodeId)
    if (record === undefined) {
      const policy = this.#enrollment
      if (policy.kind === 'shared-secret' && policy.token !== '' && tokensMatch(policy.token, input.token)) {
        const enrolled = this.addRecord({
          nodeId: input.nodeId,
          token: input.token,
          ...(input.nodeName === undefined ? {} : { nodeName: input.nodeName }),
          ...(input.role === undefined ? {} : { role: input.role }),
        })
        return { record: enrolled, enrolled: true, enrollmentSecret: true }
      }
      throw rejected('nodeId is not approved', { nodeId: input.nodeId, reason: 'unknown-node' })
    }
    if (record.revokedAt !== undefined) {
      throw rejected('the node has been revoked', {
        nodeId: input.nodeId,
        reason: 'revoked',
        revokedAt: record.revokedAt,
      })
    }
    if (!tokensMatch(record.token, input.token)) {
      throw rejected('the token does not match the registered credential', {
        nodeId: input.nodeId,
        reason: 'token-mismatch',
      })
    }
    /*
      Fill in a name this record never had, and never overwrite one it did.

      A record enrolled before this existed — or registered by hand without a name —
      stays anonymous forever otherwise, and the node is the only party that knows
      what to call itself. Overwriting is the other mistake: the operator's own name
      for a machine outranks the one the machine chose, and a node that renamed
      itself would silently change what the operator is looking at.
    */
    if (record.nodeName === undefined && input.nodeName !== undefined) {
      const named = this.addRecord({
        ...record,
        nodeName: input.nodeName,
        ...(record.role === undefined && input.role !== undefined ? { role: input.role } : {}),
      })
      return {
        record: named,
        enrolled: false,
        enrollmentSecret: this.#enrollment.kind === 'shared-secret' &&
          tokensMatch(this.#enrollment.token, input.token),
      }
    }
    const secret = this.#enrollment
    return {
      record,
      enrolled: false,
      enrollmentSecret: secret.kind === 'shared-secret' && tokensMatch(secret.token, input.token),
    }
  }

  /**
   * Record that a connection reached the `ready` state.
   * @param nodeId - the node.
   * @param connectionId - the id this Coordinator issued in `hello.ok`.
   * @param at - ISO timestamp of the handshake.
   * @returns the connection id it displaced, when a node reconnected.
   */
  bind(nodeId: string, connectionId: string, at: string): { replaced?: string } {
    const previous = this.#live.get(nodeId)
    this.#live.set(nodeId, {
      connectionId,
      state: 'ready',
      connectedAt: at,
      lastSeenAt: at,
      // The previous surface digest is carried over on purpose: `setCapabilities`
      // reports "the node's capabilities changed" by comparing against it, and a
      // node that just reconnected is exactly when that matters (a plugin was
      // installed, removed, or hot-reloaded). Dropping it here would make
      // `surfaceChanged` permanently false. The stale *capabilities* are not
      // carried over, so nothing can dispatch against a surface that this
      // connection has not confirmed yet.
      ...(previous?.surfaceHash === undefined ? {} : { surfaceHash: previous.surfaceHash }),
      inFlightRequests: 0,
      activeStreams: 0,
    })
    this.#notify()
    return previous === undefined || previous.connectionId === connectionId
      ? {}
      : { replaced: previous.connectionId }
  }

  /**
   * Record a state change for a live connection.
   * @param nodeId - the node.
   * @param connectionId - the connection the transition belongs to.
   * @param state - the new state.
   */
  setState(nodeId: string, connectionId: string, state: NodeConnectionState): void {
    const live = this.#live.get(nodeId)
    if (live === undefined || live.connectionId !== connectionId) return
    live.state = state
    this.#notify()
  }

  /**
   * Drop a connection's live state, keeping the record.
   *
   * A stale connection id is ignored: when a node reconnects, the old socket's
   * `close` arrives after the new connection is bound, and it must not erase the
   * live one (spec §14 item 8 — the reverse mistake, showing a disconnected node
   * as online forever, is what this method exists to prevent).
   * @param nodeId - the node.
   * @param connectionId - the connection that ended.
   * @returns true when the state belonged to that connection.
   */
  unbind(nodeId: string, connectionId: string): boolean {
    const live = this.#live.get(nodeId)
    if (live === undefined || live.connectionId !== connectionId) return false
    // Already offline: the retained view is not a live binding, so a repeated
    // call (a socket close arriving after a forced teardown, say) reports "this
    // call changed nothing" rather than pretending to have unbound again.
    if (live.state === 'offline') return false
    // Keep the offline view so `lastSeenAt` / `surfaceHash` survive a disconnect:
    // "was online five minutes ago" is exactly what an operator needs to know.
    this.#live.set(nodeId, { ...live, state: 'offline', inFlightRequests: 0, activeStreams: 0 })
    this.#notify()
    return true
  }

  /**
   * Store the capability surface reported by `ready`.
   * @param nodeId - the node.
   * @param connectionId - the connection the frame arrived on.
   * @param capabilities - the advertised summary.
   * @param at - ISO timestamp of the frame.
   * @returns whether the surface digest changed since the previous handshake.
   */
  setCapabilities(
    nodeId: string,
    connectionId: string,
    capabilities: NodeCapabilitySummary,
    at: string,
  ): CapabilityBinding {
    const live = this.#live.get(nodeId)
    if (live === undefined || live.connectionId !== connectionId) {
      throw new CoordinatorError('coordinator/node-offline', 'capabilities arrived for a connection that is not live', {
        nodeId,
        connectionId,
      })
    }
    const previousHash = live.surfaceHash
    live.surfaceHash = capabilities.remoteSurfaceHash
    live.capabilities = capabilities
    live.lastSeenAt = at
    this.#notify()
    return {
      changed: previousHash !== undefined && previousHash !== capabilities.remoteSurfaceHash,
      ...(previousHash === undefined ? {} : { previousHash }),
      remoteSurfaceHash: capabilities.remoteSurfaceHash,
    }
  }

  /**
   * Update the per-node counters a client sees.
   * @param nodeId - the node.
   * @param connectionId - the connection the counters belong to.
   * @param counters - current in-flight request and stream counts.
   */
  setCounters(
    nodeId: string,
    connectionId: string,
    counters: { readonly inFlightRequests: number; readonly activeStreams: number },
  ): void {
    const live = this.#live.get(nodeId)
    if (live === undefined || live.connectionId !== connectionId) return
    live.inFlightRequests = counters.inFlightRequests
    live.activeStreams = counters.activeStreams
    live.lastSeenAt = new Date(this.#now()).toISOString()
  }

  /** The connection id currently bound to a node, if any. */
  connectionIdOf(nodeId: string): string | undefined {
    return this.#live.get(nodeId)?.connectionId
  }

  /** Whether a node has a live `ready` connection. */
  isReady(nodeId: string): boolean {
    return this.#live.get(nodeId)?.state === 'ready'
  }

  /** The capability summary from the node's last `ready`, if it ever sent one. */
  capabilitiesOf(nodeId: string): NodeCapabilitySummary | undefined {
    return this.#live.get(nodeId)?.capabilities
  }

  /**
   * Resolve one endpoint against the node's advertised surface.
   *
   * Three outcomes, and the middle one is the interesting case:
   *
   * - the endpoint is advertised: the requested carrier must match its mode,
   *   otherwise the node would answer `gateway/signature-invalid`;
   * - the endpoint is *not* advertised but its namespace is one the node says it
   *   dispatches: the request goes through and the node decides (it answers
   *   `node/capability-unavailable` for a method that does not exist). This is the
   *   honest reading of `capabilities.namespaces`, which promises only that a
   *   namespace **absent** from it is never dispatched;
   * - otherwise this Coordinator would be guessing, so it refuses.
   * @param nodeId - the node to dispatch to.
   * @param endpoint - canonical `<namespace>/<method>`.
   * @param requestedMode - the carrier the caller wants to use.
   * @returns the resolved capability, or `undefined` for the unenumerated case.
   * @throws CoordinatorError `coordinator/capability-mismatch` or `node-offline`.
   */
  resolveCapability(nodeId: string, endpoint: string, requestedMode: NodeCapability['mode']): NodeCapability | undefined {
    const summary = this.#requireReady(nodeId)
    const advertised = summary.remotes.find(entry => entry.endpoint === endpoint)
    if (advertised !== undefined) {
      if (advertised.mode !== requestedMode) {
        throw new CoordinatorError(
          'coordinator/capability-mismatch',
          `"${endpoint}" is a ${advertised.mode} Remote; ${requestedMode} would be rejected by the node`,
          { nodeId, endpoint, expected: advertised.mode, requested: requestedMode },
        )
      }
      return advertised
    }
    const namespace = endpoint.slice(0, Math.max(0, endpoint.indexOf('/')))
    if (namespace !== '' && summary.namespaces.includes(namespace)) {
      // The node dispatches this namespace but did not advertise the method: it
      // owns the decision, and a miss comes back as `node/capability-unavailable`.
      return undefined
    }
    throw new CoordinatorError('coordinator/capability-mismatch', `"${endpoint}" is not advertised by the node`, {
      nodeId,
      endpoint,
      requested: requestedMode,
      knownNamespaces: summary.namespaces.length,
      advertised: summary.remotes.length,
    })
  }

  /**
   * The node's capability summary, or a failure explaining why there is none.
   * @param nodeId - the node to inspect.
   * @returns the summary from the current connection.
   */
  #requireReady(nodeId: string): NodeCapabilitySummary {
    const live = this.#live.get(nodeId)
    // A node can be approved and still have never dialled in. That is "offline",
    // not "unknown": the two are different operator problems, and reporting the
    // wrong one sends someone looking for a registration that already exists.
    if (live === undefined) {
      if (this.#records.has(nodeId)) {
        throw new CoordinatorError('coordinator/node-offline', `node "${nodeId}" has never connected`, { nodeId })
      }
      throw unknownNode(nodeId)
    }
    if (live.state !== 'ready' || live.capabilities === undefined) {
      throw new CoordinatorError('coordinator/node-offline', `node "${nodeId}" has no ready connection`, {
        nodeId,
        state: live.state,
      })
    }
    return live.capabilities
  }

  /** One secret-free view. */
  view(nodeId: string): NodeView | undefined {
    const record = this.#records.get(nodeId)
    if (record === undefined) return undefined
    const live = this.#live.get(nodeId)
    return {
      nodeId: record.nodeId,
      ...(record.nodeName === undefined ? {} : { nodeName: record.nodeName }),
      ...(record.role === undefined ? {} : { role: record.role }),
      state: live?.state ?? 'offline',
      ...(live === undefined || live.state === 'offline' ? {} : { connectionId: live.connectionId }),
      ...(live === undefined ? {} : { connectedAt: live.connectedAt, lastSeenAt: live.lastSeenAt }),
      ...(live?.surfaceHash === undefined ? {} : { remoteSurfaceHash: live.surfaceHash }),
      capabilityCount: live?.capabilities?.remotes.length ?? 0,
      inFlightRequests: live?.inFlightRequests ?? 0,
      activeStreams: live?.activeStreams ?? 0,
      revoked: record.revokedAt !== undefined,
    }
  }

  /** Every node, approved and revoked alike, connection state included. */
  list(): NodeView[] {
    return [...this.#records.keys()].map(nodeId => this.view(nodeId)).filter((view): view is NodeView => view !== undefined)
  }

  /** Notify the persistence hook, if one was configured. */
  #notify(): void {
    this.#onChanged?.(this.records())
  }

  /**
   * Notify the state-file hook.
   *
   * Called from exactly two places — a record being added, and the enrollment rule
   * changing — because those are the only changes a restored state file has to
   * capture. Connection churn (`bind`, `unbind`, `setCapabilities`) deliberately
   * does not reach here: a disk write per connect/disconnect would buy nothing,
   * since none of that survives a restart anyway.
   */
  #notifyState(): void {
    this.#onStateChanged?.()
  }
}

/** Compare two secrets without leaking their contents through timing. */
export function tokensMatch(expected: string, received: string): boolean {
  // Hash both sides first: `timingSafeEqual` requires equal lengths, and the
  // early return it would force on unequal lengths is itself the leak.
  const a = createHash('sha256').update(expected, 'utf8').digest()
  const b = createHash('sha256').update(received, 'utf8').digest()
  return timingSafeEqual(a, b)
}

function unknownNode(nodeId: string): CoordinatorError {
  return new CoordinatorError('coordinator/node-unknown', `no node "${nodeId}" is registered`, { nodeId })
}

function rejected(message: string, details: Record<string, unknown>): CoordinatorError {
  return new CoordinatorError('coordinator/auth-rejected', message, details)
}
