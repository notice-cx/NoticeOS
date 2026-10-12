import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskExecutor } from './hosted-task-executor.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';

// Against the real task store: the pinned task client on a
// disposable Dolt server (the CI task-store job; see db/dolt/host/README.md
// for the opt-in inputs). Ordinary suites skip it and never start Docker.

const origin = 'https://tower.example.com';
const SESSION = '55555555-5555-4555-8555-555555555555';
const ALICE = 'aaaaaaaa-1111-4111-8111-111111111111', BOB = 'bbbbbbbb-1111-4111-8111-111111111111';
const ACTIVE = ['open', 'in_progress', 'blocked', 'deferred'];
const first = value => Array.isArray(value) ? value[0] : value;

test('two servers racing one claim have one winner; a lost reply after a real create or comment is not repeated', {
  skip: process.env.NOTICEOS_TEST_HOSTED_TASK_EXECUTOR !== '1', timeout: 240_000,
}, async () => {
  // The fixture keeps one receipt per evidence folder, and pnpm test:task-store
  // runs another suite over the same folder first: this file keeps its own
  // inside it (each test file is its own process).
  process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE = mkdtempSync(
    path.join(process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE, 'task-operations-'));
  await withOwnedTaskProjects(async facts => {
    const [{ workspaceId, projectId }] = facts.mappings;
    // No shared lease between these two "servers": only the task store can
    // arbitrate their claims.
    const directory = {
      project: async (workspace, project) => facts.mappings.find(m => m.workspaceId === workspace && m.projectId === project) ?? null,
      withProjectMutation: async (workspace, project, controls, work) => work(Object.freeze({
        project: () => directory.project(workspace, project), signal: controls.signal ?? new AbortController().signal })),
      catalog: async () => Object.freeze([{ projectId, logicalKey: 'example', displayName: 'Example', prefix: 'tt' }]),
    };
    const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
    const server = principalId => {
      const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
        membership: async (_headers, workspace) => ({ principalId, sessionId: SESSION,
          expiresAt: expiresAt(), workspaceId: workspace, role: 'operator', workspaceStatus: 'active' }),
        agent: async (_request, workspace) => ({ principalId, clientId: 'example-agent', expiresAt: expiresAt(),
          scopes: ['tasks:read', 'tasks:write'], workspaceId: workspace, role: 'operator', workspaceStatus: 'active' }) });
      return { admission, executor: createHostedTaskExecutor({ admission, directory, resolveTarget: facts.resolveTarget,
        binary: facts.pinnedBinary, doltBinary: facts.pinnedDoltBinary, scratchRoot: facts.scratchRoot }) };
    };
    const proof = () => new Request(origin + '/api/tasks', { method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json', [WORKSPACE_SESSION_HEADER]: SESSION, [WORKSPACE_SELECTION_HEADER]: workspaceId } });
    const alice = server(ALICE), bob = server(BOB);
    const run = (side, operation) => side.executor.execute(proof(), workspaceId, { projectId, operation });

    for (let round = 0; round < 5; round++) {
      const { id } = first(await run(alice, { kind: 'create', title: `Claim race ${round}` }));
      const outcomes = await Promise.allSettled([alice, bob].map(side => run(side, { kind: 'update', taskId: id, claim: true })));
      assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1, `round ${round}: exactly one claim wins`);
      const winner = outcomes[0].status === 'fulfilled' ? ALICE : BOB;
      assert.equal(first(await run(alice, { kind: 'show', taskId: id })).assignee, winner);
      // The winner claiming again is a no-op, not a second effect or a refusal.
      await run(winner === ALICE ? alice : bob, { kind: 'update', taskId: id, claim: true });
    }

    // A reply lost after the real effect: the retry finds the task or comment
    // by its evidence and replays it.
    let lose = false;
    const lossy = { async execute(...args) {
      const value = await alice.executor.execute(...args);
      if (lose) { lose = false; throw new Error('reply lost after the effect'); }
      return value;
    } };
    const operations = createHostedTaskOperations({ admission: alice.admission, directory, executor: lossy, receipts: memoryReceipts(Date.now) });
    const create = { projectId, operation: { kind: 'create', title: 'Exactly once' } };
    lose = true;
    await assert.rejects(operations.write(proof(), workspaceId, create, 'compose-create-0001'));
    const replay = await operations.write(proof(), workspaceId, create, 'compose-create-0001');
    assert.equal(replay.replayed, true);
    const board = await run(alice, { kind: 'active-board', statuses: ACTIVE });
    assert.deepEqual(board.filter(row => row.title === 'Exactly once').map(row => row.id), [replay.value.id]);
    const comment = { projectId, operation: { kind: 'comment', taskId: replay.value.id, text: 'Exactly once' } };
    lose = true;
    await assert.rejects(operations.write(proof(), workspaceId, comment, 'compose-comment-0001'));
    assert.equal((await operations.write(proof(), workspaceId, comment, 'compose-comment-0001')).replayed, true);
    const comments = await run(alice, { kind: 'comments', taskId: replay.value.id });
    assert.equal(comments.filter(row => row.text === 'Exactly once' && row.author === ALICE).length, 1);

    // The MCP endpoint over the real store answers an agent in task language.
    const mcp = createHostedMcp({ profile: 'hosted', trustedOrigin: origin, operations, agents: {
      verify: async () => ({ scopes: ['tasks:read', 'tasks:write'] }),
      workspaces: async () => [{ workspaceId, displayName: 'Example', role: 'operator', status: 'active' }] } });
    const reply = await mcp(new Request(origin + MCP_PATH, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer compose-agent-token-0001' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_task', arguments: { workspace: workspaceId, project: projectId, task: replay.value.id } } }) }));
    const result = (await reply.json()).result;
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.task.id, replay.value.id);
    assert.equal(result.structuredContent.comments.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /issue_type|schema_version/u);

    // Dependencies and approvals: what is ready follows blocks edges and open
    // gates, and no ordinary write unhooks or closes a gate.
    let next = 10;
    const tool = async (name, args) => (await (await mcp(new Request(origin + MCP_PATH, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer compose-agent-token-0001' },
      body: JSON.stringify({ jsonrpc: '2.0', id: next++, method: 'tools/call',
        params: { name, arguments: { workspace: workspaceId, project: projectId, ...args } } }) }))).json()).result;
    const ok = async (name, args) => {
      const answer = await tool(name, args);
      assert.equal(answer.isError, undefined, `${name}: ${JSON.stringify(answer)}`);
      return answer.structuredContent;
    };
    const lead = await ok('create_task', { title: 'Lead', idempotency_key: 'compose-lead-0001' });
    assert.deepEqual(lead.lint, { missing: ['## Acceptance Criteria'] });
    const follow = await ok('create_task', { title: 'Follow', acceptance: 'It reads back', idempotency_key: 'compose-follow-0001' });
    assert.deepEqual(follow.lint, { missing: [] });
    assert.deepEqual((await ok('update_task', { task: lead.id, acceptance: 'It ships', idempotency_key: 'compose-lead-0002' })).lint, { missing: [] });
    const ready = async () => (await ok('list_tasks', { ready: true })).tasks.map(task => task.id);
    await ok('add_dependency', { task: follow.id, depends_on: lead.id });
    await ok('add_dependency', { task: follow.id, depends_on: lead.id });
    assert.equal((await ready()).includes(follow.id), false);
    assert.match((await tool('add_dependency', { task: follow.id, depends_on: lead.id, type: 'related' })).content[0].text, /^refused:/u);
    await ok('remove_dependency', { task: follow.id, depends_on: lead.id });
    assert.equal((await ready()).includes(follow.id), true);
    const asked = await ok('request_human_approval', { task: lead.id, reason: 'Approve the rollout' });
    assert.deepEqual([asked.created, asked.approval.status, asked.approval.reason], [true, 'open', 'Approve the rollout']);
    assert.deepEqual(await ok('request_human_approval', { task: lead.id, reason: 'Approve the rollout' }), { ...asked, created: false });
    assert.equal((await ready()).includes(lead.id), false);
    for (const [name, args] of [['remove_dependency', { task: lead.id, depends_on: asked.approval.id }],
      ['close_task', { task: asked.approval.id, reason: 'Approved it myself', idempotency_key: 'compose-gate-0001' }]]) {
      assert.match((await tool(name, args)).content[0].text, new RegExp(`^refused: ${asked.approval.id} is a person's decision`, 'u'), name);
    }
    const gated = (await ok('get_task', { task: lead.id })).task;
    assert.deepEqual(gated.dependencies.filter(edge => edge.id === asked.approval.id).map(edge => [edge.type, edge.status]), [['blocks', 'open']]);

    // A child filed under a person's decision carries only its own labels.
    const decision = await ok('create_task', { title: 'Decide the rollout', labels: ['human', 'area-rollout'], idempotency_key: 'compose-decision-0001' });
    const child = await ok('create_task', { title: 'Build the rollout', parent: decision.id, labels: ['frontend'], idempotency_key: 'compose-child-0001' });
    assert.deepEqual((await ok('get_task', { task: child.id })).task.labels, ['frontend']);

    // A decision files with its links and its approval in one call, and a
    // change answers with the task whole, parent and links included.
    const picked = await ok('create_task', { title: 'Pick the store', type: 'decision', parent: decision.id, depends_on: [lead.id],
      related: [follow.id], approval: 'Approve the spend', idempotency_key: 'compose-pick-0001' });
    assert.deepEqual([picked.held, picked.approval.status, picked.lint.missing.includes('## Decision')], [true, 'open', true]);
    const changed = (await ok('update_task', { task: picked.id, priority: 1, idempotency_key: 'compose-pick-0002' })).task;
    assert.deepEqual([changed.type, changed.parent, changed.dependencies.map(edge => `${edge.id} ${edge.type}`).sort()], ['decision', decision.id,
      [`${decision.id} parent-child`, `${follow.id} related`, `${lead.id} blocks`, `${picked.approval.id} blocks`].sort()]);

    // create_tasks: a place names a task the same call filed, and a retry files none twice.
    const plan = [{ title: 'Batch epic', type: 'epic' }, { title: 'Batch child', parent: '#0', depends_on: [lead.id] }];
    const filed = await ok('create_tasks', { tasks: plan, idempotency_key: 'compose-batch-0001' });
    assert.deepEqual((await ok('create_tasks', { tasks: plan, idempotency_key: 'compose-batch-0001' })).created.map(row => [row.id, row.replayed]),
      filed.created.map(row => [row.id, true]));
    assert.deepEqual((await ok('list_tasks', { parent: filed.created[0].id })).tasks.map(task => task.id), [filed.created[1].id]);
    assert.deepEqual((await ok('list_tasks', { query: 'batch CHILD' })).tasks.map(task => task.id), [filed.created[1].id]);

    // An agent names its model on its claim and on its close; the server
    // records who closed the task, at the close's own time.
    const named = await ok('create_task', { title: 'Named work', acceptance: 'It closes by name', idempotency_key: 'compose-named-0001' });
    const claimed = (await ok('claim_task', { task: named.id, model: 'Example Model 1', idempotency_key: 'compose-named-0002' })).task;
    assert.deepEqual([claimed.assignee, claimed.metadata?.noticeos_claimed_model], [ALICE, 'Example Model 1']);
    const done = (await ok('close_task', { task: named.id, reason: 'It reads back · abc1234', model: 'Example Model 1',
      idempotency_key: 'compose-named-0003' })).task;
    assert.deepEqual([done.status, done.metadata?.noticeos_closed_by, done.metadata?.noticeos_closed_model, done.metadata?.noticeos_claimed_model],
      ['closed', ALICE, 'Example Model 1', 'Example Model 1']);
    assert.ok(Math.abs(Date.parse(done.metadata.noticeos_closed_at) - Date.parse(done.closedAt)) <= 1000, JSON.stringify(done));
  });
});
