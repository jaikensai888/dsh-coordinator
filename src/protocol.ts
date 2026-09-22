/**
 * The `dsh-node/1` wire protocol, as the **Coordinator** sees it.
 *
 * This is a deliberately independent implementation of the same protocol
 * `dsh-node` speaks. It does not import the node's types, and that is the point:
 * a second implementation only agrees with the first if the specification is
 * actually precise. Where the two disagree, the spec (and the node's
 * `docs/GROUND-TRUTH.md`) is the authority, and the disagreement is a bug in one
 * of them — most often a field the spec left implicit.
 *
 * Frame directions, from `dsh-node/1`:
 *
 * | Node -> Coordinator | `hello`, `ready`, `rpc.result`, `stream.ready`, `stream.data`, `stream.end`, `stream.error`, `ping`, `pong`, `close` |
 * | Coordinator -> Node | `hello.ok`, `rpc.request`, `rpc.cancel`, `stream.open`, `stream.cancel`, `ping`, `pong`, `close` |
 *
 * @module dsh-coordinator/protocol
 */

/** The only protocol version this build speaks. */
export const PROTOCOL_VERSION = 'dsh-node/1'

/** One connection state, from the Coordinator's side. */
export type NodeConnectionState =
  /** Socket accepted; `hello` not yet received. */
  | 'connecting'
  /** `hello` received and being validated. */
  | 'authenticating'
  /** `ready` received; the capability surface is known. */
  | 'ready'
  /** Closing on purpose. */
  | 'closing'
  /** Disconnected; the record survives so the lifecycle is observable. */
  | 'offline'

/** One advertised capability, as the node reports it. */
export interface NodeCapability {
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /** `unary` for `rpc.request`, `stream` for `stream.open`. */
  readonly mode: 'unary' | 'stream'
}

/** The `ready` frame's capability summary. */
export interface NodeCapabilitySummary {
  readonly remotes: readonly NodeCapability[]
  readonly remoteSurfaceHash: string
  /**
   * Every namespace the node will dispatch, whether or not it could enumerate the
   * methods inside it.
   *
   * Read it as a guarantee about the **negative**: a namespace absent from this
   * list is one the node will not dispatch at all, so {@link NodeRegistry} can
   * refuse it locally. Presence does not mean "this namespace has methods I could
   * not list" — a node may list a namespace whose methods it enumerated as well
   * (verified against a real `dsh-node`, whose `collectCapabilities` sends all
   * dispatchable namespaces; only the unenumerable subset feeds the digest). The
   * rule that follows is the safe one either way: for an endpoint missing from
   * `remotes`, forward it and let the node answer `node/capability-unavailable`
   * rather than inventing a method name or a carrier.
   */
  readonly namespaces: readonly string[]
}

/** Fields every frame carries. */
export interface BaseFrame {
  readonly type: string
  readonly protocolVersion: string
  readonly nodeId: string
  readonly messageId?: string
}

/** Node -> Coordinator: first frame on a fresh socket. */
export interface HelloFrame extends BaseFrame {
  readonly type: 'hello'
  readonly nodeName?: string
  readonly role?: string
  readonly mode: string
  readonly auth: { readonly type: string; readonly token: string }
  readonly dsh?: { readonly version?: string; readonly remoteSurfaceHash?: string }
}

/** Coordinator -> Node: handshake accepted. */
export interface HelloOkFrame extends BaseFrame {
  readonly type: 'hello.ok'
  /** Required: the node treats a missing `connectionId` as a fatal protocol error. */
  readonly connectionId: string
  readonly heartbeatIntervalMs?: number
  readonly maxFrameBytes?: number
  readonly acceptedMode?: string
}

/** Node -> Coordinator: serving requests. */
export interface ReadyFrame extends BaseFrame {
  readonly type: 'ready'
  readonly connectionId?: string
  readonly dsh?: { readonly version?: string; readonly remoteSurfaceHash?: string }
  readonly capabilities: NodeCapabilitySummary
}

/** Coordinator -> Node: invoke one unary Remote. */
export interface RpcRequestFrame extends BaseFrame {
  readonly type: 'rpc.request'
  readonly requestId: string
  readonly endpoint: string
  /** Exactly `{ args: <plain object> }`. */
  readonly payload: { readonly args: Readonly<Record<string, unknown>> }
}

/** Failure fields carried by a terminal frame. */
export interface NodeResultError {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

/** Node -> Coordinator: terminal result of one unary Remote. */
export interface RpcResultFrame extends BaseFrame {
  readonly type: 'rpc.result'
  readonly requestId: string
  /**
   * `value` is typed as required but **may be absent on the wire**: JSON cannot
   * represent `undefined`, so a Remote that returned nothing encodes as
   * `{ok:true}`. A reader must treat the missing key as `undefined` rather than as
   * a malformed frame — see `frame-codec.ts#validateBody`.
   */
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: NodeResultError }
}

/** Coordinator -> Node: abort one in-flight unary Remote. */
export interface RpcCancelFrame extends BaseFrame {
  readonly type: 'rpc.cancel'
  readonly requestId: string
  readonly reason?: string
}

/** Coordinator -> Node: open one stream Remote. */
export interface StreamOpenFrame extends BaseFrame {
  readonly type: 'stream.open'
  readonly streamId: string
  readonly requestId?: string
  readonly endpoint: string
  readonly payload: { readonly args: Readonly<Record<string, unknown>> }
}

/** Node -> Coordinator: the stream is open. No `stream.data` precedes it. */
export interface StreamReadyFrame extends BaseFrame {
  readonly type: 'stream.ready'
  readonly streamId: string
  readonly requestId?: string
}

/** Node -> Coordinator: one yielded value. `seq` starts at 1 and steps by 1. */
export interface StreamDataFrame extends BaseFrame {
  readonly type: 'stream.data'
  readonly streamId: string
  readonly seq: number
  /** Absent on the wire when the Remote yielded `undefined`; read the key, not the type. */
  readonly value: unknown
}

/** Node -> Coordinator: terminal, normal completion. */
export interface StreamEndFrame extends BaseFrame {
  readonly type: 'stream.end'
  readonly streamId: string
  readonly count: number
}

/** Node -> Coordinator: terminal, failure or node-side termination. */
export interface StreamErrorFrame extends BaseFrame {
  readonly type: 'stream.error'
  readonly streamId: string
  readonly error: NodeResultError
  readonly count: number
}

/** Coordinator -> Node: stop producing and release one stream. */
export interface StreamCancelFrame extends BaseFrame {
  readonly type: 'stream.cancel'
  readonly streamId: string
  readonly reason?: string
}

/** Either direction: liveness. */
export interface PingFrame extends BaseFrame {
  readonly type: 'ping'
}

/** Either direction: liveness answer. */
export interface PongFrame extends BaseFrame {
  readonly type: 'pong'
}

/** Either direction: going away. */
export interface CloseFrame extends BaseFrame {
  readonly type: 'close'
  readonly code?: string
  readonly reason?: string
  readonly reconnect?: boolean
}

/** Every frame the Coordinator may send. */
export type CoordinatorOutboundFrame =
  | HelloOkFrame
  | RpcRequestFrame
  | RpcCancelFrame
  | StreamOpenFrame
  | StreamCancelFrame
  | PingFrame
  | PongFrame
  | CloseFrame

/** Every frame the Coordinator may receive. */
export type NodeInboundFrame =
  | HelloFrame
  | ReadyFrame
  | RpcResultFrame
  | StreamReadyFrame
  | StreamDataFrame
  | StreamEndFrame
  | StreamErrorFrame
  | PingFrame
  | PongFrame
  | CloseFrame

/** Any frame of this protocol. */
export type AnyFrame = CoordinatorOutboundFrame | NodeInboundFrame

/** Frame types only a **node** may send. */
export const NODE_FRAME_TYPES: ReadonlySet<string> = new Set([
  'hello',
  'ready',
  'rpc.result',
  'stream.ready',
  'stream.data',
  'stream.end',
  'stream.error',
  'ping',
  'pong',
  'close',
])

/** Frame types only a **Coordinator** may send. */
export const COORDINATOR_FRAME_TYPES: ReadonlySet<string> = new Set([
  'hello.ok',
  'rpc.request',
  'rpc.cancel',
  'stream.open',
  'stream.cancel',
  'ping',
  'pong',
  'close',
])

/** Frame types this build implements at all. */
export const FRAME_TYPES: readonly string[] = [
  ...NODE_FRAME_TYPES,
  ...COORDINATOR_FRAME_TYPES,
].filter((type, index, all) => all.indexOf(type) === index)

/**
 * A node's registration record: the identity/credential binding.
 *
 * The critical security rule (spec §9.2): the token is bound to a `nodeId` on the
 * server, so a node cannot be admitted just by claiming an identity. `nodeName`
 * and `role` are display metadata and must never appear in an authorization
 * decision.
 */
export interface NodeRecord {
  /** Stable node identity the node persists across restarts. */
  readonly nodeId: string
  /** Expected bearer token. Never returned to any client. */
  readonly token: string
  /** Display metadata. Not an identity. */
  readonly nodeName?: string
  /** Display metadata. Not an identity. */
  readonly role?: string
  /** When set, handshakes for this node are refused. */
  readonly revokedAt?: string
}

/** A secret-free view of one node, safe to hand to a UI or an API response. */
export interface NodeView {
  readonly nodeId: string
  readonly nodeName?: string
  readonly role?: string
  readonly state: NodeConnectionState
  readonly connectionId?: string
  readonly connectedAt?: string
  /** ISO timestamp of the last successful handshake, retained across disconnects. */
  readonly lastSeenAt?: string
  /** Digest of the advertised surface, so a UI can show that it changed. */
  readonly remoteSurfaceHash?: string
  readonly capabilityCount: number
  /** Unary calls waiting for a `rpc.result`. */
  readonly inFlightRequests: number
  /** Streams the Coordinator considers open. */
  readonly activeStreams: number
  readonly revoked: boolean
}
