/**
 * The registry is the authorization boundary and the only place a node
 * credential lives.
 *
 * These tests are written from the caller's side of that boundary:
 *
 * - a `hello` may be admitted only with the exact `nodeId`/token pair the
 *   operator approved, and the *wire* answer must not tell an unauthenticated
 *   peer whether an id exists — the difference is kept in `details.reason` for
 *   this process's own log;
 * - a connection id is a capability to change live state, so a socket that has
 *   already been replaced must not be able to unbind the one that replaced it;
 * - `view()` and `list()` are what a UI or an API response gets, and neither may
 *   contain a token.
 *
 * @module dsh-coordinator/test/node-registry
 */

import { describe, expect, it } from 'vitest'
import { CoordinatorError, isCoordinatorError } from '../src/errors.js'
import { NodeRegistry, tokensMatch } from '../src/node-registry.js'
import type { NodeCapabilitySummary, NodeRecord } from '../src/protocol.js'
import { sampleCapabilities } from './helpers.js'

/** A fixed handshake timestamp, so `lastSeenAt` assertions are exact. */
const AT = '2024-05-01T00:00:00.000Z'

/** The connection id a `hello.ok` would have issued for `alpha`. */
const CONNECTION = 'alpha:conn-1'

const TOKEN_ALPHA = 'token-alpha'
const TOKEN_BETA = 'token-beta'
const ENROLLMENT_SECRET = 'enroll-shared-secret'

const ALPHA: NodeRecord = { nodeId: 'alpha', token: TOKEN_ALPHA, nodeName: 'Alpha node', role: 'worker' }
const BETA: NodeRecord = { nodeId: 'beta', token: TOKEN_BETA }

/** Run `run`, expecting the registry to refuse, and return the failure. */
function thrownBy(run: () => unknown): CoordinatorError {
  try {
    run()
  } catch (error) {
    if (isCoordinatorError(error)) return error
    throw error
  }
  throw new Error('expected the call to throw a CoordinatorError')
}

/** A registry holding `alpha` and `beta`, both approved with distinct tokens. */
function twoNodes(): NodeRegistry {
  return new NodeRegistry({ records: [ALPHA, BETA] })
}

/** A registry whose `alpha` has completed `hello` and `ready`. */
function readyRegistryWith(capabilities: NodeCapabilitySummary): NodeRegistry {
  const registry = new NodeRegistry({ records: [ALPHA] })
  registry.bind('alpha', CONNECTION, AT)
  registry.setCapabilities('alpha', CONNECTION, capabilities, AT)
  return registry
}

/** A registry whose `alpha` is online with the sample capability surface. */
function readyRegistry(): NodeRegistry {
  return readyRegistryWith(sampleCapabilities())
}

describe('authenticate: the identity/credential binding', () => {
  it('accepts a token only together with the nodeId it was issued for', () => {
    const registry = twoNodes()
    const outcome = registry.authenticate({ nodeId: 'beta', token: TOKEN_BETA })
    expect(outcome.record.nodeId).toBe('beta')
    expect(outcome.enrolled).toBe(false)
    expect(outcome.enrollmentSecret).toBe(false)

    const error = thrownBy(() => registry.authenticate({ nodeId: 'beta', token: TOKEN_ALPHA }))
    expect(error.code).toBe('coordinator/auth-rejected')
  })

  it('answers an unknown node and a wrong token with the same failure code', () => {
    const registry = twoNodes()
    const unknown = thrownBy(() => registry.authenticate({ nodeId: 'ghost', token: TOKEN_ALPHA }))
    const mismatch = thrownBy(() => registry.authenticate({ nodeId: 'alpha', token: TOKEN_BETA }))
    expect(unknown.code).toBe('coordinator/auth-rejected')
    expect(mismatch.code).toBe(unknown.code)
  })

  it('keeps the reason that distinguishes an unknown node from a wrong token in the details', () => {
    const registry = twoNodes()
    const unknown = thrownBy(() => registry.authenticate({ nodeId: 'ghost', token: TOKEN_ALPHA }))
    const mismatch = thrownBy(() => registry.authenticate({ nodeId: 'alpha', token: TOKEN_BETA }))
    expect(unknown.details['reason']).toBe('unknown-node')
    expect(mismatch.details['reason']).toBe('token-mismatch')
    expect(unknown.details['nodeId']).toBe('ghost')
    expect(mismatch.details['nodeId']).toBe('alpha')
    // `details.reason` is what this process logs; flattening the two would cost
    // an operator the only signal that tells a typo from a stale credential.
    expect(unknown.message).not.toBe(mismatch.message)
  })

  it('refuses a node that was revoked even when its token is correct', () => {
    const registry = new NodeRegistry({ records: [ALPHA], now: () => Date.parse(AT) })
    expect(registry.revoke('alpha').revokedAt).toBe(AT)
    const error = thrownBy(() => registry.authenticate({ nodeId: 'alpha', token: TOKEN_ALPHA }))
    expect(error.code).toBe('coordinator/auth-rejected')
    expect(error.details).toMatchObject({ reason: 'revoked', revokedAt: AT })
    expect(registry.view('alpha')?.revoked).toBe(true)
  })

  it('restore re-admits a revoked node with the credential it already had', () => {
    const registry = new NodeRegistry({ records: [ALPHA] })
    registry.revoke('alpha')
    const restored = registry.restore('alpha')
    expect(restored.revokedAt).toBeUndefined()
    expect(restored.token).toBe(TOKEN_ALPHA)
    expect(registry.view('alpha')?.revoked).toBe(false)
    expect(registry.authenticate({ nodeId: 'alpha', token: TOKEN_ALPHA }).record.nodeId).toBe('alpha')
  })

  it('rotateToken replaces only the credential', () => {
    const registry = twoNodes()
    const rotated = registry.rotateToken('alpha', 'token-rotated')
    expect(rotated).toEqual({ nodeId: 'alpha', token: 'token-rotated', nodeName: 'Alpha node', role: 'worker' })
    expect(registry.records()).toHaveLength(2)
    expect(thrownBy(() => registry.authenticate({ nodeId: 'alpha', token: TOKEN_ALPHA })).details['reason']).toBe('token-mismatch')
    expect(registry.authenticate({ nodeId: 'alpha', token: 'token-rotated' }).record.nodeId).toBe('alpha')
    expect(registry.authenticate({ nodeId: 'beta', token: TOKEN_BETA }).record.token).toBe(TOKEN_BETA)
  })

  it('refuses to revoke, restore or rotate a node that was never registered', () => {
    const registry = twoNodes()
    expect(thrownBy(() => registry.revoke('ghost')).code).toBe('coordinator/node-unknown')
    expect(thrownBy(() => registry.restore('ghost')).code).toBe('coordinator/node-unknown')
    expect(thrownBy(() => registry.rotateToken('ghost', 'token')).code).toBe('coordinator/node-unknown')
  })
})

describe('authenticate: enrollment policy', () => {
  it('enrolls an unknown node that presents the shared enrollment secret', () => {
    const registry = new NodeRegistry({ enrollment: { kind: 'shared-secret', token: ENROLLMENT_SECRET } })
    const outcome = registry.authenticate({ nodeId: 'gamma', token: ENROLLMENT_SECRET })
    expect(outcome).toMatchObject({ enrolled: true, enrollmentSecret: true })
    expect(outcome.record).toEqual({ nodeId: 'gamma', token: ENROLLMENT_SECRET })
    expect(registry.records().map(record => record.nodeId)).toEqual(['gamma'])

    const again = registry.authenticate({ nodeId: 'gamma', token: ENROLLMENT_SECRET })
    expect(again).toMatchObject({ enrolled: false, enrollmentSecret: true })
  })

  it('refuses an unknown node that presents anything but the shared secret', () => {
    const registry = new NodeRegistry({ enrollment: { kind: 'shared-secret', token: ENROLLMENT_SECRET } })
    const error = thrownBy(() => registry.authenticate({ nodeId: 'gamma', token: 'a-guess' }))
    expect(error.code).toBe('coordinator/auth-rejected')
    expect(error.details['reason']).toBe('unknown-node')
    expect(registry.records()).toEqual([])
  })

  it('never enrolls anyone when the configured enrollment secret is empty', () => {
    const registry = new NodeRegistry({ enrollment: { kind: 'shared-secret', token: '' } })
    expect(thrownBy(() => registry.authenticate({ nodeId: 'ghost', token: '' })).details['reason']).toBe('unknown-node')
    expect(thrownBy(() => registry.authenticate({ nodeId: 'ghost', token: 'anything' })).details['reason']).toBe('unknown-node')
    expect(registry.records()).toEqual([])
  })

  it('never enrolls an unknown node under closed enrollment', () => {
    const registry = twoNodes()
    expect(registry.enrollmentPolicy).toEqual({ kind: 'closed' })
    expect(thrownBy(() => registry.authenticate({ nodeId: 'ghost', token: TOKEN_ALPHA })).details['reason']).toBe('unknown-node')
    expect(thrownBy(() => registry.authenticate({ nodeId: 'ghost', token: '' })).details['reason']).toBe('unknown-node')
    expect(registry.records()).toHaveLength(2)
  })

  it('does not let the enrollment secret stand in for a registered node credential', () => {
    const registry = new NodeRegistry({
      records: [ALPHA],
      enrollment: { kind: 'shared-secret', token: ENROLLMENT_SECRET },
    })
    const error = thrownBy(() => registry.authenticate({ nodeId: 'alpha', token: ENROLLMENT_SECRET }))
    expect(error.code).toBe('coordinator/auth-rejected')
    expect(error.details['reason']).toBe('token-mismatch')
  })

  it('refuses to enroll past the registry cap', () => {
    const registry = new NodeRegistry({ maxNodes: 1, enrollment: { kind: 'shared-secret', token: ENROLLMENT_SECRET } })
    expect(registry.authenticate({ nodeId: 'gamma', token: ENROLLMENT_SECRET }).enrolled).toBe(true)
    const error = thrownBy(() => registry.authenticate({ nodeId: 'delta', token: ENROLLMENT_SECRET }))
    expect(error.code).toBe('coordinator/registry-full')
    expect(registry.records().map(record => record.nodeId)).toEqual(['gamma'])
  })
})

describe('record management', () => {
  it('refuses a record with an empty nodeId or token', () => {
    const registry = new NodeRegistry()
    expect(thrownBy(() => registry.addRecord({ nodeId: '', token: 'token' })).code).toBe('coordinator/invalid-arguments')
    expect(thrownBy(() => registry.addRecord({ nodeId: '   ', token: 'token' })).code).toBe('coordinator/invalid-arguments')
    const emptyToken = thrownBy(() => registry.addRecord({ nodeId: 'alpha', token: '' }))
    expect(emptyToken.code).toBe('coordinator/invalid-arguments')
    expect(emptyToken.details).toEqual({ nodeId: 'alpha' })
    expect(registry.records()).toEqual([])
  })

  it('stores the nodeId trimmed so the identity a caller looks up is the identity stored', () => {
    const registry = new NodeRegistry()
    expect(registry.addRecord({ nodeId: '  alpha  ', token: TOKEN_ALPHA }).nodeId).toBe('alpha')
    expect(registry.record('alpha')?.token).toBe(TOKEN_ALPHA)
    expect(registry.view('alpha')?.nodeId).toBe('alpha')
    expect(registry.authenticate({ nodeId: 'alpha', token: TOKEN_ALPHA }).record.nodeId).toBe('alpha')
  })

  it('replaces the approval of a node that is added twice instead of duplicating it', () => {
    const registry = new NodeRegistry({ records: [ALPHA] })
    registry.addRecord({ nodeId: 'alpha', token: 'token-second', nodeName: 'Alpha again' })
    expect(registry.records()).toEqual([{ nodeId: 'alpha', token: 'token-second', nodeName: 'Alpha again' }])
    expect(registry.authenticate({ nodeId: 'alpha', token: 'token-second' }).record.token).toBe('token-second')
    expect(thrownBy(() => registry.authenticate({ nodeId: 'alpha', token: TOKEN_ALPHA })).details['reason']).toBe('token-mismatch')
  })

  it('refuses a new node once the registry is full but still allows replacing one', () => {
    const registry = new NodeRegistry({ maxNodes: 1 })
    registry.addRecord(ALPHA)
    const error = thrownBy(() => registry.addRecord(BETA))
    expect(error.code).toBe('coordinator/registry-full')
    expect(error.details).toEqual({ maxNodes: 1 })
    expect(() => registry.addRecord({ nodeId: 'alpha', token: 'token-rotated' })).not.toThrow()
    // `addRecord` replaces the approval wholesale rather than merging into it.
    expect(registry.records()).toEqual([{ nodeId: 'alpha', token: 'token-rotated' }])
  })

  it('notifies the persistence hook whenever the record list changes', () => {
    const seen: (readonly NodeRecord[])[] = []
    const registry = new NodeRegistry({ onRecordsChanged: records => { seen.push(records) } })
    registry.addRecord(ALPHA)
    registry.rotateToken('alpha', 'token-rotated')
    registry.revoke('alpha')
    registry.restore('alpha')
    expect(seen.map(records => records.length)).toEqual([1, 1, 1, 1])
    expect(seen[1]?.map(record => record.token)).toEqual(['token-rotated'])
    expect(seen[2]?.[0]?.revokedAt).toBeTypeOf('string')
  })

  it('compares tokens of any length without throwing or shortcutting on length', () => {
    expect(tokensMatch('secret', 'secret')).toBe(true)
    expect(tokensMatch('secret', 'secret-longer')).toBe(false)
    expect(tokensMatch('secret', '')).toBe(false)
    expect(tokensMatch('', '')).toBe(true)
    expect(tokensMatch('', 'secret')).toBe(false)
  })
})

describe('resolveCapability', () => {
  it('returns the advertised capability for the carrier the node declared', () => {
    const registry = readyRegistry()
    expect(registry.resolveCapability('alpha', 'pluginInventory/list', 'unary')).toEqual({
      endpoint: 'pluginInventory/list',
      mode: 'unary',
    })
    expect(registry.resolveCapability('alpha', 'session/watch', 'stream')).toEqual({
      endpoint: 'session/watch',
      mode: 'stream',
    })
  })

  it('refuses a carrier that contradicts the advertised mode', () => {
    const registry = readyRegistry()
    const unaryAsStream = thrownBy(() => registry.resolveCapability('alpha', 'pluginInventory/list', 'stream'))
    expect(unaryAsStream.code).toBe('coordinator/capability-mismatch')
    expect(unaryAsStream.details).toMatchObject({
      nodeId: 'alpha',
      endpoint: 'pluginInventory/list',
      expected: 'unary',
      requested: 'stream',
    })

    const streamAsUnary = thrownBy(() => registry.resolveCapability('alpha', 'session/watch', 'unary'))
    expect(streamAsUnary.code).toBe('coordinator/capability-mismatch')
    expect(streamAsUnary.details).toMatchObject({ expected: 'stream', requested: 'unary' })
  })

  it('allows a method the node never enumerated inside an advertised namespace', () => {
    const registry = readyRegistryWith({ ...sampleCapabilities(), namespaces: ['dynamic'] })
    expect(registry.resolveCapability('alpha', 'dynamic/anything', 'unary')).toBeUndefined()
    expect(registry.resolveCapability('alpha', 'dynamic/anything-at-all', 'stream')).toBeUndefined()
  })

  it('refuses an endpoint outside every namespace the node advertised', () => {
    const registry = readyRegistry()
    const error = thrownBy(() => registry.resolveCapability('alpha', 'unknown/method', 'unary'))
    expect(error.code).toBe('coordinator/capability-mismatch')
    expect(error.details).toMatchObject({ nodeId: 'alpha', endpoint: 'unknown/method', requested: 'unary' })
    // A bare namespace is not a method, and asking for it must not be guessed at.
    expect(thrownBy(() => registry.resolveCapability('alpha', 'pluginInventory', 'unary')).code).toBe('coordinator/capability-mismatch')
  })

  it('reports a connection that is not ready as offline', () => {
    const registry = new NodeRegistry({ records: [ALPHA] })
    registry.bind('alpha', CONNECTION, AT)
    // Bound, but no `ready` frame has described a surface yet.
    const notReady = thrownBy(() => registry.resolveCapability('alpha', 'pluginInventory/list', 'unary'))
    expect(notReady.code).toBe('coordinator/node-offline')
    expect(notReady.details).toMatchObject({ nodeId: 'alpha', state: 'ready' })

    registry.setCapabilities('alpha', CONNECTION, sampleCapabilities(), AT)
    expect(registry.unbind('alpha', CONNECTION)).toBe(true)
    const offline = thrownBy(() => registry.resolveCapability('alpha', 'pluginInventory/list', 'unary'))
    expect(offline.code).toBe('coordinator/node-offline')
    expect(offline.details).toMatchObject({ nodeId: 'alpha', state: 'offline' })
  })

  it('reports a nodeId nobody approved as unknown', () => {
    const registry = readyRegistry()
    const error = thrownBy(() => registry.resolveCapability('ghost', 'pluginInventory/list', 'unary'))
    expect(error.code).toBe('coordinator/node-unknown')
    expect(error.details).toEqual({ nodeId: 'ghost' })
  })
})

describe('bind, unbind and live state', () => {
  it('reports the connection a reconnect displaced', () => {
    const registry = new NodeRegistry({ records: [ALPHA] })
    expect(registry.bind('alpha', CONNECTION, AT)).toEqual({})
    expect(registry.connectionIdOf('alpha')).toBe(CONNECTION)
    expect(registry.bind('alpha', CONNECTION, AT)).toEqual({})
    expect(registry.bind('alpha', 'alpha:conn-2', AT)).toEqual({ replaced: CONNECTION })
    expect(registry.connectionIdOf('alpha')).toBe('alpha:conn-2')
  })

  it('lets a stale connection id neither unbind nor restate the live connection', () => {
    const registry = readyRegistry()
    registry.bind('alpha', 'alpha:conn-2', AT)
    const stale = CONNECTION

    expect(registry.unbind('alpha', stale)).toBe(false)
    expect(registry.isReady('alpha')).toBe(true)
    expect(registry.connectionIdOf('alpha')).toBe('alpha:conn-2')
    expect(registry.view('alpha')?.state).toBe('ready')
    expect(registry.view('alpha')?.connectionId).toBe('alpha:conn-2')

    registry.setState('alpha', stale, 'closing')
    expect(registry.view('alpha')?.state).toBe('ready')
    expect(thrownBy(() => registry.setCapabilities('alpha', stale, sampleCapabilities(), AT)).code).toBe('coordinator/node-offline')
    expect(registry.unbind('alpha', 'alpha:conn-2')).toBe(true)
    expect(registry.view('alpha')?.state).toBe('offline')
  })

  it('reports a disconnect while keeping the last handshake time', () => {
    const registry = readyRegistry()
    expect(registry.unbind('alpha', CONNECTION)).toBe(true)
    const view = registry.view('alpha')
    expect(view).toMatchObject({ nodeId: 'alpha', state: 'offline', connectedAt: AT, lastSeenAt: AT })
    expect(view?.connectionId).toBeUndefined()
    expect(registry.isReady('alpha')).toBe(false)
    // A connection id that never belonged to the node, and a node nobody
    // approved, are both reported as "not yours to drop".
    expect(registry.unbind('alpha', 'alpha:stale')).toBe(false)
    expect(registry.unbind('ghost', CONNECTION)).toBe(false)
  })

  it('resets the per-node counters when the connection ends', () => {
    const registry = readyRegistry()
    registry.setCounters('alpha', CONNECTION, { inFlightRequests: 3, activeStreams: 2 })
    expect(registry.view('alpha')).toMatchObject({ inFlightRequests: 3, activeStreams: 2 })

    registry.setCounters('alpha', 'alpha:stale', { inFlightRequests: 9, activeStreams: 9 })
    expect(registry.view('alpha')).toMatchObject({ inFlightRequests: 3, activeStreams: 2 })

    registry.unbind('alpha', CONNECTION)
    expect(registry.view('alpha')).toMatchObject({ inFlightRequests: 0, activeStreams: 0 })
  })

  it('reports a surface change only when the advertised hash differs', () => {
    const registry = new NodeRegistry({ records: [ALPHA] })
    registry.bind('alpha', CONNECTION, AT)

    const first = registry.setCapabilities('alpha', CONNECTION, sampleCapabilities(), AT)
    expect(first.changed).toBe(false)
    expect(first.previousHash).toBeUndefined()
    expect(first.remoteSurfaceHash).toBe('surface-1')
    expect(registry.view('alpha')).toMatchObject({ remoteSurfaceHash: 'surface-1', capabilityCount: 2 })

    const changed = registry.setCapabilities('alpha', CONNECTION, { ...sampleCapabilities(), remoteSurfaceHash: 'surface-2' }, AT)
    expect(changed).toEqual({ changed: true, previousHash: 'surface-1', remoteSurfaceHash: 'surface-2' })
    expect(registry.view('alpha')).toMatchObject({ remoteSurfaceHash: 'surface-2' })

    const unchanged = registry.setCapabilities('alpha', CONNECTION, { ...sampleCapabilities(), remoteSurfaceHash: 'surface-2' }, AT)
    expect(unchanged).toMatchObject({ changed: false, previousHash: 'surface-2' })
  })

  it('refuses capabilities for a connection that is not live', () => {
    const registry = new NodeRegistry({ records: [ALPHA] })
    registry.bind('alpha', CONNECTION, AT)
    expect(thrownBy(() => registry.setCapabilities('alpha', 'alpha:stale', sampleCapabilities(), AT)).code).toBe(
      'coordinator/node-offline',
    )
    expect(thrownBy(() => registry.setCapabilities('ghost', CONNECTION, sampleCapabilities(), AT)).code).toBe(
      'coordinator/node-offline',
    )
    expect(registry.capabilitiesOf('alpha')).toBeUndefined()
    expect(registry.capabilitiesOf('ghost')).toBeUndefined()
  })
})

describe('views', () => {
  it('never exposes the node token or anything derived from it', () => {
    const secret = 'tok-view-must-not-carry-this'
    const registry = new NodeRegistry({ records: [{ nodeId: 'alpha', token: secret, nodeName: 'Alpha node', role: 'worker' }] })
    registry.bind('alpha', CONNECTION, AT)
    registry.setCapabilities('alpha', CONNECTION, sampleCapabilities(), AT)

    const view = registry.view('alpha')
    expect(view).toEqual({
      nodeId: 'alpha',
      nodeName: 'Alpha node',
      role: 'worker',
      state: 'ready',
      connectionId: CONNECTION,
      connectedAt: AT,
      lastSeenAt: AT,
      remoteSurfaceHash: 'surface-1',
      capabilityCount: 2,
      inFlightRequests: 0,
      activeStreams: 0,
      revoked: false,
    })
    expect(Object.keys(view ?? {})).not.toContain('token')
    expect(JSON.stringify(view)).not.toContain(secret)
    expect(JSON.stringify(registry.list())).not.toContain(secret)
    expect(JSON.stringify(registry.view('alpha'))).not.toContain(secret)

    // The credential stays reachable through the API that is meant to hold it.
    expect(registry.record('alpha')?.token).toBe(secret)
  })

  it('lists every approved node with its connection state and no view for an unknown id', () => {
    const registry = new NodeRegistry({ records: [ALPHA, BETA] })
    registry.bind('alpha', CONNECTION, AT)
    expect(registry.view('ghost')).toBeUndefined()
    expect(registry.list().map(view => ({ nodeId: view.nodeId, state: view.state, revoked: view.revoked }))).toEqual([
      { nodeId: 'alpha', state: 'ready', revoked: false },
      { nodeId: 'beta', state: 'offline', revoked: false },
    ])
    registry.revoke('beta')
    expect(registry.list().map(view => view.revoked)).toEqual([false, true])
    expect(registry.list()).toHaveLength(2)
  })
})
