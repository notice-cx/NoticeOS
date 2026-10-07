/** Node server composition only. No Vite or remote executor transport is activated.
 * Server-owned composition selects the profile, origin and qualified executor.
 * The request supplies only a logical project and bounded task fields; the
 * executor independently reads current admission and physical directory facts.
 * This named handler's contract uses opaque project UUIDs and returns pinned
 * Beads JSON. It is not Tower's standalone LiveTasksPayload/LiveTaskDetail API:
 * that browser binding needs an explicit logical-project/payload adapter.
 */
import { createHostedTaskPlanner, HOSTED_TASK_LIMITS, type HostedTaskRequest, type HostedTaskOperation } from './hosted-task-command.mjs';
import type { HostedTaskExecutor } from './hosted-task-executor.mjs';
import { createBrowserRequestPolicy, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { readBoundedJsonText } from './bounded-json-body.mjs';

export interface HostedTaskHttpOptions {
  readonly profile: 'hosted' | 'demo';
  readonly trustedOrigin: string;
  readonly demoWorkspaceId?: string;
  /** Missing composition refuses; it never discovers a host installation. */
  readonly executor?: Pick<HostedTaskExecutor, 'execute'>;
}
export type HostedTaskHttp = (original: Request) => Promise<Response>;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const BODY_BYTES = 32 * 1024;
function invalid(): never { throw new Error('Invalid hosted task request.'); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}
function keys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(row, key))
    || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
/** Only scalar fields, bounded string arrays and one-level string metadata.
 * Decode keys before insertion so duplicate escaped names cannot be hidden by
 * JSON.parse at either object level. Command validation owns allowed fields. */
function commandObject(text: string): Record<string, unknown> {
  let offset = 0;
  const space = () => { while (/[ \t\r\n]/u.test(text[offset] ?? '') && offset < text.length) offset++; };
  const token = (pattern: RegExp): string => {
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) invalid();
    offset = pattern.lastIndex; return match[0];
  };
  const string = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/uy;
  const scalar = /(?:"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/uy;
  const strings = (): readonly string[] => {
    const values: string[] = []; offset++; space();
    if (text[offset] !== ']') for (;;) {
      if (values.length >= HOSTED_TASK_LIMITS.labels) invalid();
      values.push(JSON.parse(token(string)) as string);
      space(); if (text[offset] !== ',') break;
      offset++; space();
    }
    if (text[offset++] !== ']') invalid();
    return Object.freeze(values);
  };
  const object = (nested: boolean): Record<string, unknown> => {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (text[offset++] !== '{') invalid(); space();
    if (text[offset] !== '}') for (;;) {
      const name: unknown = JSON.parse(token(string));
      if (typeof name !== 'string' || Object.hasOwn(result, name) || Object.keys(result).length >= 32) invalid();
      space(); if (text[offset++] !== ':') invalid(); space();
      result[name] = nested ? JSON.parse(token(string)) as string
        : text[offset] === '[' ? strings() : text[offset] === '{' ? Object.freeze(object(true))
        : JSON.parse(token(scalar)) as unknown;
      space(); if (text[offset] !== ',') break;
      offset++; space();
    }
    if (text[offset++] !== '}') invalid();
    return result;
  };
  space(); const result = object(false); space(); if (offset !== text.length) invalid();
  return result;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  return commandObject(await readBoundedJsonText(request, BODY_BYTES));
}
function query(url: URL, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of url.searchParams) { if (Object.hasOwn(row, name)) invalid(); row[name] = value; }
  keys(row, required, optional); return row;
}
function limit(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/u.test(value)) invalid();
  return Number(value);
}
/** Request parsing only. Callers still establish current admission separately. */
export async function readHostedTaskCommand(request: Request, url: URL, workspaceId: string): Promise<HostedTaskRequest> {
  const match = /^\/api\/tasks(?:\/([a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*)(?:\/(history|comments|close|respond|dismiss))?)?$/iu.exec(url.pathname);
  const gate = /^\/api\/gates\/([a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*)\/resolve$/iu.exec(url.pathname);
  if ((!match && !gate) || /%/u.test(url.pathname)) invalid();
  const taskId = gate?.[1] ?? match?.[1], suffix = gate ? 'resolve-gate' : match?.[2];
  let projectId: string, operation: HostedTaskOperation;
  if (request.method === 'GET' && (!suffix || suffix === 'history')) {
    if (request.body !== null) invalid();
    const q = query(url, ['project'], !taskId ? ['limit', 'status'] : suffix === 'history' ? ['limit'] : []);
    projectId = uuid(q.project);
    operation = !taskId ? { kind: 'list', limit: limit(q.limit), ...(q.status === undefined ? {} : { status: q.status }) } as HostedTaskOperation
      : suffix === 'history' ? { kind: 'history', taskId, limit: limit(q.limit) } : { kind: 'show', taskId };
  } else {
    if (url.search !== '') invalid();
    // Validate the route before acquiring/reading even the caller's stream.
    const kind = request.method === 'POST' && !taskId ? 'create'
      : request.method === 'PATCH' && taskId && !suffix ? 'update'
      : request.method === 'POST' && taskId && suffix === 'comments' ? 'comment'
      : request.method === 'POST' && taskId && suffix === 'close' ? 'close'
      : request.method === 'POST' && taskId && ['respond', 'dismiss', 'resolve-gate'].includes(suffix ?? '') ? suffix as 'respond' | 'dismiss' | 'resolve-gate' : invalid();
    const row = await body(request);
    const fields = kind === 'create' ? ['title', 'description', 'type', 'priority', 'labels', 'parent', 'acceptance', 'metadata']
      : kind === 'update' ? ['status', 'priority', 'title', 'description', 'claim', 'assignee', 'parent', 'defer', 'acceptance', 'addLabels', 'removeLabels'] : kind === 'comment' ? ['text'] : kind === 'respond' ? ['response'] : ['reason'];
    keys(row, ['projectId'], fields); projectId = uuid(row.projectId);
    delete row.projectId;
    operation = { kind, ...(taskId ? { taskId } : {}), ...row } as HostedTaskOperation;
  }
  const result = Object.freeze({ projectId, operation: Object.freeze(operation) });
  // Reuse the qualified command grammar; this output remains classification,
  // never authority. The executor resolves the actual private directory.
  createHostedTaskPlanner([{ workspaceId, projectId, capability: Symbol() }])(workspaceId, result);
  return result;
}
function reply(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
export function createHostedTaskHttp(options: HostedTaskHttpOptions): HostedTaskHttp {
  if (!options || !['hosted', 'demo'].includes(options.profile)) invalid();
  const trustedOrigin = createBrowserRequestPolicy(options.trustedOrigin).origin;
  const demo = options.profile === 'demo' ? uuid(options.demoWorkspaceId) : undefined;
  if (options.profile === 'hosted' && options.demoWorkspaceId !== undefined) invalid();
  const executor = options.executor, profile = options.profile;
  if (executor !== undefined && typeof executor.execute !== 'function') invalid();
  return async original => {
    if (!executor) return reply(503, { error: 'hosted_task_unavailable' });
    let selected: string, request: HostedTaskRequest, proof: Request;
    try {
      if (!(original instanceof Request)) invalid();
      const url = new URL(original.url);
      if (url.origin !== trustedOrigin || url.username || url.password || url.hash) invalid();
      const selector = original.headers.get(WORKSPACE_SELECTION_HEADER);
      selected = profile === 'demo' ? demo! : uuid(selector);
      if (profile === 'demo' && selector !== null && selector !== demo) invalid();
      // No body tee remains live during task execution; the actual body below
      // is consumed once, while truthful target/method/headers remain intact.
      proof = new Request(original.url, { method: original.method, headers: new Headers(original.headers), signal: original.signal });
      request = await readHostedTaskCommand(original, url, selected);
    } catch { return reply(400, { error: 'invalid_hosted_task_request' }); }
    try { return reply(200, await executor.execute(proof, selected, request)); }
    catch { return reply(403, { error: 'hosted_task_refused' }); }
  };
}
