/**
 * The bundled console pages and their static assets.
 *
 * A Coordinator is only useful once somebody can watch a node answer, and the
 * shortest path to that is pages this service already serves: no second process,
 * no build step, no CORS, and no chance of the UI drifting onto a different port
 * than the API it calls.
 *
 * Two properties are deliberate:
 *
 * - **The page holds no secret.** The console is served to an authenticated
 *   session and contains no token; the login page is anonymous and contains no
 *   username. Every call the console makes still goes through the API's own check.
 * - **The file set is a whitelist, not a directory.** `/ui/usage.js` and
 *   `/ui/console.css` are the only assets, resolved from a fixed table. There is no
 *   path joining here, so `..%2f` and friends have nothing to escape from.
 *
 * @module dsh-coordinator/ui
 */

import { readFile } from 'node:fs/promises'
import { CoordinatorError } from './errors.js'

/** The path the console is served at. */
export const UI_PATH = '/ui'

/** The path the login page is served at. */
export const LOGIN_PATH = '/login'

/** Every additional static asset, keyed by the exact request path. */
export const UI_ASSETS: Readonly<Record<string, string>> = {
  '/ui/usage.js': 'usage.js',
  '/ui/console.css': 'console.css',
}

/**
 * Where the pages live, relative to this module.
 *
 * `../ui/index.html` resolves to the package root's `ui/` from both `src/` and
 * `lib/`, which is what lets the same code path serve tests and a built service.
 */
const UI_FILE = new URL('../ui/index.html', import.meta.url)
const LOGIN_FILE = new URL('../ui/login.html', import.meta.url)

/** Cached file text. Cleared on a failed read so a transient error is not sticky. */
const cache = new Map<string, Promise<string>>()

/**
 * Whether a request path asks for the console page.
 * @param path - the URL pathname.
 * @returns true for `/ui` and `/ui/`.
 */
export function isUiPath(path: string): boolean {
  return path === UI_PATH || path === `${UI_PATH}/`
}

/**
 * Whether a request path asks for one of the whitelisted assets.
 * @param path - the URL pathname.
 * @returns true for an exact asset path.
 */
export function isUiAssetPath(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(UI_ASSETS, path)
}

/**
 * Read the console page.
 * @returns the page's HTML.
 * @throws CoordinatorError `coordinator/internal` when the file cannot be read.
 */
export async function readUiHtml(): Promise<string> {
  return await readCached('index', UI_FILE)
}

/**
 * Read the login page.
 * @returns the page's HTML.
 * @throws CoordinatorError `coordinator/internal` when the file cannot be read.
 */
export async function readLoginHtml(): Promise<string> {
  return await readCached('login', LOGIN_FILE)
}

/**
 * Read one whitelisted asset.
 * @param path - the exact request path.
 * @returns the asset's text.
 * @throws CoordinatorError `coordinator/invalid-arguments` for an unlisted path.
 * @throws CoordinatorError `coordinator/internal` when the file cannot be read.
 */
export async function readUiAsset(path: string): Promise<string> {
  const name = UI_ASSETS[path]
  if (name === undefined) {
    throw new CoordinatorError('coordinator/invalid-arguments', `no such UI asset: ${path}`, { path })
  }
  return await readCached(name, new URL(`../ui/${name}`, import.meta.url))
}

/** Read one file, caching successes. */
async function readCached(key: string, url: URL): Promise<string> {
  const existing = cache.get(key)
  if (existing !== undefined) return await existing
  const pending = readFile(url, 'utf8')
  cache.set(key, pending)
  try {
    return await pending
  } catch (error) {
    cache.delete(key)
    throw new CoordinatorError(
      'coordinator/internal',
      `the UI file ${url.pathname} could not be read: ${(error as Error).message}`,
      { file: url.pathname },
    )
  }
}

/** Drop the cache, so the next request re-reads every file. Used by tests. */
export function resetUiCache(): void {
  cache.clear()
}
