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

// Epic ro-cvl9 against the real task store: the pinned task client on a
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
  });
});
