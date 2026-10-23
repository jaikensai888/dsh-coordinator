import type { UserConfig } from 'tsdown'

/**
 * `ws` stays a real import: bundling a WebSocket server into the entry would hide
 * a runtime dependency from `files`.
 *
 * The SQLite drivers are external for the same reason and one more: they are
 * loaded with `createRequire` at runtime, so a bundler that tried to resolve them
 * would either fail the build (no `node:sqlite` on the build machine's resolution
 * graph) or, worse, inline a native module. `node:sqlite` is a built-in and
 * `better-sqlite3` is optional; both must stay unresolved at build time.
 *
 * `clean` is false on purpose — a running Coordinator holds `lib/*.js` open, and
 * on Windows removing the directory then fails with EPERM.
 */
export default [
  {
    entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: ['ws', 'node:sqlite', 'better-sqlite3'],
  },
] satisfies UserConfig[]
