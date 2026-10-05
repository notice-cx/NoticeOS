import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type TowerEnv } from '../worker/index';
import { demoViewerReadResponse, demoViewerResponse } from '../worker/demo-viewer-route';
import { validateDemoViewer } from '../shared/demo-viewer';
import { handleRunnerRequest } from '../worker/runner-route';
import { RUNNER_DOOR_HEADER } from '../shared/runner-lane';
import { handleTasksRequest } from '../worker/tasks-route';
import { handleMcpRequest, MCP_TOOL_NAMES, type McpDeps } from '../worker/mcp-route';
import type { WorkspaceStore } from '@noticeos/postgres';
import { DEMO_MCP_READ_TOOLS } from '../shared/demo-viewer';

const descriptor = validateDemoViewer({ version: 1, synthetic: true, release: '1'.repeat(40), scenarioHash: '2'.repeat(64),
  workspaceId: '11111111-1111-4111-8111-111111111111', cutoff: '2026-09-15T12:00:00.000Z', generatedAt: null });
afterEach(() => vi.unstubAllGlobals());
function request(path: string, method = 'GET') {
  return new Request(`https://demo.example${path}`, { method });
}
function forbiddenEnvironment() {
  const get = vi.fn(() => { throw new Error('Refusal opened a store or reached a binding'); });
  return { env: new Proxy({} as TowerEnv, { get }), get };
}
describe('the actual demo Worker entry points', () => {
  it('refuses unsafe GETs and mutations before accessing any store, binding or request body', async () => {
    vi.stubGlobal('__DEMO_VIEWER__', descriptor);
    const { env, get } = forbiddenEnvironment();
    const ctx = { waitUntil: vi.fn() };
    for (const [method, path] of [['GET', '/api/site-name?domain=sentinel.example'], ['GET', '/api/ga4/realtime'],
      ['GET', '/api/calendar/upcoming'], ['GET', '/api/integrations/google/properties'],
      ['GET', '/api/integrations/clarity/sites'], ['PUT', '/api/config'], ['PATCH', '/api/flags/1'],
      ['POST', '/api/assets'], ['PATCH', '/api/assets/example.com'], ['POST', '/api/assets/example.com/annotations'],
      ['POST', '/api/assets/example.com/watch-windows'], ['POST', '/api/tasks'], ['POST', '/api/runner/scheduled'],
      ['POST', '/api/new-provider-action']]) {
      const req = request(path!, method!); const body = vi.spyOn(req, 'json');
      const response = await worker.fetch(req, env, ctx);
      expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: 'demo_read_only' });
      expect(body).not.toHaveBeenCalled();
    }
    expect(get).not.toHaveBeenCalled(); expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
  it('scheduled triggers are inert even if explicitly dispatched', async () => {
    vi.stubGlobal('__DEMO_VIEWER__', descriptor);
    const { env, get } = forbiddenEnvironment(); const ctx = { waitUntil: vi.fn() };
    await worker.scheduled({ cron: '0 * * * *' }, env, ctx);
    expect(get).not.toHaveBeenCalled(); expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
  it('capability and provenance answers never pretend observations became fresh', async () => {
    vi.stubGlobal('__DEMO_VIEWER__', descriptor);
    const { env, get } = forbiddenEnvironment(); const ctx = { waitUntil: vi.fn() };
    for (const path of ['/api/demo-viewer']) {
      const response = await worker.fetch(request(path), env, ctx); expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(descriptor);
    }
    expect(get).not.toHaveBeenCalled();
  });
  it('stored reads, semantic POSTs and ordinary dispatch continue to their existing handlers', () => {
    for (const [method, path] of [['GET', '/api/wall'], ['GET', '/api/work'], ['GET', '/api/assets/example.com'],
      ['POST', '/api/mcp'], ['POST', '/api/alerts/backtest']]) {
      expect(demoViewerResponse(request(path!, method!), descriptor)).toBeNull();
    }
    expect(demoViewerResponse(request('/api/integrations/clarity/collect', 'POST'), null)).toBeNull();
  });
  it('Worker-only task capabilities preserve unavailable details and real config source facts', async () => {
    const req = request('/api/tasks/capabilities');
    const response = await demoViewerReadResponse(req, descriptor, handleTasksRequest(new URL(req.url)));
    expect(await response.json()).toMatchObject({ live: false, writable: false, reason: 'read_only_deployment' });
    expect(handleTasksRequest(new URL(request('/api/tasks/ex-task').url)).status).toBe(501);
    const body = { writable: true, reason: null, sources: { 'config/beads.json': 'store' }, versions: { 'config/beads.json': 2 }, store: { ready: true, reason: null } };
    const config = await demoViewerReadResponse(request('/api/config'), descriptor, Response.json(body));
    expect(await config.json()).toEqual({ ...body, writable: false });
    const failure = new Response(null, { status: 503 });
    expect(await demoViewerReadResponse(request('/api/config'), descriptor, failure)).toBe(failure);
  });
  it('MCP permits only reviewed read tools and handshake methods before dispatch', async () => {
    expect(MCP_TOOL_NAMES).toEqual(DEMO_MCP_READ_TOOLS);
    const get = vi.fn(() => { throw new Error('Unreviewed MCP reached a store or binding'); });
    const store = new Proxy({} as WorkspaceStore, { get }); const deps = new Proxy({} as McpDeps, { get });
    for (const body of [{ jsonrpc: '2.0', id: 1, method: 'new/mutation' },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'future_write_tool' } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_collector' } }]) {
      const req = new Request('https://demo.example/api/mcp', { method: 'POST', body: JSON.stringify(body) });
      expect((await handleMcpRequest(req, store, deps, descriptor)).status).toBe(403);
    }
    for (const method of ['initialize', 'notifications/initialized', 'ping', 'tools/list']) {
      const req = new Request('https://demo.example/api/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
      expect((await handleMcpRequest(req, store, deps, descriptor)).status).toBe(method === 'notifications/initialized' ? 202 : 200);
    }
    expect(get).not.toHaveBeenCalled();
  });
  it('the two private reads keep the existing Worker door guard and forward the operator bearer unchanged', async () => {
    const fetch = vi.fn(async (_request: Request) => new Response('{}')); const runScheduled = vi.fn();
    const ingest = { fetch, runScheduled };
    for (const path of ['/api/config-documents?bodies=1', '/api/job-runs?trigger=manual']) {
      const url = new URL(`https://demo.example/api/runner/ingest${path}`);
      for (const mark of [undefined, 'invalid']) {
        const req = new Request(url, { headers: mark ? { [RUNNER_DOOR_HEADER]: mark } : {} });
        expect(demoViewerResponse(req, descriptor)).toBeNull();
        expect((await handleRunnerRequest(req, url, ingest)).status).toBe(403);
      }
      expect(fetch).not.toHaveBeenCalled();
      const req = new Request(url, { headers: { [RUNNER_DOOR_HEADER]: '1', authorization: 'Bearer synthetic-operator' } });
      expect(demoViewerResponse(req, descriptor)).toBeNull();
      expect((await handleRunnerRequest(req, url, ingest)).status).toBe(200);
      const forwarded = fetch.mock.calls[0]![0] as Request;
      expect(new URL(forwarded.url).pathname + new URL(forwarded.url).search).toBe(path);
      expect(forwarded.method).toBe('GET'); expect(forwarded.headers.get('authorization')).toBe('Bearer synthetic-operator');
      fetch.mockClear();
    }
    expect(runScheduled).not.toHaveBeenCalled();
  });
  it('all other runner paths and methods stop before runner dispatch', async () => {
    const { env, get } = forbiddenEnvironment(); const ctx = { waitUntil: vi.fn() };
    vi.stubGlobal('__DEMO_VIEWER__', descriptor);
    for (const path of ['/api/runner/ingest/api/config-documents', '/api/runner/ingest/api/job-runs',
      '/api/runner/ingest/api/config-documents/seed', '/api/runner/ingest/api/config-documents/apply',
      '/api/runner/ingest/api/pulse', '/api/runner/scheduled', '/api/runner/ingest/healthz']) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const req = request(path, method);
        if (demoViewerResponse(req, descriptor) === null) continue;
        expect((await worker.fetch(req, env, ctx)).status).toBe(403);
      }
    }
    expect(get).not.toHaveBeenCalled(); expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
