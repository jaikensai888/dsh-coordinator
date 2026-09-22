import type { UserConfig } from 'tsdown'

/**
 * `ws` stays a real import: bundling a WebSocket server into the entry would hide
 * a runtime dependency from `files`.
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
    external: ['ws'],
  },
] satisfies UserConfig[]
