/**
 * `dsh-coordinator` — the server half of the `dsh-node/1` protocol.
 *
 * A DSH node dials **out** to this service; this service then forwards
 * structured Remote calls back down that connection. Nothing here dials a node,
 * and nothing here asks a node to listen on a port.
 *
 * Typical embedding:
 *
 * ```ts
 * import { Coordinator } from 'dsh-coordinator'
 *
 * const coordinator = new Coordinator({
 *   port: 39472,
 *   records: [{ nodeId: 'node-1', token: process.env.NODE_TOKEN! }],
 * })
 * await coordinator.start()
 * const value = await coordinator.invoke('node-1', 'pluginInventory/list', {})
 * ```
 *
 * The modules below are all public; the two a host usually needs are
 * {@link Coordinator} (the service) and {@link NodeRegistry} (the allowlist).
 *
 * @module dsh-coordinator
 */

export * from './protocol.js'
export * from './errors.js'
export * from './frame-codec.js'
export * from './log.js'
export * from './node-registry.js'
export * from './request-table.js'
export * from './session.js'
export * from './sessions.js'
export * from './state-file.js'
export * from './stream-hub.js'
export * from './timers.js'
export * from './ui.js'
export * from './server.js'
export * from './http-api.js'

/** Package version, for the CLI banner and for logs. */
export const COORDINATOR_VERSION = '0.1.0'
