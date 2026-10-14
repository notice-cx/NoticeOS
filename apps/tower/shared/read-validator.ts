/**
 * A read answered "unchanged" instead of in full. Every successful JSON read
 * carries a validator: a hash of what it says. A browser that sends that
 * validator back in `If-None-Match` and would receive the same content is
 * answered 304 with no body, and keeps the copy it holds. `no-store` stays:
 * the browser's own cache never holds a read; the page keeps its copy in
 * memory (`src/lib/read-copies.ts`). The parts the Worker, the local lanes and
 * the browser share are `scripts/read-validator.mts`.
 */

import { isAppApiPath } from './app-release';
import { ANSWER_TIMES_HEADER, namesValidator, splitAnswerTimes } from '../../../scripts/read-validator.mjs';

export { ANSWER_TIME_FIELDS, ANSWER_TIMES_HEADER, namesValidator, splitAnswerTimes, withAnswerTimes } from '../../../scripts/read-validator.mjs';

/** The validator of what a body says: a strong ETag naming the first 16
 * bytes of its SHA-256, in hex (`vite/lane.ts` computes the same in Node). */
export async function readValidator(content: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  let hex = '';
  for (const byte of digest.subarray(0, 16)) hex += byte.toString(16).padStart(2, '0');
  return `"${hex}"`;
}

/** Only a successful JSON GET of the app's API carries a validator. */
export function validatedRead(request: Request, response: Response): boolean {
  return request.method === 'GET' && response.status === 200 && isAppApiPath(new URL(request.url).pathname)
    && (response.headers.get('content-type') ?? '').startsWith('application/json');
}

/** The answer to a read: the response itself with its validator, or 304 when
 * the request already holds the same content. */
export async function withReadValidator(request: Request, response: Response): Promise<Response> {
  if (!validatedRead(request, response)) return response;
  const text = await response.text();
  const { content, times } = splitAnswerTimes(text);
  const validator = await readValidator(content);
  const headers = new Headers(response.headers);
  headers.set('etag', validator);
  headers.delete('content-length');
  headers.delete('content-encoding');
  if (namesValidator(request.headers.get('if-none-match'), validator)) {
    headers.delete('content-type');
    if (Object.keys(times).length > 0) headers.set(ANSWER_TIMES_HEADER, JSON.stringify(times));
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}
