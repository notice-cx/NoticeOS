import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const BOARD_AUTH = new RegExp(`^Bearer noticeos-tasks/(${UUID})/(${UUID})(?:/([A-Za-z0-9._~-]{1,8192}))?$`, 'u');
const TASK = '[a-z0-9]+-[a-z0-9]+(?:\\.[0-9]+)*';
const TASK_READ = new RegExp(`^/api/tasks/${TASK}(?:/history)?$`, 'u');
const TASK_EDIT = new RegExp(`^/api/tasks/${TASK}$`, 'u');
const TASK_WRITE = new RegExp(`^/api/tasks/${TASK}/(?:close|comments)$`, 'u');
const TASK_DECIDE = new RegExp(`^/api/(?:tasks/${TASK}/(?:respond|choose|dismiss|dispute|accept|release)|gates/${TASK}/(?:resolve|decline|performed|steps))$`, 'u');
const BOARD_READS = new Set(['/api/workspaces', '/api/access/me', '/api/fields', '/api/changes', '/api/tasks', '/api/tasks/projects',
  '/api/tasks/capabilities', '/api/tasks/search', '/api/tasks/wins', '/api/tasks/burndown', '/api/tasks/agent-stats']);

/** The embedded client's token hook carries the browser's captured selection.
 * Only the app's optional Ntasks token leaves NoticeOS, for personal decisions. */
export function hostedTaskAuthorization(workspaceId: string, sessionId: string, token: string | null): string {
  return `noticeos-tasks/${workspaceId}/${sessionId}${token === null ? '' : `/${token}`}`;
}

export function hostedTaskRequest(request: Request) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (pathname === '/api/tasks/service' && method === 'GET') return { kind: 'status', action: 'tasks.read' } as const;
  if (pathname === '/api/tasks/service/app' && method === 'POST') return { kind: 'app', action: 'tasks.write' } as const;
  const browser = BOARD_AUTH.exec(request.headers.get('authorization') ?? '');
  if (!browser) {
    if (method === 'GET' && ['/api/tasks/capabilities', '/api/tasks/agent-stats'].includes(pathname)) {
      return { kind: 'read', action: 'tasks.read', token: null } as const;
    }
    return null;
  }
  const selection = { workspaceId: browser[1]!, sessionId: browser[2]!, token: browser[3] ?? null };
  if (method === 'GET' && (BOARD_READS.has(pathname) || TASK_READ.test(pathname))) {
    return { kind: 'read', action: 'tasks.read', ...selection } as const;
  }
  if (method === 'POST' && TASK_DECIDE.test(pathname)) return { kind: 'decide', action: 'tasks.decide', ...selection } as const;
  if ((method === 'POST' && (pathname === '/api/tasks' || pathname === '/api/tasks/move' || TASK_WRITE.test(pathname)))
    || (method === 'PATCH' && TASK_EDIT.test(pathname))) return { kind: 'write', action: 'tasks.write', ...selection } as const;
  return null;
}

/** Preserve the original browser evidence and reject ambiguous selectors. */
export function hostedTaskProof(request: Request, selected: NonNullable<ReturnType<typeof hostedTaskRequest>>): Request {
  if (!('workspaceId' in selected)) return request.clone();
  const headers = new Headers(request.headers);
  if (headers.has(WORKSPACE_SELECTION_HEADER) || headers.has(WORKSPACE_SESSION_HEADER)) throw new Error('Ambiguous task workspace.');
  headers.delete('authorization');
  headers.set(WORKSPACE_SELECTION_HEADER, selected.workspaceId);
  headers.set(WORKSPACE_SESSION_HEADER, selected.sessionId);
  return new Request(request.clone(), { headers });
}
