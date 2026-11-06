import { env } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { connectCredential } from '../src/credential-connect.js';
import { putCredential, resolveCredential } from '../src/credentials.js';
import { callNtasks, checkNtasks, ntasksOrigin } from '../src/ntasks.js';
import { handleTaskService } from '../src/routes/task-service.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { forgetCredentials } from './helpers.js';

// An Ntasks Worker is answered here by stubbed fetches; nothing leaves the test.
const fields = { NTASKS_URL: 'https://ntasks.example.com', NTASKS_TOKEN: 'synthetic-service-token' };
/** Read per test: the store binding is the test's own. */
const inProfile = (profile: string) => ({ ...env, NOTICEOS_WORKSPACE_PROFILE: profile });
const projects = () => Response.json({ projects: [{ projectId: 'p1', logicalKey: 'example.com', displayName: 'Example', prefix: 'ex' }] });

function door(body: unknown, { token = OPERATOR_TOKEN, method = 'POST', origin }: { token?: string; method?: string; origin?: string } = {}) {
  return new Request('http://ingest.local/api/task-service', { method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}

afterEach(async () => { await forgetCredentials(['ntasks']); });

it('accepts HTTPS and local HTTP addresses with no path, and refuses the rest', () => {
  expect(ntasksOrigin('https://ntasks.example.com/')).toBe('https://ntasks.example.com');
  expect(ntasksOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  expect(ntasksOrigin('http://host.docker.internal:8787')).toBe('http://host.docker.internal:8787');
  for (const value of ['http://ntasks.example.com', 'https://ntasks.example.com/api', 'https://user:pw@ntasks.example.com', 'https://ntasks.example.com/?a=1', 'ftp://ntasks.example.com', '']) {
    expect(() => ntasksOrigin(value), value).toThrow();
  }
});

it('sends the credential, the retry key and the MCP version, and never follows a redirect', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe('https://ntasks.example.com/api/mcp');
    expect(init?.redirect).toBe('manual');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-service-token');
    expect(headers.get('idempotency-key')).toBe('key-12345678');
    expect(headers.get('mcp-protocol-version')).toBe('2025-06-18');
    expect(headers.get('x-ntasks-on-behalf-of')).toBe('claude');
    return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
  });
  expect(await callNtasks(fields, { method: 'POST', path: '/api/mcp', body: '{}', idempotencyKey: 'key-12345678', onBehalfOf: 'claude' }, fetchImpl))
    .toEqual({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
  await expect(callNtasks(fields, { method: 'GET', path: '/api/tasks/projects' }, async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com' } })))
    .rejects.toMatchObject({ failure: { kind: 'redirect', status: 302 } });
  await expect(callNtasks(fields, { method: 'GET', path: '/api/tasks/projects' }, async () => { throw new TypeError('connection refused'); }))
    .rejects.toMatchObject({ failure: { kind: 'network' } });
});

it('proves a credential by the projects it reaches', async () => {
  expect(await checkNtasks(fields, async () => projects())).toEqual({ outcome: 'answered', facts: { projects: 1 } });
  expect(await checkNtasks(fields, async () => Response.json({ error: 'invalid_token' }, { status: 401 })))
    .toMatchObject({ outcome: 'refused', fix: { kind: 'replace' } });
  expect(await checkNtasks(fields, async () => { throw new TypeError('down'); })).toMatchObject({ outcome: 'unreachable' });
  expect(await checkNtasks({ ...fields, NTASKS_URL: 'http://ntasks.example.com' }, async () => projects())).toMatchObject({ outcome: 'invalid' });
});

it('stores an Ntasks connection only after Ntasks accepts it, and only on a standalone installation', async () => {
  expect(await connectCredential(inProfile('standalone'), { provider: 'ntasks', fields }, { fetchImpl: async () => Response.json({}, { status: 401 }) }))
    .toMatchObject({ ok: true, verdict: 'refused' });
  expect((await resolveCredential(inProfile('standalone'), 'ntasks', 'store-only')).source).toBe('none');
  expect(await connectCredential(inProfile('standalone'), { provider: 'ntasks', fields }, { fetchImpl: async () => projects() }))
    .toMatchObject({ ok: true, verdict: 'accepted', facts: { projects: 1 } });
  expect((await resolveCredential(inProfile('standalone'), 'ntasks', 'store-only')).fields).toEqual(fields);
  expect(await connectCredential(inProfile('hosted'), { provider: 'ntasks', fields }, { fetchImpl: async () => projects() }))
    .toMatchObject({ ok: false, error: 'not_supported' });
});

it('forwards one call for the operator, and says why when Ntasks gave no answer', async () => {
  expect((await handleTaskService(door({ method: 'GET', path: '/api/changes?after=0' }, { token: 'wrong' }), inProfile('standalone'))).status).toBe(401);
  expect((await handleTaskService(door({ method: 'GET', path: '/api/changes' }, { origin: 'https://evil.example.com' }), inProfile('standalone'))).status).toBe(403);
  expect((await handleTaskService(door({ method: 'GET', path: '/api/changes' }), inProfile('hosted'))).status).toBe(403);
  expect(await (await handleTaskService(door(null, { method: 'GET' }), inProfile('standalone'))).json()).toEqual({ connected: false, origin: null });
  expect(await (await handleTaskService(door({ method: 'GET', path: '/api/changes?after=0' }), inProfile('standalone'))).json())
    .toEqual({ answered: false, reason: 'not-connected' });

  expect(await putCredential(inProfile('standalone'), { provider: 'ntasks', fields })).toMatchObject({ ok: true });
  expect(await (await handleTaskService(door(null, { method: 'GET' }), inProfile('standalone'))).json()).toEqual({ connected: true, origin: 'https://ntasks.example.com' });
  const seen: string[] = [];
  const answer = await handleTaskService(door({ method: 'GET', path: '/api/changes?after=4&limit=200' }), inProfile('standalone'), async input => {
    seen.push(String(input)); return Response.json({ events: [], lastSeq: 4 });
  });
  expect(await answer.json()).toEqual({ answered: true, status: 200, body: { events: [], lastSeq: 4 } });
  expect(seen).toEqual(['https://ntasks.example.com/api/changes?after=4&limit=200']);
  expect(await (await handleTaskService(door({ method: 'GET', path: '/api/tasks/ex-1' }), inProfile('standalone'),
    async () => Response.json({ error: 'not_found' }, { status: 404 }))).json()).toEqual({ answered: true, status: 404, body: { error: 'not_found' } });
  expect(await (await handleTaskService(door({ method: 'GET', path: '/api/tasks' }), inProfile('standalone'),
    async () => { throw new TypeError('down'); })).json()).toEqual({ answered: false, reason: 'network' });

  for (const call of [{ method: 'DELETE', path: '/api/tasks' }, { method: 'GET', path: '/api/auth/session' }, { method: 'GET', path: '/api/../admin' },
    { method: 'GET', path: '/api/tasks', body: '{}' }, { method: 'POST', path: '/api/tasks', idempotencyKey: 'short' }, { method: 'GET', path: '/api/tasks', extra: 1 },
    { method: 'POST', path: '/api/mcp', onBehalfOf: 'two words' }, { method: 'POST', path: '/api/mcp', onBehalfOf: '' }]) {
    expect((await handleTaskService(door(call), inProfile('standalone'), async () => { throw new Error('must not be called'); })).status, JSON.stringify(call)).toBe(400);
  }
});
