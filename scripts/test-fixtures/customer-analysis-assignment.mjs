import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { AGENT_ACCESS_PATHS } from '../agent-access.mjs';
import { WORKSPACE_SELECTION_HEADER } from '../browser-request-policy.mjs';

async function agentToken(origin, person, scope) {
  const redirectUri = 'http://127.0.0.1:49195/oauth-test';
  const call = (path, init) => fetch(origin + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const json = { 'content-type': 'application/json' };
  const registration = await call('/api/auth/oauth2/register', { method: 'POST', headers: json, body: JSON.stringify({
    client_name: 'Saved analysis test reviewer', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'], response_types: ['code'], scope,
  }) });
  assert.equal(registration.status, 201);
  const { client_id } = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const resource = origin + '/api/mcp';
  const requested = new URLSearchParams({ client_id, scope, response_type: 'code', redirect_uri: redirectUri,
    resource, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  const consent = await call('/api/auth/oauth2/authorize?' + requested, { headers: { cookie: person.cookie, accept: 'application/json' } });
  assert.equal(consent.status, 200);
  const direction = await consent.json();
  assert.equal(direction.redirect, true);
  const pending = new URL(direction.url, origin);
  assert.equal(pending.pathname, '/agent-access');
  const accepted = await call(AGENT_ACCESS_PATHS.approve, { method: 'POST', headers: { ...person, ...json, origin },
    body: JSON.stringify({ oauth_query: pending.search.slice(1), accept: true }) });
  assert.equal(accepted.status, 200);
  const callback = new URL((await accepted.json()).url);
  assert.equal(callback.origin + callback.pathname, redirectUri);
  const exchanged = await call('/api/auth/oauth2/token', { method: 'POST', body: new URLSearchParams({
    client_id, resource, grant_type: 'authorization_code', code: callback.searchParams.get('code'),
    redirect_uri: redirectUri, code_verifier: verifier,
  }) });
  assert.equal(exchanged.status, 200);
  const { access_token } = await exchanged.json();
  assert.equal(typeof access_token, 'string');
  return access_token;
}

export async function assertAnalysisAssignment({ origin, http, owner, otherOwner, ntasks, cluster }) {
  const base = '/api/analysis-workflows';
  const projects = await http(base + '/assignments', { headers: owner.headers });
  assert.equal(projects.status, 200, await projects.clone().text());
  assert.deepEqual((await projects.json()).projects.map(project => project.projectId), [owner.projectId]);
  const created = await http(base, { headers: { ...owner.headers, 'idempotency-key': 'synthetic-analysis-workflow' },
    body: { name: 'Saved search review', template: 'weekly-search-review', assetIds: [owner.prefix + '.example'], trigger: { kind: 'manual' } } });
  assert.equal(created.status, 201, await created.clone().text());
  const { workflow } = await created.json();
  const runs = `${base}/${workflow.id}/runs`;
  const start = (key, body = {}) => http(runs, { headers: { ...owner.headers, 'idempotency-key': key }, body });
  const started = await start('synthetic-analysis-start');
  assert.equal(started.status, 201);
  const { run } = await started.json();
  const path = `${runs}/${run.id}`;
  const assign = (actor, projectId = actor.projectId) => http(path + '/assignment', { headers: actor.headers, body: { projectId } });
  assert.equal((await assign(owner, otherOwner.projectId)).status, 403);
  assert.equal((await assign(otherOwner)).status, 404);
  const first = await Promise.all([assign(owner), assign(owner)]);
  const filed = first.find(reply => reply.status === 201);
  assert.ok(filed, 'Exactly one request may file a task.');
  assert.equal(first.filter(reply => reply.status === 201).length, 1);
  const { assignment } = await filed.json();
  assert.equal(assignment.projectId, owner.projectId);
  assert.equal(typeof assignment.taskId, 'string');
  assert.deepEqual((await (await assign(owner)).json()).assignment, assignment);
  const visible = (await (await http(path, { headers: owner.headers })).json()).run;
  assert.deepEqual(visible.assignment, assignment);
  assert.equal(visible.completedAt, null);
  const found = await ntasks.tool('get_task', { task: assignment.taskId });
  assert.ok(found.task.description.includes(`${origin}/workflows?workflow=${workflow.id}&run=${run.id}`));
  assert.ok(found.task.description.includes('weekly-search-review version 1'));
  assert.ok(found.task.description.includes(owner.prefix + '.example'));
  const matched = await ntasks.tool('list_tasks', { query: run.id });
  assert.deepEqual(matched.tasks.map(task => task.id), [assignment.taskId]);
  await ntasks.tool('close_task', { task: assignment.taskId, reason: 'Synthetic reminder closed.', idempotency_key: 'close-analysis-fixture' });
  assert.equal((await (await http(path, { headers: owner.headers })).json()).run.completedAt, null);
  const retried = await start('synthetic-analysis-retry', { retryOf: run.id });
  assert.equal(retried.status, 201);
  const retryRun = (await retried.json()).run;
  assert.equal((await http(`${runs}/${retryRun.id}/assignment`, { headers: owner.headers, body: { projectId: owner.projectId } })).status, 409);
  const unsent = (await (await start('synthetic-analysis-never-sent')).json()).run;
  cluster.run(`INSERT INTO noticeos.analysis_workflow_assignments
    (workspace_id,workflow_id,run_id,project_id,assigned_by)
    SELECT workspace_id,workflow_id,run_id,:'project'::uuid,created_by FROM noticeos.analysis_workflow_runs
    WHERE workspace_id=:'workspace'::uuid AND run_id=:'run'::uuid`, {
    vars: { workspace: owner.headers[WORKSPACE_SELECTION_HEADER], run: unsent.id, project: owner.projectId },
  });
  const unsentPath = `${runs}/${unsent.id}/assignment`;
  const checkUnsent = await http(unsentPath + '/reconcile', { headers: owner.headers, body: {} });
  assert.equal(checkUnsent.status, 202);
  assert.equal((await checkUnsent.json()).assignment.deliveryStartedAt, null);
  assert.deepEqual((await ntasks.tool('list_tasks', { query: unsent.id })).tasks, []);
  const resend = () => http(unsentPath, { headers: owner.headers, body: { projectId: owner.projectId } });
  const retryDelivery = await Promise.all([resend(), resend()]);
  assert.equal(retryDelivery.filter(reply => reply.status === 201).length, 1);
  const recoveredTask = (await retryDelivery.find(reply => reply.status === 201).json()).assignment;
  assert.ok(recoveredTask.deliveryStartedAt);
  assert.deepEqual((await ntasks.tool('list_tasks', { query: unsent.id })).tasks.map(task => task.id), [recoveredTask.taskId]);

  const lost = (await (await start('synthetic-analysis-unconfirmed')).json()).run;
  cluster.run(`INSERT INTO noticeos.analysis_workflow_assignments
    (workspace_id,workflow_id,run_id,project_id,assigned_by,delivery_started_at)
    SELECT workspace_id,workflow_id,run_id,:'project'::uuid,created_by,now() FROM noticeos.analysis_workflow_runs
    WHERE workspace_id=:'workspace'::uuid AND run_id=:'run'::uuid`, {
    vars: { workspace: owner.headers[WORKSPACE_SELECTION_HEADER], run: lost.id, project: owner.projectId },
  });
  const lostLink = `${origin}/workflows?workflow=${workflow.id}&run=${lost.id}`;
  const unconfirmed = await ntasks.call('POST', '/api/tasks', { idempotencyKey: 'synthetic-lost-analysis-response',
    body: { projectId: owner.projectId, title: 'Review saved analysis', description: `Open in NoticeOS.\n\n${lostLink}` } });
  assert.ok([200, 201].includes(unconfirmed.status));
  const retryAssignment = await http(`${runs}/${lost.id}/assignment`, { headers: owner.headers, body: { projectId: owner.projectId } });
  assert.equal(retryAssignment.status, 202);
  const reconciled = await http(`${runs}/${lost.id}/assignment/reconcile`, { headers: owner.headers, body: {} });
  assert.equal(reconciled.status, 200);
  assert.equal((await reconciled.json()).assignment.taskId, unconfirmed.body.id);
  assert.deepEqual((await ntasks.tool('list_tasks', { query: lost.id })).tasks.map(task => task.id), [unconfirmed.body.id]);

  const mcp = (token, method, params, workspace = owner.headers[WORKSPACE_SELECTION_HEADER]) => http('/api/mcp', {
    headers: { authorization: `Bearer ${token}`, [WORKSPACE_SELECTION_HEADER]: workspace },
    body: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  });
  const selection = { workflowId: workflow.id, runId: run.id };
  const read = { name: 'read_analysis_run', arguments: selection };
  const evidenceToken = await agentToken(origin, owner.headers, 'evidence:read');
  assert.equal((await mcp(evidenceToken, 'tools/call', read)).status, 401);
  const reviewToken = await agentToken(origin, owner.headers, 'analysis:review');
  const tools = await mcp(reviewToken, 'tools/list');
  assert.equal(tools.status, 200);
  assert.deepEqual((await tools.json()).result.tools.map(tool => tool.name), ['read_analysis_run', 'complete_analysis_run']);
  assert.equal((await mcp(reviewToken, 'tools/call', read, otherOwner.headers[WORKSPACE_SELECTION_HEADER])).status, 401);
  const loaded = await mcp(reviewToken, 'tools/call', read);
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).result.structuredContent.run.id, run.id);
  const result = { outcome: 'insufficient-evidence', summary: 'The saved reports do not cover a comparable period.', findings: [] };
  const complete = { name: 'complete_analysis_run', arguments: { ...selection, result } };
  const finished = await mcp(reviewToken, 'tools/call', complete);
  assert.equal(finished.status, 200);
  assert.deepEqual((await finished.json()).result.structuredContent.run.result, result);
  assert.deepEqual((await (await http(path, { headers: owner.headers })).json()).run.result, result);
}
