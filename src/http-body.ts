/**
 * Shared HTTP plumbing: reading a JSON body and writing bodies safely.
 *
 * Split out of `http-api.ts` so `auth-http.ts` can use it without importing the
 * router that imports the auth layer — a cycle that would otherwise be resolved by
 * module ordering rather than by design.
 *
 * @module dsh-coordinator/http-body
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { CoordinatorError } from './errors.js'
import { isPlainObject } from './frame-codec.js'

/** Default ceiling on a request body. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/**
 * Read and parse a JSON body, refusing anything oversized or not an object.
 * @param request - the HTTP request.
 * @param maxBodyBytes - the ceiling.
 * @returns the parsed object, or `{}` for an empty body.
 * @throws CoordinatorError `coordinator/frame-too-large` or `coordinator/invalid-arguments`.
 */
export async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    bytes += buffer.byteLength
    if (bytes > maxBodyBytes) {
      throw new CoordinatorError('coordinator/frame-too-large', `the request body exceeds ${maxBodyBytes} bytes`, {
        maxBodyBytes,
      })
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CoordinatorError('coordinator/invalid-arguments', 'the request body is not valid JSON', {})
  }
  if (!isPlainObject(parsed)) {
    throw new CoordinatorError('coordinator/invalid-arguments', 'the request body must be a JSON object', {})
  }
  return parsed
}

/** Send one JSON body. */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text, 'utf8'),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/** Send one HTML body. */
export function sendHtml(response: ServerResponse, html: string): void {
  if (response.writableEnded) return
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html, 'utf8'),
    // The page is an operator console, not a document: a cached copy would keep
    // driving a service that has moved on.
    'cache-control': 'no-store',
  })
  response.end(html)
}

/** Send one static asset, with a content type chosen by extension. */
export function sendAsset(response: ServerResponse, path: string, body: string): void {
  if (response.writableEnded) return
  const type = path.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : path.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/plain; charset=utf-8'
  response.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(body, 'utf8'),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Redirect, with the status the contract fixes for an unauthenticated page. */
export function redirect(response: ServerResponse, location: string, status = 303): void {
  if (response.writableEnded) return
  response.writeHead(status, { location, 'cache-control': 'no-store' })
  response.end()
}
