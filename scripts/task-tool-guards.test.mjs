import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { createStandaloneTaskExecutor } from './standalone-tasks.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// The task tools' write guards and refusals end to end: the MCP endpoint, the shared
// operations and the standalone executor, over a stand-in task client that
// keeps the pinned client's close and claim rules (cmd/bd/close.go and
// internal/storage/issueops/close.go in Beads 1.3.1): a close refuses another
// holder, an open blocker and open children unless forced, and a re-close of a
// closed task changes nothing.

const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6';
const PROJECT = '0b7d6c4e-2f0a-4c55-8e3b-6a1f2d9c4e01';
const OTHER = '7c1e9a20-5d4b-4f3e-9a8c-2b6d0e4f1a17';
const FORMER = '3a6f0e1d-8b2c-4d7e-9f10-5c4b3a2d1e0f';
const AGENT = 'agent-1';
const origin = 'http://localhost';

/** One project's tasks as the task client keeps them. `failOnce` makes the
 * next command with that word apply its effect and then exit 1, as a client
 * killed after its commit would. */
function store() {
  const tasks = new Map(), edges = [], commands = [];
  let failOnce = null, slow = null, rival = null;
  const put = (id, fields = {}) => tasks.set(id, { id, title: id, status: 'open', priority: 2, issue_type: 'task', labels: [], assignee: '', ...fields });
  const link = (from, to, type = 'blocks') => edges.push({ from, to, type });
  const embed = (id, type) => ({ ...tasks.get(id), dependency_type: type });
  const detail = (id, dependents) => ({ ...tasks.get(id),
    dependencies: edges.filter(edge => edge.from === id).map(edge => embed(edge.to, edge.type)),
    ...(dependents ? { dependents: edges.filter(edge => edge.to === id).map(edge => embed(edge.from, edge.type)) } : {}) });
  const live = id => edges.filter(edge => edge.from === id && ['blocks', 'waits-for'].includes(edge.type) && tasks.get(edge.to).status !== 'closed');
  const ok = value => ({ code: 0, stdout: JSON.stringify(value) });
  const no = { code: 1, stdout: '' };
  const run = async (argv) => {
    commands.push([...argv]);
    const actor = argv.find(word => word.startsWith('--actor='))?.slice(8);
    const words = argv.filter(word => !['--sandbox', '--readonly', '--json'].includes(word) && !word.startsWith('--actor='));
    const id = argv.at(-1), flag = name => words.find(word => word.startsWith(`--${name}=`))?.slice(name.length + 3);
    const verb = words[0];
    if (slow === verb) { slow = null; return { code: 1, stdout: '', timedOut: true }; }
    // Another caller's write lands between this caller's read and its own write.
    if (rival?.verb === verb && !words.includes('show')) { const land = rival.land; rival = null; land(); }
    if (verb === 'show') return tasks.has(id) ? ok([detail(id, words.includes('--include-dependents'))]) : no;
    if (verb === 'ready') return ok([...tasks.values()].filter(task => task.status === 'open' && !live(task.id).length).map(task => ({ id: task.id })));
    if (verb === 'comments' && words[1] !== 'add' || verb === 'epic') return ok([]);
    if (verb === 'list' && flag('id')) return ok(flag('id').split(',').filter(key => tasks.has(key)).map(key => tasks.get(key)));
    if (verb === 'list') {
      const statuses = flag('status')?.split(',') ?? [];
      return ok([...tasks.values()].filter(task => statuses.includes(task.status)).map(task => detail(task.id, false)));
    }
    if (verb === 'comments' || verb === 'dep') {
      // comments add -- <task> <text>; dep add|remove -- <task> <depends-on>
      const named = argv.slice(argv.indexOf('--') + 1);
      if (verb === 'comments') return tasks.has(named[0]) ? ok({ id: 'c-1', issue_id: named[0], author: actor, text: named[1] }) : no;
      if (!tasks.has(named[0]) || !tasks.has(named[1])) return no;
      // One edge per pair, never retyped: adding it again with its own type changes nothing.
      const standing = edges.find(edge => edge.from === named[0] && edge.to === named[1]);
      if (words[1] === 'add' && standing && standing.type !== flag('type')) return no;
      if (words[1] === 'add' && !standing) link(named[0], named[1], flag('type'));
      return ok({ issue_id: named[0], depends_on_id: named[1], status: words[1] === 'add' ? 'added' : 'removed' });
    }
    if (!tasks.has(id)) return no;
    const task = tasks.get(id);
    let result;
    if (verb === 'close') {
      const force = words.includes('--force');
      if (task.status !== 'closed') {
        if (!force && task.assignee && task.assignee !== actor) return no;
        if (!force && edges.some(edge => edge.to === id && edge.type === 'parent-child' && tasks.get(edge.from).status !== 'closed')) return no;
        if (!force && live(id).length) return no;
        Object.assign(task, { status: 'closed', close_reason: flag('reason'), closed_at: '2026-10-16T12:00:00Z' });
      }
      result = [task];
    } else if (verb === 'update' && words.includes('--claim')) {
      if (task.assignee && task.assignee !== actor) return no;
      if (task.status !== 'open' && !(task.status === 'in_progress' && task.assignee === actor)) return no;
      Object.assign(task, { status: 'in_progress', assignee: actor });
      result = [task];
    } else if (verb === 'update' && flag('assignee') !== undefined) {
      // The task client lets only its holder hand on a task someone is working.
      if (task.status === 'in_progress' && task.assignee && task.assignee !== actor && task.assignee !== flag('assignee')) return no;
      task.assignee = flag('assignee');
      result = [task];
    } else if (verb === 'update') {
      const metadata = flag('metadata');
      if (metadata) task.metadata = { ...task.metadata, ...JSON.parse(metadata) };
      result = [task];
    } else return no;
    if (failOnce === verb) { failOnce = null; return no; }
    return ok(result);
  };
  return { tasks, edges, commands, put, link, run, failNext: verb => { failOnce = verb; }, slowNext: verb => { slow = verb; },
    rivalFirst: (verb, land) => { rival = { verb, land }; } };
}

function fixture({ admit = () => true } = {}) {
  const s = store();
  const admission = createWorkspaceAdmission({ kind: 'standalone', profile: Symbol(),
    authority: async () => admit() ? { principalId: AGENT, workspaceId: WORKSPACE, workspaceStatus: 'active' } : null });
  const projects = async () => [{ projectId: PROJECT, asset: 'example', prefix: 'ex', cwd: '/spokes/example' },
    { projectId: OTHER, asset: 'example-shop', prefix: 'sh', cwd: '/spokes/example-shop' }];
  const catalog = async () => [{ projectId: PROJECT, logicalKey: 'example', displayName: 'Example', prefix: 'ex' },
    { projectId: OTHER, logicalKey: 'example-shop', displayName: 'Example Shop', prefix: 'sh' }];
  // An id the example project went by before: the directory names the project it now is.
  const directory = { catalog, formerly: async (_workspace, projectId) => projectId === FORMER ? (await catalog())[0] : null };
  const executor = createStandaloneTaskExecutor({ admission, projects, run: (argv, cwd) => s.run(argv, cwd) });
  const operations = createHostedTaskOperations({ admission, directory, executor, receipts: memoryReceipts(Date.now) });
  const mcp = createHostedMcp({ profile: 'standalone', trustedOrigin: origin, standaloneWorkspaceId: WORKSPACE, operations });
  let id = 1;
  const call = async (name, args) => (await (await mcp(new Request(origin + MCP_PATH, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: { workspace: WORKSPACE, ...args } } }) }))).json()).result;
  const refusal = async (name, args) => {
    const result = await call(name, args);
    assert.equal(result.isError, true, JSON.stringify(result));
    return result.content[0].text;
  };
  const closes = () => s.commands.filter(argv => argv.includes('close'));
  return { ...s, call, refusal, closes };
}
const inProject = args => ({ project: PROJECT, ...args });

test('a task whose blocker is open closes with its reason, and the dependency still holds it out of ready work', async () => {
  const f = fixture();
  f.put('ex-ask', { labels: ['human'], issue_type: 'decision' });
  f.put('ex-work');
  f.link('ex-work', 'ex-ask');
  const ready = async () => (await f.call('list_tasks', inProject({ ready: true }))).structuredContent.tasks.map(task => task.id);
  assert.deepEqual(await ready(), ['ex-ask'], 'the dependency gates readiness');
  assert.equal((await f.call('claim_task', inProject({ task: 'ex-work', idempotency_key: 'claim-work-0001' }))).structuredContent.task.status,
    'in_progress', 'claiming it is allowed');
  const closed = (await f.call('close_task', inProject({ task: 'ex-work', reason: 'Shipped in abc123; evidence in the PR.',
    model: 'Example Model', idempotency_key: 'close-work-0001' }))).structuredContent;
  assert.deepEqual([closed.task.status, closed.task.closeReason, closed.replayed], ['closed', 'Shipped in abc123; evidence in the PR.', false]);
  assert.deepEqual(f.closes(), [['--sandbox', '--json', `--actor=${AGENT}`, 'close', '--reason=Shipped in abc123; evidence in the PR.', '--force', '--', 'ex-work']],
    'forced past the open blocker after the executor checked the task itself');
  assert.equal(f.tasks.get('ex-ask').status, 'open', 'the person\'s task is untouched');
  assert.equal(f.tasks.get('ex-work').metadata?.noticeos_closed_model, 'Example Model', 'the closer is recorded as for any close');
});

test('a task with nothing open closes without force, and a task labelled human still refuses an agent', async () => {
  const f = fixture();
  f.put('ex-done', { status: 'in_progress', assignee: AGENT });
  f.put('ex-ask', { labels: ['human'] });
  await f.call('close_task', inProject({ task: 'ex-done', reason: 'Done in abc123', idempotency_key: 'close-done-0001' }));
  assert.deepEqual(f.closes().map(argv => argv.includes('--force')), [false]);
  assert.equal(await f.refusal('close_task', inProject({ task: 'ex-ask', reason: 'Decided it myself', idempotency_key: 'close-ask-0001' })),
    'refused: ex-ask is a person\'s decision, a gate or a task labelled human. Only a person closes it, takes off its human label or removes '
    + 'a dependency on it, on Tasks in the Tower; ask with request_human_approval or a comment.');
  assert.equal(f.tasks.get('ex-ask').status, 'open');
  assert.equal(f.closes().length, 1, 'the refused close never reached the task client');
});

test('a close names what stops it: another holder, an open approval, open children, or an earlier close', async () => {
  const f = fixture();
  f.put('ex-held', { status: 'in_progress', assignee: 'alice' });
  f.put('ex-gated'); f.put('ex-gate', { issue_type: 'gate', await_type: 'human' }); f.link('ex-gated', 'ex-gate');
  f.put('ex-epic', { issue_type: 'epic' }); f.put('ex-epic.1'); f.put('ex-epic.2', { status: 'closed' }); f.put('ex-epic.3');
  for (const child of ['ex-epic.1', 'ex-epic.2', 'ex-epic.3']) f.link(child, 'ex-epic', 'parent-child');
  f.put('ex-closed', { status: 'closed', close_reason: 'Shipped earlier' });
  const close = (task, key) => f.refusal('close_task', inProject({ task, reason: 'Done in abc123', idempotency_key: key }));
  assert.equal(await close('ex-held', 'close-held-0001'), 'refused: ex-held is held by alice, and only its holder closes it. '
    + 'Reach alice with comment_on_task, or ask a person to close it on Tasks in the Tower.');
  assert.equal(await close('ex-gated', 'close-gated-0001'), 'refused: ex-gated waits on approval ex-gate, which is still open. '
    + 'Close ex-gated after a person approves it on Tasks in the Tower.');
  assert.equal(await close('ex-epic', 'close-epic-0001'), 'refused: ex-epic has open children: ex-epic.1 and ex-epic.3. '
    + 'Close them first, or give them another parent with update_task.');
  assert.equal(await close('ex-closed', 'close-closed-0001'), 'refused: ex-closed is already closed; get_task shows its close reason.');
  assert.deepEqual(f.closes(), [], 'each was refused from the task\'s own read, before any close ran');
  assert.equal(f.tasks.get('ex-closed').close_reason, 'Shipped earlier');
});

test('a close interrupted after it landed replays on a retry with the same key; a new key is told it is closed', async () => {
  const f = fixture();
  f.put('ex-work', { status: 'in_progress', assignee: AGENT }); f.put('ex-dep'); f.link('ex-work', 'ex-dep');
  const args = inProject({ task: 'ex-work', reason: 'Done in abc123', idempotency_key: 'close-work-0002' });
  f.failNext('close');
  assert.equal(await f.refusal('close_task', args), 'unavailable: the task store did not complete this call, and nothing in the task\'s state '
    + 'explains it. Retry the same call; with the same idempotency_key a change lands at most once.');
  assert.equal(f.tasks.get('ex-work').status, 'closed', 'the close landed although its answer was lost');
  const retried = (await f.call('close_task', args)).structuredContent;
  assert.deepEqual([retried.replayed, retried.task.status], [true, 'closed']);
  assert.equal(f.closes().length, 1, 'the retry found the earlier close instead of running another');
  assert.equal(await f.refusal('close_task', { ...args, idempotency_key: 'close-work-0003' }),
    'refused: ex-work is already closed; get_task shows its close reason.');
});

test('every refusal of a task names its cause and what to do next', async () => {
  const f = fixture();
  f.put('ex-held', { status: 'in_progress', assignee: 'alice' });
  f.put('ex-done', { status: 'closed', close_reason: 'Shipped' });
  f.put('ex-first'); f.put('ex-wait', { status: 'blocked' }); f.link('ex-wait', 'ex-first');
  f.put('ex-later', { status: 'deferred' });
  f.put('ex-mine');
  const claim = (task, key) => f.refusal('claim_task', inProject({ task, idempotency_key: key }));
  assert.equal(await claim('ex-held', 'claim-held-0001'),
    'refused: ex-held is held by alice. Choose another task, or reach alice with comment_on_task.');
  assert.equal(await claim('ex-done', 'claim-done-0001'),
    'refused: ex-done is closed, so it cannot be claimed. File work that remains with create_task.');
  assert.equal(await claim('ex-wait', 'claim-wait-0001'), 'refused: ex-wait has status blocked, and claim_task takes an open task. '
    + 'It depends on ex-first, still open. To work on it now, set its status to open with update_task, then claim it.');
  assert.equal(await claim('ex-later', 'claim-later-0001'), 'refused: ex-later has status deferred, and claim_task takes an open task. '
    + 'To work on it now, set its status to open with update_task, then claim it.');
  assert.equal(await f.refusal('update_task', inProject({ task: 'ex-held', assignee: 'bob', idempotency_key: 'give-held-0001' })),
    'refused: ex-held is held by alice, and only its holder or a person on Tasks in the Tower gives it to someone else.');
  assert.deepEqual(f.commands.filter(argv => argv.includes('--claim') || argv.some(word => word.startsWith('--assignee='))), [],
    'each was refused from the task\'s own read');
  const missing = `refused: ex-nope is not a task in projectId ${PROJECT} (Example); list_tasks lists its tasks.`;
  assert.equal(await f.refusal('get_task', inProject({ task: 'ex-nope' })), missing);
  assert.equal(await f.refusal('comment_on_task', inProject({ task: 'ex-nope', text: 'Found it', idempotency_key: 'note-nope-0001' })), missing);
  assert.equal(await f.refusal('add_dependency', inProject({ task: 'ex-mine', depends_on: 'ex-nope' })), missing,
    'the task named second is the one missing');
  assert.equal((await f.call('claim_task', inProject({ task: 'ex-mine', idempotency_key: 'claim-mine-0001' }))).structuredContent.task.assignee, AGENT);
});

test('a projectId the catalog no longer holds, or another project\'s task, names the project that holds it', async () => {
  const f = fixture();
  f.put('ex-mine');
  const STALE = '9d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
  assert.equal(await f.refusal('get_task', { project: STALE, task: 'ex-mine' }),
    `refused: projectId ${STALE} names no project in this workspace; tasks with prefix ex are in projectId ${PROJECT} (Example).`);
  assert.equal(await f.refusal('list_tasks', { project: STALE }),
    `refused: projectId ${STALE} names no project in this workspace; list_projects lists the current projectIds.`);
  assert.equal(await f.refusal('list_tasks', { project: FORMER }),
    `refused: projectId ${FORMER} names no project in this workspace; tasks with prefix ex are in projectId ${PROJECT} (Example).`,
    'an id the project went by before names the project without a task id');
  assert.equal(await f.refusal('close_task', { project: OTHER, task: 'ex-mine', reason: 'Done in abc123', idempotency_key: 'close-mine-0001' }),
    `refused: ex-mine is not in projectId ${OTHER} (Example Shop), whose tasks start sh-; tasks with prefix ex are in projectId ${PROJECT} (Example).`);
  assert.deepEqual(f.commands, [], 'refused from the catalog, before any command');
});

test('the task store failing is named apart from the task\'s state, and a call whose admission fails says nothing more', async () => {
  const f = fixture();
  f.put('ex-mine');
  f.slowNext('show');
  assert.equal(await f.refusal('get_task', inProject({ task: 'ex-mine' })),
    'unavailable: the task store did not answer in time. Retry the same call; with the same idempotency_key a change lands at most once.');
  assert.equal((await f.call('get_task', inProject({ task: 'ex-mine' }))).structuredContent.task.id, 'ex-mine', 'the retry reads it');
  const shut = fixture({ admit: () => false });
  shut.put('ex-mine');
  assert.equal(await shut.refusal('get_task', inProject({ task: 'ex-nope' })),
    'refused: this workspace, project or task is not available to you, or the change was not accepted');
  assert.deepEqual(shut.commands, []);
});

test('an argument past its limit names the limit, and a reused key says how to read or replace its change', async () => {
  const f = fixture();
  f.put('ex-mine', { status: 'in_progress', assignee: AGENT });
  assert.equal(await f.refusal('close_task', inProject({ task: 'ex-mine', reason: 'x'.repeat(2049), idempotency_key: 'close-mine-0002' })),
    'invalid arguments: reason (at most 2048 characters; this one has 2049)');
  assert.equal(await f.refusal('create_task', inProject({ title: 'Labelled', labels: ['ops,web'], idempotency_key: 'create-label-0001' })),
    'invalid arguments: labels (at most 32 labels, each at most 128 characters on one line, without commas or surrounding spaces, none twice)');
  assert.equal(await f.refusal('update_task', inProject({ task: 'ex-mine', add_labels: [], idempotency_key: 'label-mine-0001' })),
    'invalid arguments: add_labels (1 to 32 labels, each at most 128 characters on one line, without commas or surrounding spaces, none twice)');
  assert.equal(await f.refusal('update_task', inProject({ task: 'ex-mine', defer: '2026-13-01', idempotency_key: 'defer-mine-0001' })),
    'invalid arguments: defer (YYYY-MM-DD, or "" to clear it)');
  assert.equal(await f.refusal('close_task', inProject({ task: 'ex-mine', reason: '   ', idempotency_key: 'close-mine-0003' })),
    'invalid arguments: reason (empty)');
  await f.call('update_task', inProject({ task: 'ex-mine', title: 'First', idempotency_key: 'title-mine-0001' }));
  assert.equal(await f.refusal('update_task', inProject({ task: 'ex-mine', title: 'Second', idempotency_key: 'title-mine-0001' })),
    'conflict: this idempotency_key was first used for a different change. Resend that call unchanged to read its result, '
    + 'or choose a new key for this one.');
});

test('a write the task store refuses is named from the task as it stands after: a lost race or an edge of another type', async () => {
  const f = fixture();
  f.put('ex-race'); f.put('ex-held', { status: 'in_progress', assignee: AGENT }); f.put('ex-lead'); f.put('ex-follow');
  // Another caller's claim lands after this caller's read and before its own claim.
  f.rivalFirst('update', () => Object.assign(f.tasks.get('ex-race'), { status: 'in_progress', assignee: 'rival' }));
  assert.equal(await f.refusal('claim_task', inProject({ task: 'ex-race', idempotency_key: 'claim-race-0001' })),
    'refused: ex-race is held by rival. Choose another task, or reach rival with comment_on_task.');
  f.rivalFirst('close', () => { f.tasks.get('ex-held').assignee = 'rival'; });
  assert.equal(await f.refusal('close_task', inProject({ task: 'ex-held', reason: 'Done in abc123', idempotency_key: 'close-race-0001' })),
    'refused: ex-held is held by rival, and only its holder closes it. Reach rival with comment_on_task, or ask a person to close it on Tasks in the Tower.');
  // The task client keeps one edge per pair and never retypes it.
  const link = { task: 'ex-follow', depends_on: 'ex-lead' };
  assert.deepEqual((await f.call('add_dependency', inProject(link))).structuredContent, { task: 'ex-follow', dependsOn: 'ex-lead', type: 'blocks' });
  assert.equal((await f.call('add_dependency', inProject(link))).isError, undefined, 'the same edge again changes nothing');
  assert.equal(await f.refusal('add_dependency', inProject({ ...link, type: 'related' })),
    'refused: ex-follow already depends on ex-lead as blocks, and a dependency keeps the type it was added with. '
    + 'To record it as related, remove_dependency first, then add it again.');
  assert.deepEqual(f.edges.filter(edge => edge.from === 'ex-follow').map(edge => edge.type), ['blocks']);
});
