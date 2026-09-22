/**
 * The bundled single-page UI.
 *
 * A Coordinator is only useful once somebody can watch a node answer, and the
 * shortest path to that is a page this service already serves: no second process,
 * no build step, no CORS, and no chance of the UI drifting onto a different port
 * than the API it calls.
 *
 * Two properties are deliberate:
 *
 * - **The page holds no secret.** It is served without the API bearer token,
 *   because a browser navigation cannot carry one. Every call the page makes still
 *   goes through the token check, and the page asks the operator for the token when
 *   the API demands one.
 * - **The file is read from disk at first request, not embedded in the bundle.**
 *   Embedding it would mean rebuilding the service to change a label. The path is
 *   resolved relative to this module, so it works both from `src/` under test and
 *   from `lib/` once built.
 *
 * @module dsh-coordinator/ui
 */

import { readFile } from 'node:fs/promises'
import { CoordinatorError } from './errors.js'

/** The path the UI is served at. */
export const UI_PATH = '/ui'

/**
 * Where the page lives, relative to this module.
 *
 * `../ui/index.html` resolves to the package root's `ui/` from both `src/` and
 * `lib/`, which is what lets the same code path serve tests and a built service.
 */
const UI_FILE = new URL('../ui/index.html', import.meta.url)

/** Cached page text. Cleared on a failed read so a transient error is not sticky. */
let cached: Promise<string> | undefined

/**
 * Whether a request path asks for the UI.
 * @param path - the URL pathname.
 * @returns true for `/ui` and `/ui/`.
 */
export function isUiPath(path: string): boolean {
  return path === UI_PATH || path === `${UI_PATH}/`
}

/**
 * Read the UI page.
 *
 * Cached after the first successful read: it is a static asset, and re-reading it
 * per request would put the disk on the critical path of every page load for no
 * benefit.
 * @returns the page's HTML.
 * @throws CoordinatorError `coordinator/internal` when the file cannot be read,
 * which means the package was built without its `ui/` directory.
 */
export async function readUiHtml(): Promise<string> {
  const pending = cached ?? (cached = readFile(UI_FILE, 'utf8'))
  try {
    return await pending
  } catch (error) {
    if (cached === pending) cached = undefined
    throw new CoordinatorError(
      'coordinator/internal',
      `the UI page could not be read: ${(error as Error).message}`,
      { file: UI_FILE.pathname },
    )
  }
}

/** Drop the cache, so the next request re-reads the file. Used by tests. */
export function resetUiCache(): void {
  cached = undefined
}
