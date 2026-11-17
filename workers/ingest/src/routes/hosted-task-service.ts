import { TOWER_CONFIG_FILES } from '@noticeos/contract/configuration';
import { readBoundedJsonText } from '../../../../scripts/bounded-json-body.mjs';
import type { WorkspaceContext } from '../../../../scripts/workspace-admission.mjs';
import { hostedTaskRequest } from '../../../../scripts/hosted-task-request.mjs';
import { mapTaskProjects } from '../../../../scripts/task-projects.mjs';
import { getConfigDocument } from '../config-store.js';
import { resolveCredential, saveNtasksAppClientId } from '../credentials.js';
import { callNtasks, NTASKS_TOKEN, ntasksAppClientId, readHostedNtasksProjects, registerNtasksApp, TaskServiceError } from '../ntasks.js';
import { json as jsonResponse } from '../responses.js';
import { isRecord } from '../shared.js';

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const REQUEST_BYTES = 512 * 1024;
const APP_REQUEST_BYTES = 4096;
const DECISIONS = ['respond', 'choose', 'dismiss', 'dispute', 'accept', 'resolve', 'decline', 'performed', 'step', 'release'];
const unavailable = 'Ntasks is unavailable. Check the connection in Task projects.';
const json = (body: unknown, status = 200) => jsonResponse(body, status, { 'cache-control': 'no-store' });

export async function readHostedTaskConnection(env: IngestEnv, fetchImpl: typeof fetch) {
  const credential = await resolveCredential(env, 'ntasks', 'store-only');
  if (credential.source !== 'store') {
    if (credential.connectionId !== null) throw new TaskServiceError({ kind: 'invalid-response' });
    return null;
  }
  const document = await getConfigDocument(env, TOWER_CONFIG_FILES.beads, { fresh: true });
  const configured = isRecord(document.body) && Array.isArray(document.body.spokes) ? document.body.spokes : [];
  const spokes = configured.flatMap(spoke => isRecord(spoke) && typeof spoke.asset === 'string' && typeof spoke.prefix === 'string'
    ? [{ asset: spoke.asset, prefix: spoke.prefix }] : []);
  const connection = await readHostedNtasksProjects(env, credential.fields, fetchImpl);
  // Workspace-wide reads such as search and the change feed use the provider's
  // grant boundary. Refuse a credential whose grant includes an unmapped project.
  const projects = mapTaskProjects(spokes, connection.projects);
  const selectedIds = new Set(projects.flatMap(entry => entry.project ? [entry.project.projectId] : []));
  if (selectedIds.size !== connection.projects.length || projects.filter(entry => entry.project).length !== selectedIds.size) {
    throw new TaskServiceError({ kind: 'configuration' });
  }
  return { ...connection, credential, projects, catalog: connection.projects, selectedIds,
    async stillCurrent() {
      const [current, currentMap] = await Promise.all([resolveCredential(env, 'ntasks', 'store-only'),
        getConfigDocument(env, TOWER_CONFIG_FILES.beads, { fresh: true })]);
      return current.source === 'store' && current.connectionId === credential.connectionId
        && current.secretVersion === credential.secretVersion && currentMap.version === document.version;
    },
  };
}

function status(connected: boolean | null, reason?: string) {
  return json({ connected, origin: null, projects: null, required: true, ...(reason ? { reason } : {}) });
}

async function personFor(connection: NonNullable<Awaited<ReturnType<typeof readHostedTaskConnection>>>,
  token: string | null, fetchImpl: typeof fetch) {
  if (token === null) return null;
  const clientId = ntasksAppClientId(connection.credential.fields);
  if (!clientId) return null;
  const fields = { ...connection.credential.fields, [NTASKS_TOKEN]: token };
  const { status, body } = await callNtasks(fields, { method: 'GET', path: '/api/access/me', workspaceId: connection.workspaceId }, fetchImpl);
  const app = isRecord(body) && isRecord(body.app) ? body.app : null;
  if (status !== 200 || !isRecord(body) || body.kind !== 'person' || app?.workspaceId !== connection.workspaceId
    || app.clientId !== clientId || !Array.isArray(app.scopes) || !app.scopes.includes('tasks:decide')) return null;
  return { fields, name: typeof body.name === 'string' ? body.name : '' };
}

export async function handleHostedTaskService(request: Request, env: IngestEnv, context: WorkspaceContext,
  fetchImpl: typeof fetch = fetch): Promise<Response> {
  const selected = hostedTaskRequest(request);
  if (!selected || context.entryProfile !== 'hosted' || context.principalKind !== 'person' || selected.action !== context.action) {
    return json({ error: 'forbidden' }, 403);
  }
  const url = new URL(request.url);
  if (selected.kind === 'app' && (!context.allowedActions.includes('tasks.decide') || url.search)) {
    return json({ error: 'forbidden' }, 403);
  }
  let body: unknown;
  if (request.method !== 'GET') {
    try {
      body = JSON.parse(await readBoundedJsonText(request, selected.kind === 'app' ? APP_REQUEST_BYTES : REQUEST_BYTES));
    } catch { return json({ error: 'invalid_request' }, 400); }
    if (selected.kind === 'app' && (!isRecord(body) || Object.keys(body).length > 0)) {
      return json({ error: 'forbidden' }, 403);
    }
  }
  try {
    const connection = await readHostedTaskConnection(env, fetchImpl);
    if (!connection) return selected.kind === 'status' ? status(false) : json({ error: 'task_service_not_connected' }, 503);
    const { workspaceId, credential } = connection;
    const clientId = ntasksAppClientId(credential.fields);
    const canWrite = context.allowedActions.includes('tasks.write') && connection.writable;
    if (selected.kind === 'status') {
      return json({ connected: true, origin: connection.origin, projects: connection.projects, required: true, writable: canWrite,
        app: clientId === null ? null : { clientId, workspaceId } });
    }
    if (selected.kind === 'app') {
      if (clientId !== null) return json({ clientId, held: false });
      const registration = await registerNtasksApp(credential.fields, `${url.origin}/tasks/signed-in`, fetchImpl);
      if (!registration.registered) return json({ error: registration.error, detail: 'Ntasks could not register this Tower.' }, 502);
      if (!await saveNtasksAppClientId(env, credential, registration.clientId)) return json({ error: 'task_service_changed' }, 409);
      return json({ clientId: registration.clientId, held: registration.held });
    }
    const named = request.headers.get('x-ntasks-workspace');
    if (named !== null && named !== workspaceId) return json({ error: 'not_found' }, 404);
    const { pathname, search, searchParams } = url;
    if (pathname === '/api/workspaces') return json({ workspaces: [{ workspaceId, name: 'Task workspace', role: 'member' }] });
    if (pathname === '/api/access/me') {
      const person = await personFor(connection, selected.token, fetchImpl);
      return json({ name: person?.name ?? 'Tower member', deploymentAdmin: false });
    }
    if (pathname === '/api/tasks/projects') return json({ projects: connection.catalog });
    const projects = searchParams.getAll('project');
    if (projects.length > 1 || projects.some(project => !connection.selectedIds.has(project))) return json({ error: 'not_found' }, 404);
    const taskPrefix = /^\/api\/(?:tasks|gates)\/([a-z0-9]+)-[a-z0-9]+(?:\.|\/|$)/u.exec(pathname)?.[1];
    if (taskPrefix && !connection.catalog.some(project => project.prefix === taskPrefix)) return json({ error: 'not_found' }, 404);
    if (selected.kind === 'write' && !canWrite) return json({ error: 'forbidden' }, 403);
    if (request.method !== 'GET' && (!isRecord(body) || typeof body.projectId !== 'string' || !connection.selectedIds.has(body.projectId))) {
      return json({ error: 'not_found' }, 404);
    }
    const needsPerson = selected.kind === 'decide' || pathname === '/api/tasks/capabilities';
    const person = needsPerson && context.allowedActions.includes('tasks.decide') ? await personFor(connection, selected.token, fetchImpl) : null;
    if (selected.kind === 'decide') {
      if (!person) return json({ error: 'sign_in_required', detail: 'Sign in to Ntasks to record a decision.' }, 401);
      // Ntasks may include the name of another project in an error to a
      // person who can reach it directly. Forward only decisions on this map.
      const present = connection.catalog.find(project => isRecord(body) && body.projectId === project.projectId);
      if (present?.prefix !== taskPrefix || isRecord(body) && body.duplicateOf !== undefined
        && (typeof body.duplicateOf !== 'string' || !connection.catalog.some(project => (body.duplicateOf as string).startsWith(`${project.prefix}-`)))) {
        return json({ error: 'not_found' }, 404);
      }
    }
    if (request.method !== 'GET' && !await connection.stillCurrent()) return json({ error: 'task_service_changed' }, 409);
    const key = request.headers.get('idempotency-key');
    if (key !== null && !KEY.test(key)) return json({ error: 'invalid_request' }, 400);
    const { status: code, body: reply } = await callNtasks(selected.kind === 'decide' ? person!.fields : credential.fields, {
      method: request.method, path: pathname + search, workspaceId,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(key === null ? {} : { idempotencyKey: key }),
      ...(selected.kind === 'write' ? { onBehalfOf: `tower:${context.principalId}` } : {}),
    }, fetchImpl);
    if (pathname === '/api/tasks/capabilities' && code === 200 && isRecord(reply)) {
      const operations = Array.isArray(reply.operations) ? reply.operations : [];
      return json({ ...reply, writable: canWrite && reply.writable === true,
        operations: canWrite ? [...operations.filter(operation => operation !== 'deliver'), ...(person ? DECISIONS : [])] : [],
        editableFields: canWrite ? reply.editableFields : [] });
    }
    if (code === 401 || code === 403) return selected.kind === 'decide' ? json(reply, code) : json({ error: 'task_service_unavailable', detail: unavailable }, 503);
    return code === 204 ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }) : json(reply, code);
  } catch {
    if (selected.kind === 'status') return status(null, unavailable);
    return json({ error: 'task_service_unavailable', detail: unavailable }, 503);
  }
}
