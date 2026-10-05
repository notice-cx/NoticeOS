import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedTaskHttp } from './hosted-task-http.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const origin = 'https://tower.example.test';
const proofHeaders = { origin, 'sec-fetch-site': 'same-origin', [WORKSPACE_SELECTION_HEADER]: A, [WORKSPACE_SESSION_HEADER]: S };
function request(path, method = 'GET', value, patch = {}) {
  return new Request(origin + path, { method, headers: { ...proofHeaders,
    ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...patch },
    ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
}
function fixture(profile = 'hosted') {
  const calls = [];
  const handler = createHostedTaskHttp({ profile, trustedOrigin: origin,
    ...(profile === 'demo' ? { demoWorkspaceId: A } : {}),
    executor: { execute: async (proof, workspaceId, command) => {
      calls.push({ proof, workspaceId, command }); return { id: 'tt-a' };
    } } });
  return { handler, calls };
}
test('actual route/method and bounded fields determine all seven operations', async () => {
  const f = fixture();
  const cases = [
    [request(`/api/tasks?project=${P}&limit=5&status=open`), { kind: 'list', limit: 5, status: 'open' }],
    [request(`/api/tasks/tt-a?project=${P}`), { kind: 'show', taskId: 'tt-a' }],
    [request(`/api/tasks/tt-a/history?project=${P}&limit=4`), { kind: 'history', taskId: 'tt-a', limit: 4 }],
    [request('/api/tasks', 'POST', { projectId: P, title: '--file=literal', priority: 2 }), { kind: 'create', title: '--file=literal', priority: 2 }],
    [request('/api/tasks/tt-a', 'PATCH', { projectId: P, title: 'New title', status: 'in_progress' }), { kind: 'update', taskId: 'tt-a', title: 'New title', status: 'in_progress' }],
    [request('/api/tasks/tt-a/comments', 'POST', { projectId: P, text: '--sql=literal' }), { kind: 'comment', taskId: 'tt-a', text: '--sql=literal' }],
    [request('/api/tasks/tt-a/close', 'POST', { projectId: P, reason: 'Recorded outcome' }), { kind: 'close', taskId: 'tt-a', reason: 'Recorded outcome' }],
  ];
  for (const [original, operation] of cases) {
    assert.equal((await f.handler(original)).status, 200);
    const call = f.calls.at(-1);
    assert.deepEqual(call.command, { projectId: P, operation });
    assert.equal(call.workspaceId, A); assert.equal(call.proof.url, original.url);
    assert.equal(call.proof.method, original.method); assert.equal(call.proof.body, null);
    assert.deepEqual([...call.proof.headers], [...original.headers]);
    assert.ok(Object.isFrozen(call.command) && Object.isFrozen(call.command.operation));
  }
});
test('only fixed decision paths bind bounded data and cannot supply target authority', async () => {
  const f = fixture();
  for (const [path, value, operation] of [
    ['/api/tasks/tt-a/respond', { response: '--file=literal' }, { kind: 'respond', taskId: 'tt-a', response: '--file=literal' }],
    ['/api/tasks/tt-a/dismiss', {}, { kind: 'dismiss', taskId: 'tt-a' }],
    ['/api/gates/tt-a/resolve', { reason: 'Approved locally' }, { kind: 'resolve-gate', taskId: 'tt-a', reason: 'Approved locally' }],
  ]) {
    assert.equal((await f.handler(request(path, 'POST', { projectId: P, ...value }))).status, 200);
    assert.deepEqual(f.calls.at(-1).command.operation, operation);
  }
  const count = f.calls.length;
  for (const [path, value] of [
    ['/api/tasks/tt-a/respond', { projectId: P, response: 'Answer', actor: 'operator' }],
    ['/api/tasks/tt-a/dismiss', { projectId: P, profile: 'standalone' }],
    ['/api/gates/tt-a/resolve', { projectId: P, workspaceId: A }],
    ['/api/tasks/tt-a/respond', `{"projectId":"${P}","response":"a","respon\\u0073e":"b"}`],
    ['/api/gates/tt-a/resolve', { projectId: P, taskId: 'tt-b' }],
  ]) assert.equal((await f.handler(request(path, 'POST', value))).status, 400);
  assert.equal((await f.handler(request(`/api/gates/tt-a/resolve?project=${P}`))).status, 400);
  assert.equal(f.calls.length, count);
});
test('query duplicates, unknown selectors and unsupported paths refuse before executor', async () => {
  const f = fixture();
  for (const path of [`/api/tasks?project=${P}&project=${P}`, `/api/tasks?project=${P}&actor=owner`,
    `/api/tasks?project=${P}&limit=201`, `/api/tasks?project=${P}&limit=01`, `/api/tasks?project=${P}&status=open,closed`,
    `/api/tasks/tt-a?project=${P}&limit=2`, `/api/tasks/tt-a/history?project=${P}&revision=main`,
    '/api/tasks', `/api/tasks/%74t-a?project=${P}`, `/api/tasks/tt-a/comments?project=${P}`]) {
    assert.equal((await f.handler(request(path))).status, 400, path);
  }
  assert.equal(f.calls.length, 0);
});
test('JSON extra authority/raw fields, nested values and escaped duplicate keys refuse', async () => {
  const f = fixture();
  for (const value of [{ projectId: P, title: 'Task', actor: 'owner' }, { projectId: P, title: 'Task', workspaceId: A },
    { projectId: P, title: 'Task', profile: 'standalone' }, { projectId: P, title: 'Task', file: '/tmp/foreign' },
    { projectId: P, title: 'Task', operation: 'sql' }, { projectId: P, title: {} }, { projectId: P, title: null },
    `{"projectId":"${P}","title":"first","ti\\u0074le":"second"}`,
    `{"projectId":"${P}","title":"first","__proto__":"raw"}`, '{"projectId":',
    `{"projectId":"${P}","title":"Task",}`, `\u00a0{"projectId":"${P}","title":"Task"}`]) {
    assert.equal((await f.handler(request('/api/tasks', 'POST', value))).status, 400);
  }
  for (const [path, method, value] of [['/api/tasks/tt-a', 'PATCH', { projectId: P }],
    ['/api/tasks/tt-a/comments', 'POST', { projectId: P, text: 'note', taskId: 'tt-b' }],
    ['/api/tasks/tt-a/close', 'POST', { projectId: P, reason: '' }],
    ['/api/tasks/tt-a/claim', 'POST', { projectId: P }]]) {
    assert.equal((await f.handler(request(path, method, value))).status, 400);
  }
  assert.equal(f.calls.length, 0);
});
test('oversized declared/streamed bodies, invalid UTF8 and content type refuse', async () => {
  const f = fixture();
  assert.equal((await f.handler(request('/api/tasks', 'POST', 'x'.repeat(32769)))).status, 400);
  assert.equal((await f.handler(request('/api/tasks', 'POST', { projectId: P, title: 'Task' }, { 'content-length': '32769' }))).status, 400);
  assert.equal((await f.handler(request('/api/tasks', 'POST', {}, { 'content-type': 'text/plain' }))).status, 400);
  const invalid = new Request(origin + '/api/tasks', { method: 'POST', headers: { ...proofHeaders, 'content-type': 'application/json' }, body: new Uint8Array([0xc0, 0x80]) });
  assert.equal((await f.handler(invalid)).status, 400); assert.equal(f.calls.length, 0);
});
test('stalled request stream is cancelled and refused before executor', async () => {
  const f = fixture(); let cancelled = 0;
  const original = new Request(origin + '/api/tasks', { method: 'POST', headers: { ...proofHeaders, 'content-type': 'application/json' },
    body: new ReadableStream({ cancel() { cancelled++; } }), duplex: 'half' });
  const before = Date.now(); assert.equal((await f.handler(original)).status, 400);
  assert.equal(cancelled, 1); assert.ok(Date.now() - before < 4000); assert.equal(f.calls.length, 0);
});
test('the whole body deadline bounds a never-settling cancellation promise', async () => {
  for (const oversized of [false, true]) {
    const f = fixture(); let cancelled = 0;
    const original = new Request(origin + '/api/tasks', { method: 'POST',
      headers: { ...proofHeaders, 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) { if (oversized) controller.enqueue(new Uint8Array(32769)); },
        cancel() { cancelled++; return new Promise(() => {}); },
      }), duplex: 'half' });
    const before = Date.now();
    assert.equal((await f.handler(original)).status, 400);
    assert.ok(Date.now() - before < 4000);
    assert.equal(cancelled, 1); assert.equal(original.body.locked, false);
    assert.equal(f.calls.length, 0);
  }
});
test('bounded arrays and handoff metadata preserve values and reject nested duplicate/extra fields', async () => {
  const f = fixture();
  const metadata = { noticeos_source: 'noticeos-handoff', noticeos_key: 'same bytes', noticeos_asset: 'example' };
  assert.equal((await f.handler(request('/api/tasks', 'POST', { projectId: P, title: 'Task',
    labels: ['asset:example', '--file=literal'], metadata, parent: 'tt-a', acceptance: 'Readback passed' }))).status, 200);
  assert.deepEqual({ ...f.calls[0].command.operation.metadata }, metadata);
  assert.deepEqual(f.calls[0].command.operation.labels, ['asset:example', '--file=literal']);
  assert.ok(Object.isFrozen(f.calls[0].command.operation.metadata));
  assert.ok(Object.isFrozen(f.calls[0].command.operation.labels));
  const before = f.calls.length;
  for (const text of [
    `{"projectId":"${P}","title":"Task","metadata":{"noticeos_key":"one","noticeos_\\u006bey":"two"}}`,
    JSON.stringify({ projectId: P, title: 'Task', metadata: { noticeos_key: { raw: 'selector' } } }),
    JSON.stringify({ projectId: P, title: 'Task', metadata: { unknown: 'selector' } }),
    JSON.stringify({ projectId: P, title: 'Task', labels: [['nested']] }),
    JSON.stringify({ projectId: P, title: 'Task', labels: Array(33).fill('label') }),
  ]) assert.equal((await f.handler(request('/api/tasks', 'POST', text))).status, 400);
  assert.equal(f.calls.length, before);
});
test('zero-byte microtask streams refuse without starving the whole-read deadline', async () => {
  const f = fixture(); let pulls = 0, cancelled = 0;
  const original = new Request(origin + '/api/tasks', { method: 'POST',
    headers: { ...proofHeaders, 'content-type': 'application/json' },
    body: new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array()); }, cancel() { cancelled++; } }), duplex: 'half' });
  assert.equal((await f.handler(original)).status, 400);
  assert.ok(pulls < 1100); assert.equal(cancelled, 1); assert.equal(f.calls.length, 0);
});
test('request abort releases a pending body read and refuses unissued work', async () => {
  const f = fixture(); const abort = new AbortController(); let cancelled = 0;
  const original = new Request(origin + '/api/tasks', { method: 'POST', signal: abort.signal,
    headers: { ...proofHeaders, 'content-type': 'application/json' },
    body: new ReadableStream({ cancel() { cancelled++; } }), duplex: 'half' });
  const work = f.handler(original); abort.abort();
  assert.equal((await work).status, 400);
  assert.equal(cancelled, 1); assert.equal(original.body.locked, false); assert.equal(f.calls.length, 0);
});
test('canonical target and exact workspace selection cannot be replaced by body or headers', async () => {
  const f = fixture();
  for (const selected of [undefined, 'not-a-uuid', A + ',' + B]) {
    const original = request(`/api/tasks?project=${P}`);
    if (selected === undefined) original.headers.delete(WORKSPACE_SELECTION_HEADER); else original.headers.set(WORKSPACE_SELECTION_HEADER, selected);
    assert.equal((await f.handler(original)).status, 400);
  }
  assert.equal((await f.handler(new Request('https://foreign.example.test/api/tasks?project=' + P, { headers: proofHeaders }))).status, 400);
  assert.equal(f.calls.length, 0);
  const demo = fixture('demo');
  assert.equal((await demo.handler(request(`/api/tasks?project=${P}`, 'GET', undefined, { [WORKSPACE_SELECTION_HEADER]: B }))).status, 400);
  const original = request(`/api/tasks?project=${P}`); original.headers.delete(WORKSPACE_SELECTION_HEADER);
  assert.equal((await demo.handler(original)).status, 200); assert.equal(demo.calls[0].workspaceId, A);
});
test('missing composition and executor errors return fixed secret-free responses', async () => {
  for (const trustedOrigin of ['https://foreign.example.test/path', 'http://foreign.example.test', 'https://user:secret@example.test']) {
    assert.throws(() => createHostedTaskHttp({ profile: 'hosted', trustedOrigin }));
  }
  assert.throws(() => createHostedTaskHttp({ profile: 'standalone', trustedOrigin: origin }));
  const missing = createHostedTaskHttp({ profile: 'hosted', trustedOrigin: origin });
  assert.equal((await missing(request(`/api/tasks?project=${P}`))).status, 503);
  const denied = createHostedTaskHttp({ profile: 'hosted', trustedOrigin: origin, executor: { execute: async () => { throw new Error('private credential and profile'); } } });
  const response = await denied(request(`/api/tasks?project=${P}`));
  assert.equal(response.status, 403); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'hosted_task_refused' });
});
