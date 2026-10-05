import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { demoViewerMiddleware } from '../vite/demo-viewer-lane';
import { runnerGuard, serveDoorRequest } from '../vite/runner-door';
import { RUNNER_DOOR_HEADER } from '../shared/runner-lane';
import { handleTasksRequest } from '../vite/task-lane';
import { handleConfigRequest } from '../vite/config-write-lane';
import { validateDemoViewer } from '../shared/demo-viewer';

const viewer = validateDemoViewer({ version: 1, synthetic: true, release: '1'.repeat(40), scenarioHash: '2'.repeat(64),
  workspaceId: '11111111-1111-4111-8111-111111111111', cutoff: '2026-09-15T12:00:00.000Z', generatedAt: null });
function invoke(method: string, url: string, ordinary = false) {
  const next = vi.fn(); const end = vi.fn(); const setHeader = vi.fn();
  const response = { statusCode: 0, setHeader, removeHeader: vi.fn(), end };
  const request = { method, url, on: vi.fn(() => { throw new Error('The body must not be read'); }) };
  demoViewerMiddleware(ordinary ? null : viewer)(request as unknown as IncomingMessage, response as unknown as ServerResponse, next);
  return { response, next, request, body: end.mock.calls.length ? JSON.parse(end.mock.calls[0]![0] as string) as Record<string, unknown> : null };
}
describe('native viewer dispatch before file, hub or provider middleware', () => {
  it('refuses all native writes, provider GETs and privileged doors before reading a body or dispatching', () => {
    for (const [method, path] of [['PUT', '/api/config'], ['POST', '/api/tasks'], ['PATCH', '/api/tasks/ex-task'],
      ['POST', '/api/gates/ex-gate/resolve'], ['POST', '/api/integrations/import-env'], ['GET', '/api/site-name?domain=sentinel.example'],
      ['GET', '/api/calendar/upcoming'], ['POST', '/api/runner/ingest'], ['POST', '/cdn-cgi/handler/scheduled']]) {
      const { response, next, request, body } = invoke(method!, path!);
      expect(response.statusCode).toBe(403); expect(body).toMatchObject({ error: 'demo_read_only' });
      expect(next).not.toHaveBeenCalled(); expect(request.on).not.toHaveBeenCalled();
    }
  });
  it('preserves actual task detail/filtered reads and stored semantic POSTs', () => {
    for (const [method, path] of [['GET', '/api/tasks/ex-task?demo=false'], ['GET', '/api/tasks?project=example.com&status=open'],
      ['GET', '/api/assets/example.com?view=signals'], ['POST', '/api/mcp'], ['POST', '/api/alerts/backtest']]) {
      const { next, response } = invoke(method!, path!); expect(next).toHaveBeenCalledOnce(); expect(response.end).not.toHaveBeenCalled();
    }
  });
  it('preserves reader availability and config provenance, then limits only writes', () => {
    for (const [path, body] of [['/api/tasks/capabilities', { live: true, reason: null }],
      ['/api/tasks/capabilities', { live: false, reason: 'read_only_deployment' }],
      ['/api/config', { writable: true, reason: null, sources: { 'config/beads.json': 'store' }, store: { ready: true, reason: null } }],
      ['/api/config', { writable: false, reason: 'store_unreachable', sources: {}, store: { ready: false, reason: 'store_unreachable' } }]] as const) {
      const end = vi.fn(); const response = { statusCode: 200, setHeader: vi.fn(), removeHeader: vi.fn(), end };
      demoViewerMiddleware(viewer)({ method: 'GET', url: path } as IncomingMessage, response as unknown as ServerResponse,
        () => response.end(JSON.stringify(body)));
      expect(JSON.parse(end.mock.calls[0]![0] as string)).toEqual({ ...body, writable: false });
    }
    expect(invoke('GET', '/api/demo-viewer').body).toEqual(viewer);
  });
  it('ordinary installs and static asset navigation keep their existing middleware path', () => {
    expect(invoke('PUT', '/api/config', true).next).toHaveBeenCalledOnce();
    expect(invoke('GET', '/assets/example.com').next).toHaveBeenCalledOnce();
    expect(invoke('GET', '/integrations/google.svg').next).toHaveBeenCalledOnce();
  });
  it('uses the actual native capability readers and retains their degraded-state facts', async () => {
    const task = await handleTasksRequest({ method: 'GET', url: '/api/tasks/capabilities', headers: {}, body: '' });
    const apply = vi.fn();
    const config = await handleConfigRequest({ method: 'GET', url: '/api/config', headers: {}, body: '' }, {
      store: { state: async () => ({ ready: false, reason: 'store_unreachable', unseeded: ['config/beads.json'] }), apply },
    });
    for (const [path, reply] of [['/api/tasks/capabilities', task], ['/api/config', config]] as const) {
      const end = vi.fn(); const response = { statusCode: reply.status, setHeader: vi.fn(), removeHeader: vi.fn(), end };
      demoViewerMiddleware(viewer)({ method: 'GET', url: path } as IncomingMessage, response as unknown as ServerResponse,
        () => response.end(JSON.stringify(reply.body)));
      expect(JSON.parse(end.mock.calls[0]![0] as string)).toEqual({ ...reply.body, writable: false });
    }
    expect(task.body).toMatchObject({ live: true });
    expect(config.body).toMatchObject({ store: { ready: false, reason: 'store_unreachable' }, unseeded: ['config/beads.json'] });
    expect(apply).not.toHaveBeenCalled();
  });
  it('private stored reads require the existing door origin; forged wire headers do not unlock them', () => {
    for (const path of ['/api/config-documents?bodies=1', '/api/job-runs?trigger=manual']) {
      for (const header of [undefined, 'invalid', '1']) {
        const req = { method: 'GET', url: `/api/runner/ingest${path}`,
          headers: header ? { [RUNNER_DOOR_HEADER]: header } : {},
          rawHeaders: header ? [RUNNER_DOOR_HEADER, header] : [] };
        const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }; const dispatch = vi.fn();
        runnerGuard()(req as IncomingMessage, res as unknown as ServerResponse, () => {
          demoViewerMiddleware(viewer)(req as IncomingMessage, res as unknown as ServerResponse, dispatch);
        });
        expect(res.statusCode).toBe(403); expect(dispatch).not.toHaveBeenCalled();
        expect(req.headers).not.toHaveProperty(RUNNER_DOOR_HEADER); expect(req.rawHeaders).toEqual([]);
      }
      const req = { method: 'GET', url: path, headers: {}, rawHeaders: [], socket: { remoteAddress: '127.0.0.1' } };
      const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }; const dispatch = vi.fn();
      serveDoorRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, (r, s) => {
        runnerGuard()(r, s, () => demoViewerMiddleware(viewer)(r, s, dispatch));
      });
      expect(dispatch).toHaveBeenCalledOnce(); expect(res.end).not.toHaveBeenCalled();
      expect(req.headers).toEqual({ [RUNNER_DOOR_HEADER]: '1' });
    }
  });
});
