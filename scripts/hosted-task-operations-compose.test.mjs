import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskExecutor } from './hosted-task-executor.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { TaskStateRefused } from './hosted-task-command.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';

// Against the real task store: the pinned task client on a
// disposable Dolt server (the CI task-store job; see db/dolt/host/README.md
// for the opt-in inputs). Ordinary suites skip it and never start Docker.

const origin = 'https://tower.example.com';
const SESSION = '55555555-5555-4555-8555-555555555555';
const ALICE = 'aaaaaaaa-1111-4111-8111-111111111111', BOB = 'bbbbbbbb-1111-4111-8111-111111111111';
const OTHER_PROJECT = 'cccccccc-1111-4111-8111-111111111111';
const WORKSPACE = 'dddddddd-1111-4111-8111-111111111111';
// Two projects in one workspace, so a read of every project crosses both.
const PROJECTS = Object.freeze([
  { workspaceId: WORKSPACE, projectId: 'eeeeeeee-1111-4111-8111-111111111111', databaseId: randomUUID() },
  { workspaceId: WORKSPACE, projectId: 'ffffffff-1111-4111-8111-111111111111', databaseId: randomUUID(), prefix: 'yy' },
]);
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
    const [{ workspaceId, projectId }, second] = facts.mappings;
    // No shared lease between these two "servers": only the task store can
    // arbitrate their claims.
    const directory = {
      project: async (workspace, project) => facts.mappings.find(m => m.workspaceId === workspace && m.projectId === project) ?? null,
      withProjectMutation: async (workspace, project, controls, work) => work(Object.freeze({
        project: () => directory.project(workspace, project), signal: controls.signal ?? new AbortController().signal })),
      // A third project, never mapped, holds the prefix a refusal names as
      // another project's, and is the one a read of every project cannot read.
      catalog: async () => Object.freeze([{ projectId, logicalKey: 'example', displayName: 'Example', prefix: 'tt' },
        { projectId: second.projectId, logicalKey: 'second', displayName: 'Second', prefix: 'yy' },
        { projectId: OTHER_PROJECT, logicalKey: 'other', displayName: 'Other', prefix: 'zz' }]),
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
      const refused = await tool(name, args);
      assert.equal(refused.isError, true, name);
      assert.ok(refused.content[0].text.startsWith(`refused: ${asked.approval.id} is a human request.`), name);
      assert.match(refused.content[0].text, /Use reconcile_task/u, name);
    }
    assert.equal((await ready()).includes(lead.id), false);
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

    // A person's pick as data: filed with three choices, read back by get_task
    // and list_tasks, replaced whole and taken off; a malformed set files nothing.
    const pick = { question: 'Which page keeps the traffic?', options: [{ key: 'a', label: 'Keep the old page' },
      { key: 'b', label: 'Redirect to the new page', detail: 'The old page answers 301.', recommended: true }, { key: 'c', label: 'Keep both' }] };
    const asking = await ok('create_task', { title: 'Pick the page', labels: ['human'], description: 'Choose which page keeps the traffic.',
      acceptance: 'A person chose', choices: pick, model: 'Example Model 1', idempotency_key: 'compose-choices-0001' });
    assert.equal('advice' in asking.lint, false);
    const filedPick = (await ok('get_task', { task: asking.id })).task;
    assert.deepEqual([filedPick.choices, filedPick.choice, filedPick.metadata.noticeos_choices, filedPick.metadata.noticeos_filed_model],
      [pick, null, pick, 'Example Model 1']);
    assert.deepEqual(filedPick.choices.options.filter(option => option.recommended).map(option => option.key), ['b']);
    assert.deepEqual((await ok('list_tasks', { labels: ['human'] })).tasks.find(task => task.id === asking.id)?.choices, pick);
    const two = { question: 'Keep it?', options: [{ key: 'a', label: 'Yes', recommended: true }, { key: 'b', label: 'No' }] };
    assert.deepEqual((await ok('update_task', { task: asking.id, choices: two, idempotency_key: 'compose-choices-0002' })).task.choices, two);
    const cleared = (await ok('update_task', { task: asking.id, choices: null, idempotency_key: 'compose-choices-0003' })).task;
    assert.deepEqual([cleared.choices, 'noticeos_choices' in (cleared.metadata ?? {}), cleared.metadata?.noticeos_filed_model], [null, false, 'Example Model 1']);
    const prose = await ok('update_task', { task: asking.id, description: 'Pick one.\n(a) Keep the old page\n(b) Redirect it',
      idempotency_key: 'compose-choices-0004' });
    assert.match(prose.lint.advice?.[0] ?? '', /^choices: the description offers lettered options/u);
    assert.equal((await tool('create_task', { title: 'Bad pick', choices: { ...pick, options: pick.options.slice(0, 1) },
      idempotency_key: 'compose-choices-0005' })).content[0].text, 'invalid arguments: choices.options (2 to 6 options)');

    // A person's pick: recorded and commented, the human label off, the
    // assignee cleared and the task back in ready work; a decision closes on
    // its pick and the task waiting on it becomes ready.
    const decide = async operation => (await operations.write(proof(), workspaceId, { projectId, operation })).value;
    const handed = await ok('create_task', { title: 'Pick the copy', labels: ['human'], acceptance: 'Shipped', choices: pick,
      idempotency_key: 'compose-choose-0001' });
    await ok('claim_task', { task: handed.id, idempotency_key: 'compose-choose-0002' });
    assert.deepEqual(await decide({ kind: 'choose', taskId: handed.id, option: 'b', note: 'Ship it Friday' }), { id: handed.id, status: 'open' });
    const back = await ok('get_task', { task: handed.id });
    assert.deepEqual([back.task.status, back.task.assignee, back.task.labels, back.task.choice?.option, back.task.choice?.label,
      back.task.choice?.by, back.task.choice?.note], ['open', null, [], 'b', 'Redirect to the new page', ALICE, 'Ship it Friday']);
    assert.ok(back.comments.some(comment => comment.author === ALICE && comment.text === 'Chose (b) Redirect to the new page. Ship it Friday'),
      JSON.stringify(back.comments));
    assert.ok((await ready()).includes(handed.id), 'ready for any agent');
    const refusedFor = kind => error => error instanceof TaskStateRefused && error.reason.kind === kind;
    await assert.rejects(decide({ kind: 'choose', taskId: handed.id, option: 'a' }), refusedFor('chosen'), 'a second pick');
    assert.match((await tool('update_task', { task: handed.id, choices: null, idempotency_key: 'compose-choose-0003' })).content[0].text,
      /^refused: \S+ already carries a person's choice, \(b\) Redirect to the new page/u);
    await assert.rejects(decide({ kind: 'choose', taskId: follow.id, option: 'a' }), refusedFor('no-choices'));
    const colour = await ok('create_task', { title: 'Pick a colour', labels: ['human'], choices: two, idempotency_key: 'compose-choose-0004' });
    await assert.rejects(decide({ kind: 'choose', taskId: colour.id, option: 'c' }), refusedFor('no-option'));
    const vendor = await ok('create_task', { title: 'Pick the vendor', type: 'decision', labels: ['human'], choices: two,
      idempotency_key: 'compose-choose-0005' });
    const signing = await ok('create_task', { title: 'Sign the vendor', depends_on: [vendor.id], acceptance: 'Signed',
      idempotency_key: 'compose-choose-0006' });
    assert.equal((await ready()).includes(signing.id), false);
    assert.deepEqual(await decide({ kind: 'choose', taskId: vendor.id, option: 'a' }), { id: vendor.id, status: 'closed' });
    const decided = (await ok('get_task', { task: vendor.id })).task;
    assert.deepEqual([decided.status, decided.closeReason, decided.choice?.option], ['closed', 'Chose (a) Yes', 'a']);
    assert.ok((await ready()).includes(signing.id), 'the task waiting on the decision is ready');

    // A free-text answer hands a task that is not a decision back; a decision closes on it.
    const region = await ok('create_task', { title: 'Which region?', labels: ['human'], acceptance: 'Answered', idempotency_key: 'compose-answer-0001' });
    assert.deepEqual(await decide({ kind: 'respond', taskId: region.id, response: 'Use the closest one' }), { id: region.id, status: 'open' });
    const answered = await ok('get_task', { task: region.id });
    assert.deepEqual([answered.task.status, answered.task.labels, answered.comments.map(comment => comment.text)],
      ['open', [], ['Answered: Use the closest one']]);
    const zone = await ok('create_task', { title: 'Pick a zone', type: 'decision', labels: ['human'], idempotency_key: 'compose-answer-0002' });
    assert.deepEqual(await decide({ kind: 'respond', taskId: zone.id, response: 'The closest one' }), { id: zone.id, status: 'closed' });
    assert.equal((await ok('get_task', { task: zone.id })).task.closeReason, 'Responded');

    // A close names how it ended, beside its closer: each resolution reads
    // back from get_task and list_tasks with the reason as given, no
    // resolution reads as done, a duplicate links the other task, and Dismiss
    // reads as won't do.
    const ended = new Map();
    for (const [index, resolution] of [undefined, 'done', 'wont-do', 'cant-reproduce', 'already-handled'].entries()) {
      const item = await ok('create_task', { title: `Resolve ${index}`, acceptance: 'Closed', idempotency_key: `compose-resolve-000${index}` });
      const closed = (await ok('close_task', { task: item.id, reason: `Evidence ${index}`, ...(resolution === undefined ? {} : { resolution }),
        idempotency_key: `compose-resolve-010${index}` })).task;
      assert.deepEqual([closed.status, closed.closeReason, closed.resolution, closed.metadata?.noticeos_closed_by],
        ['closed', `Evidence ${index}`, resolution ?? 'done', ALICE]);
      ended.set(item.id, resolution ?? 'done');
    }
    const original = await ok('create_task', { title: 'The original', acceptance: 'Kept', idempotency_key: 'compose-resolve-0201' });
    const copy = await ok('create_task', { title: 'The copy', acceptance: 'Closed', idempotency_key: 'compose-resolve-0202' });
    assert.match((await tool('close_task', { task: copy.id, reason: 'Same work', resolution: 'fixed', idempotency_key: 'compose-resolve-0203' }))
      .content[0].text, /^invalid arguments: resolution \(one of done, wont-do, duplicate, cant-reproduce, already-handled\)$/u);
    assert.match((await tool('close_task', { task: copy.id, reason: 'Same work', resolution: 'duplicate', duplicate_of: 'zz-1',
      idempotency_key: 'compose-resolve-0204' })).content[0].text, /^refused: zz-1 is not in projectId .*tasks with prefix zz are in projectId/u);
    assert.match((await tool('close_task', { task: copy.id, reason: 'Same work', resolution: 'duplicate', duplicate_of: `${original.id}9`,
      idempotency_key: 'compose-resolve-0205' })).content[0].text, new RegExp(`^refused: ${original.id}9 is not a task in projectId`, 'u'));
    assert.equal((await ok('get_task', { task: copy.id })).task.status, 'open', 'a refused duplicate closes nothing');
    const duplicate = (await ok('close_task', { task: copy.id, reason: 'Same work as the original', resolution: 'duplicate', duplicate_of: original.id,
      idempotency_key: 'compose-resolve-0206' })).task;
    assert.deepEqual([duplicate.closeReason, duplicate.resolution, duplicate.duplicateOf], ['Same work as the original', 'duplicate', original.id]);
    assert.ok(duplicate.dependencies.some(edge => edge.id === original.id && edge.type === 'related'), JSON.stringify(duplicate.dependencies));
    ended.set(copy.id, 'duplicate');
    const listed = (await ok('list_tasks', { status: ['closed'], limit: 200 })).tasks;
    for (const [id, resolution] of ended) assert.equal(listed.find(task => task.id === id)?.resolution, resolution, id);
    assert.equal(listed.find(task => task.id === copy.id)?.duplicateOf, original.id);
    const ask = await ok('create_task', { title: 'Should we?', labels: ['human'], acceptance: 'Answered', idempotency_key: 'compose-resolve-0301' });
    assert.deepEqual(await decide({ kind: 'dismiss', taskId: ask.id }), { id: ask.id, status: 'closed' });
    const dismissed = (await ok('get_task', { task: ask.id })).task;
    assert.deepEqual([dismissed.closeReason, dismissed.resolution, dismissed.metadata?.noticeos_closed_by], ['Dismissed', 'wont-do', ALICE]);

    // list_tasks with no project: rows from both mapped projects, each naming
    // its project, most urgent first and paged; the unmapped project is named
    // as unavailable; assignee "me" keeps the caller's own tasks. With a
    // project the reply keeps its fields, and its rows are the same rows.
    const anywhere = async (name, args) => {
      const answer = (await (await mcp(new Request(origin + MCP_PATH, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer compose-agent-token-0001' },
        body: JSON.stringify({ jsonrpc: '2.0', id: next++, method: 'tools/call',
          params: { name, arguments: { workspace: workspaceId, ...args } } }) }))).json()).result;
      assert.equal(answer.isError, undefined, `${name}: ${JSON.stringify(answer)}`);
      return answer.structuredContent;
    };
    const there = await anywhere('create_task', { project: second.projectId, title: 'Second project work', priority: 0, acceptance: 'Listed',
      idempotency_key: 'compose-every-0001' });
    assert.match(there.id, /^yy-/u);
    await anywhere('claim_task', { project: second.projectId, task: there.id, model: 'Example Model 1', idempotency_key: 'compose-every-0002' });
    const all = await anywhere('list_tasks', { limit: 200 });
    assert.deepEqual(all.unavailable, [{ project: 'other', projectId: OTHER_PROJECT, projectName: 'Other' }]);
    assert.deepEqual([...new Set(all.tasks.map(task => task.project))].sort(), ['example', 'second']);
    assert.ok(all.tasks.every(task => task.projectId === (task.project === 'second' ? second.projectId : projectId)
      && task.projectName === (task.project === 'second' ? 'Second' : 'Example')), JSON.stringify(all.tasks));
    assert.equal(all.total, all.tasks.length);
    assert.ok(all.tasks.every((task, i) => i === 0 || all.tasks[i - 1].priority <= task.priority), 'most urgent first across projects');
    const here = await ok('list_tasks', { limit: 200 });
    assert.deepEqual(Object.keys(here).sort(), ['closedSince', 'nextOffset', 'project', 'readAt', 'tasks', 'total']);
    const strip = ({ project: _key, projectId: _id, projectName: _name, ...row }) => row;
    assert.deepEqual(all.tasks.filter(task => task.project === 'example').map(strip), here.tasks);
    const pageOne = await anywhere('list_tasks', { limit: 3 });
    const pageTwo = await anywhere('list_tasks', { limit: 3, offset: pageOne.nextOffset });
    assert.deepEqual([pageOne.total, pageOne.nextOffset], [all.total, 3]);
    assert.deepEqual([...pageOne.tasks, ...pageTwo.tasks].map(task => task.id), all.tasks.slice(0, 6).map(task => task.id));
    const mine = (await anywhere('list_tasks', { assignee: 'me', limit: 200 })).tasks;
    assert.ok(mine.some(task => task.id === there.id && task.project === 'second'), JSON.stringify(mine));
    assert.deepEqual(mine.map(task => task.id), all.tasks.filter(task => task.assignee === ALICE).map(task => task.id));
    assert.deepEqual((await anywhere('list_tasks', { assignee: BOB, limit: 200 })).tasks.map(task => task.id),
      all.tasks.filter(task => task.assignee === BOB).map(task => task.id));
    assert.deepEqual((await ok('list_tasks', { assignee: 'me', limit: 200 })).tasks.map(task => task.id),
      here.tasks.filter(task => task.assignee === ALICE).map(task => task.id), 'one project');
  }, { projects: PROJECTS });
});
