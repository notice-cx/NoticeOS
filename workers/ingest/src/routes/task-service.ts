// POST /api/task-service: one call to this installation's Ntasks Worker
// (../ntasks.ts), with the service credential added here, where it is
// opened. Every Node caller (the local MCP, the Tower's task routes, the
// runner) reaches Ntasks this way, with the operator bearer.

import { workspaceProfile } from '../../../../scripts/product-env.mjs';
import { authenticateOperator } from '../auth.js';
import { resolveCredential, saveNtasksAppClientId } from '../credentials.js';
import { callNtasks, NTASKS_URL, ntasksAppClientId, ntasksOrigin, ON_BEHALF_OF, registerNtasksApp, TaskServiceError, type TaskServiceAnswer, type TaskServiceCall } from '../ntasks.js';
import { json } from '../responses.js';

export const TASK_SERVICE_PATH = '/api/task-service';
export const TASK_SERVICE_APP_PATH = '/api/task-service/app';
/** Where Ntasks returns a person's browser: the Tower's sign-in page, at the origin it is served from. */
const SIGNED_IN_PATH = '/tasks/signed-in';
const REQUEST_BYTES = 512 * 1024;
const METHODS = new Set(['GET', 'POST', 'PATCH']);
/** The Ntasks routes a caller may name: the MCP endpoint, the task routes, the change feed and the backup route. */
const PATH = /^\/api\/(?:mcp|changes|backup|tasks(?:\/[A-Za-z0-9._-]+){0,2}|gates\/[A-Za-z0-9._-]+\/resolve)$/u;
const QUERY = /^[A-Za-z0-9._~%&=,+-]*$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function readCall(value: unknown): TaskServiceCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { method, path, body, idempotencyKey, onBehalfOf, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || typeof method !== 'string' || !METHODS.has(method) || typeof path !== 'string') return null;
  const [pathname = '', query = ''] = path.split(/\?(.*)/su);
  if (!PATH.test(pathname) || !QUERY.test(query)) return null;
  if (body !== undefined && (typeof body !== 'string' || method === 'GET' || new TextEncoder().encode(body).byteLength > REQUEST_BYTES)) return null;
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey) || method === 'GET')) return null;
  if (onBehalfOf !== undefined && (typeof onBehalfOf !== 'string' || !ON_BEHALF_OF.test(onBehalfOf))) return null;
  return { method, path, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(onBehalfOf === undefined ? {} : { onBehalfOf }) };
}

/**
 * GET /api/task-service: whether a task service is connected, where, and the
 * Tower's connected-app client id there.
 * POST /api/task-service: one call to it ({ method, path, body?, idempotencyKey?, onBehalfOf? }).
 * Operator-authenticated and standalone only. The answer is always 200 with
 * a TaskServiceAnswer, so a caller tells Ntasks's own 404 from this route's.
 */
export async function handleTaskService(request: Request, env: IngestEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (workspaceProfile(env) !== 'standalone' || request.headers.has('origin')) return json({ error: 'forbidden' }, 403);
  if (!env.OPERATOR_TOKEN || !(await authenticateOperator(request, env.OPERATOR_TOKEN))) return json({ error: 'unauthorized' }, 401);
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const resolved = await resolveCredential(env, 'ntasks', 'store-only');
  const fields = resolved.source === 'store' ? resolved.fields : null;
  if (request.method === 'GET') {
    let origin: string | null = null;
    try { origin = fields ? ntasksOrigin(fields[NTASKS_URL] ?? '') : null; } catch { origin = null; }
    return json({ connected: origin !== null, origin, appClientId: origin !== null && fields ? ntasksAppClientId(fields) : null });
  }
  let call: TaskServiceCall | null = null;
  try { call = readCall(await request.json()); } catch { call = null; }
  if (!call) return json({ error: 'invalid_request' }, 400);
  if (!fields) return json({ answered: false, reason: 'not-connected' } satisfies TaskServiceAnswer);
  try {
    const { status, body } = await callNtasks(fields, call, fetchImpl);
    return json({ answered: true, status, body } satisfies TaskServiceAnswer);
  } catch (error) {
    const failure = error instanceof TaskServiceError ? error.failure : { kind: 'network' as const };
    return json({ answered: false, reason: failure.kind, ...(failure.status === undefined ? {} : { status: failure.status }) } satisfies TaskServiceAnswer);
  }
}

/** The Tower's sign-in page address, or null when it is not one: http or
 * https, the origin and the sign-in path alone. */
function redirectUriOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return ['http:', 'https:'].includes(url.protocol) && value === `${url.origin}${SIGNED_IN_PATH}` ? value : null;
}

/** What POST /api/task-service/app answers, always with 200. `registered`
 * says this answer saved the client id with the connection. */
export type TaskServiceAppAnswer =
  | { readonly clientId: string; readonly registered: boolean; readonly held: boolean }
  | { readonly refused: { readonly status: number; readonly error: string } }
  | { readonly answered: false; readonly reason: 'not-connected' | 'changed' | TaskServiceError['failure']['kind']; readonly status?: number };

/**
 * POST /api/task-service/app ({ redirectUri }): the Tower's client id as a
 * connected app of this installation's Ntasks returning to `redirectUri`, for
 * a person's browser there to sign in with, and whether Ntasks holds that
 * address until a workspace owner allows it. Ntasks registers one app for each
 * address, answering the same one again, so the Tower opened at another
 * address gets its own; the first client id is saved with the connection,
 * and answers for an Ntasks that cannot register the Tower. Guarded as GET
 * and POST /api/task-service are.
 */
export async function handleTaskServiceApp(request: Request, env: IngestEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (workspaceProfile(env) !== 'standalone' || request.headers.has('origin')) return json({ error: 'forbidden' }, 403);
  if (!env.OPERATOR_TOKEN || !(await authenticateOperator(request, env.OPERATOR_TOKEN))) return json({ error: 'unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let redirectUri: string | null = null;
  try {
    const body: unknown = await request.json();
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
    redirectUri = keys.length === 1 && keys[0] === 'redirectUri' ? redirectUriOf((body as { redirectUri: unknown }).redirectUri) : null;
  } catch { redirectUri = null; }
  if (redirectUri === null) return json({ error: 'invalid_request' }, 400);
  const resolved = await resolveCredential(env, 'ntasks', 'store-only');
  if (resolved.source !== 'store') return json({ answered: false, reason: 'not-connected' } satisfies TaskServiceAppAnswer);
  const saved = ntasksAppClientId(resolved.fields);
  try {
    const registration = await registerNtasksApp(resolved.fields, redirectUri, fetchImpl);
    if (!registration.registered) {
      // An Ntasks that cannot register the Tower still signs in with a client id
      // saved by hand; one that refuses this address refuses it with any app.
      if (saved !== null && registration.error !== 'invalid_redirect_uri') {
        return json({ clientId: saved, registered: false, held: false } satisfies TaskServiceAppAnswer);
      }
      return json({ refused: { status: registration.status, error: registration.error } } satisfies TaskServiceAppAnswer);
    }
    const { clientId, held } = registration;
    if (saved !== null) return json({ clientId, registered: false, held } satisfies TaskServiceAppAnswer);
    // Ntasks answers the same app again for the same address, so a save lost here costs no second app.
    if (!(await saveNtasksAppClientId(env, resolved, clientId))) {
      return json({ answered: false, reason: 'changed' } satisfies TaskServiceAppAnswer);
    }
    return json({ clientId, registered: true, held } satisfies TaskServiceAppAnswer);
  } catch (error) {
    if (!(error instanceof TaskServiceError)) throw error;
    // An Ntasks with no registration route at all can answer a page, not JSON.
    if (saved !== null && error.failure.kind === 'invalid-response' && error.failure.status === 404) {
      return json({ clientId: saved, registered: false, held: false } satisfies TaskServiceAppAnswer);
    }
    return json({ answered: false, reason: error.failure.kind, ...(error.failure.status === undefined ? {} : { status: error.failure.status }) } satisfies TaskServiceAppAnswer);
  }
}
