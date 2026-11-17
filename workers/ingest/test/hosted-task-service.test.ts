import { env } from 'cloudflare:test';
import { openWorkspaceStore } from '@noticeos/postgres';
import { expect, it } from 'vitest';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../../../scripts/browser-request-policy.mjs';
import { hostedTaskAuthorization, hostedTaskProof, hostedTaskRequest } from '../../../scripts/hosted-task-request.mjs';
import { createWorkspaceAdmission } from '../../../scripts/workspace-admission.mjs';
import { seedConfigDocuments } from '../src/config-store.js';
import { putCredential } from '../src/credentials.js';
import { refreshHostedTaskSummary } from '../src/hosted-task-summary.js';
import { handleHostedTaskService } from '../src/routes/hosted-task-service.js';
import { asOwner } from './helpers.js';
import type { HostedTaskSnapshotSource } from '../src/task-snapshots.js';

const TOWER = 'https://tower.example.test';
const NTASKS = 'https://ntasks.example.test';
const APP = '/api/tasks/service/app';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACCOUNT_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACCOUNT_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

it('uses separate project grants for the same Tower and saves only complete observed summaries', async () => {
  const first = await env.STORE.workspaceId();
  await asOwner(`INSERT INTO noticeos.workspaces(workspace_id, slug, display_name, status)
    VALUES ('${OTHER}', 'task-fixture', 'Task fixture', 'active')`);
  const stores = [first, OTHER].map(workspaceId => openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId }));
  const [north, south] = [
    { noticeos: first, ntasks: ACCOUNT_A, prefix: 'north', projectId: 'north-id', service: 'ntasks_service.synthetic-north', token: 'personal-north' },
    { noticeos: OTHER, ntasks: ACCOUNT_B, prefix: 'south', projectId: 'south-id', service: 'ntasks_service.synthetic-south', token: 'personal-south' },
  ] as const;
  const actors = [north, south];
  const workspaces = stores.map(STORE => ({ ...env, STORE, NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_NTASKS_ORIGIN: NTASKS }));
  let seq = 1, interruptedBoard = false, removeGrant = false;
  let captureFailure: 'board-unavailable' | 'board-refused' | 'feed-refused' | null = null;
  let expiredCursor: { after: number; status: 400 | 410 } | null = null;
  const cursors: number[] = [];
  const sends: { ntasks: string; token: string; path: string; method: string; key: string | null }[] = [];
  const start = Date.now();
  let clock = start;
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(NTASKS);
    const headers = new Headers(init?.headers);
    const ntasks = headers.get('x-ntasks-workspace');
    const token = (headers.get('authorization') ?? '').slice('Bearer '.length);
    const actor = actors.find(row => row.ntasks === ntasks && [row.service, row.token].some(value => value === token));
    if (!actor || removeGrant && actor === north) return Response.json({ error: 'refused' }, { status: 403 });
    const method = init?.method ?? 'GET';
    sends.push({ ntasks: actor.ntasks, token, path: url.pathname, method, key: headers.get('idempotency-key') });
    if (url.pathname === '/api/access/me') return Response.json(token === actor.service
      ? { kind: 'service', projects: [{ workspaceId: ntasks, projectId: actor.projectId, access: 'write' }] }
      : { kind: 'person', name: 'Fixture person', app: { workspaceId: ntasks, clientId: `${actor.prefix}-client`, scopes: ['tasks:decide'] } });
    if (url.pathname === '/api/tasks/projects') return Response.json({ projects: [{ projectId: actor.projectId, prefix: actor.prefix,
      logicalKey: actor.prefix, displayName: actor.prefix }] });
    if (url.pathname === '/api/changes') {
      if (captureFailure === 'feed-refused' && actor === north) return new Response('Refused', { status: 401 });
      const after = Number(url.searchParams.get('after'));
      if (actor === north) {
        cursors.push(after);
        if (expiredCursor?.after === after) return new Response('Expired cursor', { status: expiredCursor.status });
      }
      return Response.json({ events: after < seq ? [{ projectId: actor.projectId, seq }] : [], lastSeq: seq });
    }
    if (method === 'GET' && url.pathname === '/api/tasks') {
      if (interruptedBoard || captureFailure === 'board-refused' && url.searchParams.has('status')) {
        throw new Error('Fixture board read interrupted');
      }
      if (captureFailure === 'board-refused') return Response.json({ error: 'refused' }, { status: 403 });
      if (captureFailure === 'board-unavailable') return Response.json(null, { status: 503 });
    }
    if (method === 'POST') return Response.json({ id: `${actor.prefix}-new` }, { status: 201 });
    return Response.json({ readAt: new Date(clock).toISOString(), tasks: url.searchParams.has('label') || url.searchParams.has('status')
      ? [] : [{ id: `${actor.prefix}-one`, status: 'open', title: `Work for ${actor.prefix}`, priority: 2, issueType: 'task', ready: true, labels: [] }], epics: [] });
  };
  const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol('task test'), trustedOrigin: TOWER,
    membership: async (_headers, workspaceId) => ({ workspaceId, principalId: PERSON, sessionId: SESSION,
      role: 'owner', workspaceStatus: 'active', expiresAt: new Date(start + 3600_000).toISOString() }) });
  const request = (index: number, path: string, { method = 'GET', token = null, body, rawBody, contentType = 'application/json' }:
    { method?: string; token?: string | null; body?: unknown; rawBody?: string; contentType?: string } = {}) => {
    const workspace = actors[index]!;
    const session: Record<string, string> = path === APP
      ? { [WORKSPACE_SELECTION_HEADER]: workspace.noticeos, [WORKSPACE_SESSION_HEADER]: SESSION }
      : { authorization: `Bearer ${hostedTaskAuthorization(workspace.noticeos, SESSION, token)}` };
    const original = new Request(TOWER + path, { method, headers: { origin: TOWER, 'content-type': contentType,
      ...session, ...(method === 'GET' ? {} : { 'idempotency-key': 'fixture-task-write' }) },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const selected = hostedTaskRequest(original)!;
    return admission.withAdmission(selected.action, { requestedWorkspaceId: workspace.noticeos, correlationId: 'fixture' },
      hostedTaskProof(original, selected), context => handleHostedTaskService(original, workspaces[index]!, context, fixtureFetch));
  };
  try {
    for (const [i, actor] of actors.entries()) {
      const workspace = workspaces[i]!;
      expect(await seedConfigDocuments(workspace, {
        documents: { 'config/beads.json': { spokes: [{ asset: `${actor.prefix}.example`, prefix: actor.prefix, database: actor.prefix }] } },
        actor: 'fixture',
      })).toMatchObject({ ok: true });
      expect(await putCredential(workspace, { provider: 'ntasks', fields: {
        NTASKS_URL: NTASKS, NTASKS_TOKEN: actor.service, NTASKS_WORKSPACE_ID: actor.ntasks, NTASKS_APP_CLIENT_ID: `${actor.prefix}-client`,
      } })).toMatchObject({ ok: true });
      const listed = await request(i, '/api/tasks/projects');
      expect(await listed.json()).toMatchObject({ projects: [{ projectId: actor.projectId }] });
    }
    expect((await request(0, `/api/tasks?project=${south.projectId}`)).status).toBe(404);
    const requestsBeforeInvalid = sends.length;
    expect((await request(0, APP, { method: 'POST', body: null })).status).toBe(403);
    expect((await request(0, APP, { method: 'POST', rawBody: ' '.repeat(4096) + '{}' })).status).toBe(400);
    expect((await request(1, '/api/tasks', { method: 'POST', body: { projectId: south.projectId }, contentType: 'text/plain' })).status).toBe(400);
    expect((await request(1, '/api/tasks', { method: 'POST', body: { projectId: south.projectId, title: 'x'.repeat(512 * 1024) } })).status).toBe(400);
    expect(sends).toHaveLength(requestsBeforeInvalid);
    const app = await request(0, APP, { method: 'POST', body: {} });
    expect(await app.json()).toEqual({ clientId: 'north-client', held: false });
    const create = await request(1, '/api/tasks', { method: 'POST', body: { projectId: south.projectId, title: 'Work' } });
    expect(await create.json()).toEqual({ id: 'south-new' });
    expect(sends.at(-1)).toEqual({ ntasks: south.ntasks, token: south.service, method: 'POST', path: '/api/tasks', key: 'fixture-task-write' });
    const choose = `/api/tasks/${north.prefix}-one/choose`;
    const decision = { method: 'POST', body: { projectId: north.projectId, option: 'a' } } as const;
    expect((await request(0, choose, { ...decision, token: north.service })).status).toBe(401);
    expect((await request(0, choose, { ...decision, token: south.token })).status).toBe(401);
    expect(sends.some(row => row.path === choose)).toBe(false);
    expect((await request(0, choose, { ...decision, token: north.token })).status).toBe(201);
    expect(sends.at(-1)?.token).toBe(north.token);

    const refresh = (i: number) => refreshHostedTaskSummary(workspaces[i]!, { fetchImpl: fixtureFetch, now: () => clock });
    const read = (i: number) => stores[i]!.read(async tx => (await tx.query<{ payload: string }>(
      'SELECT payload::text FROM noticeos.task_snapshots ORDER BY captured_at DESC, snapshot_id DESC')).map(row => ({
      payload: JSON.parse(row.payload) as { ntasks: HostedTaskSnapshotSource; projects: { asset: string }[] },
    })));
    await refresh(0);
    await refresh(1);
    expect((await read(0))[0]?.payload.projects.map(project => project.asset)).toEqual(['north.example']);
    expect((await read(1))[0]?.payload.projects.map(project => project.asset)).toEqual(['south.example']);
    let previous = (await read(0))[0]!.payload;
    const callsAfterPublish = sends.length;
    await refresh(0);
    expect(sends).toHaveLength(callsAfterPublish);
    clock += 61_000;
    const boardsBeforeQuiet = sends.filter(row => row.method === 'GET' && row.path === '/api/tasks').length;
    await refresh(0);
    expect(sends.filter(row => row.method === 'GET' && row.path === '/api/tasks').length).toBe(boardsBeforeQuiet);
    expect((await read(0))[0]!.payload.ntasks.checkedAt).not.toBe(previous.ntasks.checkedAt);
    previous = (await read(0))[0]!.payload;
    clock += 61_000;
    seq++;
    interruptedBoard = true;
    await refresh(0);
    expect((await read(0))[0]!.payload).toEqual(previous);
    interruptedBoard = false;
    clock += 61_000;
    await refresh(0);
    const recovered = await read(0);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.payload.ntasks.cursor).toBe(seq);
    for (const status of [400, 410] as const) {
      expiredCursor = { after: seq, status };
      const cursorStart = cursors.length;
      seq++;
      clock += 61_000;
      await refresh(0);
      expect(cursors.slice(cursorStart)).toEqual([expiredCursor.after, 0, seq]);
      expect((await read(0))[0]!.payload.ntasks.cursor).toBe(seq);
    }
    expiredCursor = null;
    const beforeOutage = (await read(0))[0]!.payload;
    clock += 61_000;
    seq++;
    captureFailure = 'board-unavailable';
    await refresh(0);
    expect((await read(0))[0]!.payload).toEqual(beforeOutage);
    for (const refusal of ['board-refused', 'feed-refused'] as const) {
      captureFailure = refusal;
      clock += 61_000;
      await refresh(0);
      expect((await read(0))[0]!.payload).toMatchObject({ projects: [], ntasks: { mapping: 'unavailable' } });
      expect((await read(0))[1]!.payload.projects.map(project => project.asset)).toEqual(['north.example']);
      captureFailure = null;
      clock += 61_000;
      await refresh(0);
      expect((await read(0))[0]!.payload.projects.map(project => project.asset)).toEqual(['north.example']);
    }
    removeGrant = true;
    expect((await request(0, '/api/tasks/projects')).status).toBe(503);
    expect((await request(1, '/api/tasks/projects')).status).toBe(200);
    clock += 61_000;
    await refresh(0);
    const revoked = await read(0);
    expect(revoked[0]!.payload.projects).toEqual([]);
    expect(revoked[1]!.payload.projects.map(project => project.asset)).toEqual(['north.example']);
    expect((await read(1))[0]!.payload.projects.map(project => project.asset)).toEqual(['south.example']);
  } finally {
    await Promise.all(stores.map(store => store.close()));
  }
});

it('captures the full supported project set with bounded parallel reads and keeps it on a later timeout', async () => {
  const workspaceId = '99999999-9999-4999-8999-999999999999';
  await asOwner(`INSERT INTO noticeos.workspaces(workspace_id, slug, display_name, status)
    VALUES ('${workspaceId}', 'large-task-fixture', 'Large task fixture', 'active')`);
  const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
  const projects = Array.from({ length: 64 }, (_, index) => {
    const key = `site${index}`;
    return { projectId: `project-${key}`, prefix: key, logicalKey: key, displayName: key };
  });
  const start = Date.now();
  let clock = start, roundTrip = 200, pending = 0, peak = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(NTASKS);
    const arrival = clock + roundTrip;
    peak = Math.max(peak, ++pending);
    // Let the parallel requests leave before any simulated reply arrives.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    clock = Math.max(clock, arrival);
    pending--;
    if (url.pathname === '/api/access/me') return Response.json({ kind: 'service', projects: projects.map(project => ({
      workspaceId: ACCOUNT_A, projectId: project.projectId, access: 'read',
    })) });
    if (url.pathname === '/api/tasks/projects') return Response.json({ projects });
    if (url.pathname === '/api/changes') return Response.json({ events: [], lastSeq: 0 });
    expect(url.pathname).toBe('/api/tasks');
    expect(projects.some(project => project.projectId === url.searchParams.get('project'))).toBe(true);
    return Response.json({ tasks: [], epics: [] });
  };
  try {
    expect(await seedConfigDocuments({ ...env, STORE: store }, {
      documents: { 'config/beads.json': { spokes: projects.map(project => ({ asset: `${project.prefix}.example`,
        prefix: project.prefix, database: project.logicalKey })) } }, actor: 'fixture',
    })).toMatchObject({ ok: true });
    expect(await putCredential({ ...env, STORE: store }, { provider: 'ntasks', fields: {
      NTASKS_URL: NTASKS, NTASKS_TOKEN: 'ntasks_service.synthetic-large', NTASKS_WORKSPACE_ID: ACCOUNT_A,
    } })).toMatchObject({ ok: true });
    const refresh = () => refreshHostedTaskSummary({ ...env, STORE: store,
      NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_NTASKS_ORIGIN: NTASKS }, { fetchImpl, now: () => clock });
    const latest = async () => (await store.read(tx => tx.query<{ payload: string; captured_at: string }>(
      'SELECT payload::text, captured_at FROM noticeos.task_snapshots ORDER BY captured_at DESC LIMIT 1')))[0];

    const captured = await refresh();
    expect(captured, `elapsed ${clock - start}ms, peak ${peak}`).toBe(true);
    const saved = await latest();
    expect(JSON.parse(saved!.payload).projects.map((project: { asset: string }) => project.asset))
      .toEqual(projects.map(project => `${project.prefix}.example`));
    expect(peak).toBe(4);
    expect(clock - start).toBeGreaterThan(5_000);
    expect(clock - start).toBeLessThan(25_000);

    clock += 16 * 60_000;
    roundTrip = 1_000;
    expect(await refresh()).toBe(false);
    expect(await latest()).toEqual(saved);
    expect(pending).toBe(0);
  } finally { await store.close(); }
});
