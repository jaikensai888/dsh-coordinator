import { defineConfig } from 'vitest/config'

/**
 * `pool: 'threads'` — Vitest's default `forks` pool starts a child process per test
 * file with piped stdio, which a confined Windows sandbox rejects with
 * `spawn EPERM` (the suite then reports "no tests" before collecting anything).
 * Worker threads run in-process. The integration tests bind real loopback
 * WebSocket servers, which is in-process I/O and needs no extra permission.
 *
 * `fileParallelism: false` — the tests that bind a real listener cannot share a
 * machine safely: several files ask the OS for an ephemeral port, and
 * `cross-implementation.test.ts` deliberately *rebinds the exact port it just
 * released* (a node's Coordinator URL is fixed, so a restart is only observable by
 * a real node on the same port). Run concurrently, another file can be handed that
 * freed port in the gap, and the rebind fails with `EADDRINUSE` — observed once, in
 * roughly one run in ten. Sequential files remove the race instead of retrying
 * around it; the suite still finishes in about four seconds.
 */
export default defineConfig({
  test: {
    pool: 'threads',
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
