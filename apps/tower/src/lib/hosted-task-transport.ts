import type { ApiTransport } from './api';
import type { TaskProject } from '@shared/tasks';

/** One owner runtime's logical project adapter, never authorization. The
 * receiver checks current membership and the physical directory each time.
 * Task IDs and prefixes cannot choose a project; missing selection refuses. */
export function createHostedTaskTransport(fetch: ApiTransport): ApiTransport {
  let projects: Promise<readonly TaskProject[]> | undefined;
  async function catalog(signal?: AbortSignal | null): Promise<readonly TaskProject[]> {
    projects ??= (async () => {
      const response = await fetch('/api/tasks/projects', { signal, headers: { accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Task projects are unavailable.'); }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('projects' in payload) || !Array.isArray(payload.projects)
        || payload.projects.length > 4096) throw new Error('Task projects are unavailable.');
      const ids = new Set<string>(), keys = new Set<string>();
      return Object.freeze(payload.projects.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Task project is invalid.');
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(',') !== 'displayName,logicalKey,prefix,projectId'
          || typeof row.projectId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(row.projectId)
          || typeof row.logicalKey !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.logicalKey)
          || typeof row.displayName !== 'string' || row.displayName.length < 1 || row.displayName.length > 80
          || typeof row.prefix !== 'string' || !/^[a-z0-9]{1,32}$/u.test(row.prefix)
          || ids.has(row.projectId) || keys.has(row.logicalKey)) throw new Error('Task project is invalid.');
        ids.add(row.projectId); keys.add(row.logicalKey);
        return Object.freeze({ projectId: row.projectId, logicalKey: row.logicalKey, displayName: row.displayName, prefix: row.prefix });
      }));
    })().catch(error => { projects = undefined; throw error; });
    return projects;
  }
  return async (input, init) => {
    if (typeof input !== 'string' || !(input === '/api/tasks' || input.startsWith('/api/tasks?') || input.startsWith('/api/tasks/') || input.startsWith('/api/gates/'))) return fetch(input, init);
    const url = new URL(input, 'https://task-adapter.invalid');
    if (['/api/tasks/projects', '/api/tasks/capabilities'].includes(url.pathname)) return fetch(input, init);
    if (!/^\/api\/tasks(?:\/[^/]+(?:\/(?:comments|close|history|respond|dismiss))?)?$/u.test(url.pathname)
      && !/^\/api\/gates\/[^/]+\/resolve$/u.test(url.pathname)) return fetch(input, init);
    const method = init?.method ?? 'GET';
    let logical: unknown, body: Record<string, unknown> | undefined;
    if (method === 'GET') {
      if (url.searchParams.getAll('project').length !== 1) throw new Error('Choose a task project.');
      logical = url.searchParams.get('project');
    } else {
      if (typeof init?.body !== 'string') throw new Error('Task request is invalid.');
      const parsed: unknown = JSON.parse(init.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Task request is invalid.');
      body = parsed as Record<string, unknown>; logical = body.project;
      if (Object.hasOwn(body, 'projectId')) throw new Error('Task project selection is invalid.');
    }
    if (typeof logical !== 'string') throw new Error('Choose a task project.');
    const selected = (await catalog(init?.signal)).find(project => project.logicalKey === logical);
    if (!selected) throw new Error('Task project is unavailable.');
    if (body) {
      const rewritten: Record<string, unknown> = { ...body, projectId: selected.projectId }; delete rewritten.project;
      // The existing composer supplies an empty labels array by default. It
      // conveys no labels; populated labels pass through as explicit data.
      if (Array.isArray(rewritten.labels) && rewritten.labels.length === 0) delete rewritten.labels;
      return fetch(input, { ...init, body: JSON.stringify(rewritten) });
    }
    url.searchParams.set('project', selected.projectId);
    return fetch(`${url.pathname}${url.search}`, init);
  };
}
