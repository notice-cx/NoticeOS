// The task service: an Ntasks Worker that holds this installation's tasks
// (docs/11-integrations.md#ntasks). Its service credential is used only in
// this Worker; routes/task-service.ts is how the Node side reaches it.

import type { ConnectionFailure, ProbeResult } from '@noticeos/contract';
import { isLocalAddress } from './local-model.js';

export const NTASKS_URL = 'NTASKS_URL';
export const NTASKS_TOKEN = 'NTASKS_TOKEN';
/** One Ntasks answer, at most: a board of a large project fits well inside it. */
const RESPONSE_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export class TaskServiceError extends Error {
  constructor(readonly failure: ConnectionFailure) { super(`Ntasks: ${failure.kind}.`); this.name = 'TaskServiceError'; }
}

/** HTTPS, or HTTP to a local address; no password, path, query or fragment. */
export function ntasksOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new TaskServiceError({ kind: 'configuration' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/+$/u, '') !== '' || (url.protocol === 'http:' && !isLocalAddress(url.hostname))) {
    throw new TaskServiceError({ kind: 'configuration' });
  }
  return url.origin;
}

export interface TaskServiceCall {
  readonly method: string;
  /** An Ntasks path with its query, such as `/api/tasks?project=…`. */
  readonly path: string;
  readonly body?: string;
  readonly idempotencyKey?: string;
}

/** What the caller learns: Ntasks's own status and JSON body, or why it did not answer. */
export type TaskServiceAnswer =
  | { readonly answered: true; readonly status: number; readonly body: unknown }
  | { readonly answered: false; readonly reason: 'not-connected' | ConnectionFailure['kind']; readonly status?: number };

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_BYTES) { await response.body?.cancel(); throw new TaskServiceError({ kind: 'too-large' }); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > RESPONSE_BYTES) { await reader.cancel(); throw new TaskServiceError({ kind: 'too-large' }); }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

/** One call to Ntasks with these connection fields. Throws TaskServiceError
 * when Ntasks gave no answer this caller can read. */
export async function callNtasks(fields: Record<string, string>, call: TaskServiceCall,
  fetchImpl: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
  const origin = ntasksOrigin(fields[NTASKS_URL] ?? '');
  const token = fields[NTASKS_TOKEN]?.trim();
  if (!token) throw new TaskServiceError({ kind: 'configuration' });
  const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${token}` });
  if (call.body !== undefined) headers.set('content-type', 'application/json');
  if (call.idempotencyKey !== undefined) headers.set('idempotency-key', call.idempotencyKey);
  // Stateless MCP: every call names the protocol version instead of a handshake.
  if (call.path === '/api/mcp') { headers.set('mcp-protocol-version', '2025-06-18'); headers.set('accept', 'application/json, text/event-stream'); }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let response: Response;
    try {
      // workerd does not support redirect: 'error'; manual keeps the credential off a redirect's target.
      response = await fetchImpl(`${origin}${call.path}`, { method: call.method, headers, redirect: 'manual', signal: controller.signal,
        ...(call.body === undefined ? {} : { body: call.body }) });
    } catch { throw new TaskServiceError({ kind: timedOut ? 'timeout' : 'network' }); }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new TaskServiceError({ kind: 'redirect', status: response.status });
    }
    let text: string;
    try { text = await boundedText(response); } catch (error) {
      if (error instanceof TaskServiceError) throw error;
      throw new TaskServiceError({ kind: timedOut ? 'timeout' : 'network' });
    }
    let body: unknown = null;
    if (text !== '') {
      try { body = JSON.parse(text); } catch { throw new TaskServiceError({ kind: 'invalid-response', status: response.status }); }
    }
    return { status: response.status, body };
  } finally { clearTimeout(timer); }
}

/** The connection test and the connect panel's proof: the projects the credential reaches. */
export async function checkNtasks(fields: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const { status, body } = await callNtasks(fields, { method: 'GET', path: '/api/tasks/projects' }, fetchImpl);
    if (status === 401 || status === 403) return { outcome: 'refused', fix: { kind: 'replace' }, failure: { kind: 'access', status } };
    const projects = (body as { projects?: unknown } | null)?.projects;
    if (status !== 200 || !Array.isArray(projects)) return { outcome: 'unreachable', failure: { kind: status === 200 ? 'invalid-response' : 'http', status } };
    return { outcome: 'answered', facts: { projects: projects.length } };
  } catch (error) {
    if (error instanceof TaskServiceError && error.failure.kind === 'configuration') return { outcome: 'invalid', failing: ['Ntasks address'], failure: error.failure };
    return { outcome: 'unreachable', ...(error instanceof TaskServiceError ? { failure: error.failure } : {}) };
  }
}
