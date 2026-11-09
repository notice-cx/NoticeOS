// POST /api/task-service: one call to this installation's Ntasks Worker
// (../ntasks.ts), with the service credential added here, where it is
// opened. Every Node caller (the local MCP, the Tower's task routes, the
// runner) reaches Ntasks this way, with the operator bearer.

import { workspaceProfile } from '../../../../scripts/product-env.mjs';
import { authenticateOperator } from '../auth.js';
import { resolveCredential } from '../credentials.js';
import { callNtasks, NTASKS_URL, ntasksAppClientId, ntasksOrigin, ON_BEHALF_OF, TaskServiceError, type TaskServiceAnswer, type TaskServiceCall } from '../ntasks.js';
import { json } from '../responses.js';

export const TASK_SERVICE_PATH = '/api/task-service';
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
