import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { createStandaloneTaskExecutor } from './standalone-tasks.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// The task tools' write guards end to end: the MCP endpoint, the shared
// operations and the standalone executor, over a stand-in task client that
// keeps the pinned client's close and claim rules (cmd/bd/close.go and
// internal/storage/issueops/close.go in Beads 1.3.1): a close refuses another
// holder, an open blocker and open children unless forced, and a re-close of a
// closed task changes nothing.

const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6';
const PROJECT = '0b7d6c4e-2f0a-4c55-8e3b-6a1f2d9c4e01';
const OTHER = '7c1e9a20-5d4b-4f3e-9a8c-2b6d0e4f1a17';
const AGENT = 'agent-1';
const origin = 'http://localhost';

/** One project's tasks as the task client keeps them. `failOnce` makes the
 * next command with that word apply its effect and then exit 1, as a client
 * killed after its commit would. */
function store() {
  const tasks = new Map(), edges = [], commands = [];
  let failOnce = null;
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
    if (verb === 'show') return tasks.has(id) ? ok([detail(id, words.includes('--include-dependents'))]) : no;
    if (verb === 'ready') return ok([...tasks.values()].filter(task => task.status === 'open' && !live(task.id).length).map(task => ({ id: task.id })));
    if (verb === 'comments' || verb === 'epic') return ok([]);
    if (verb === 'list') {
      const statuses = flag('status')?.split(',') ?? [];
      return ok([...tasks.values()].filter(task => statuses.includes(task.status)).map(task => detail(task.id, false)));
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
    } else if (verb === 'update') {
      const metadata = flag('metadata');
      if (metadata) task.metadata = { ...task.metadata, ...JSON.parse(metadata) };
      result = [task];
    } else return no;
    if (failOnce === verb) { failOnce = null; return no; }
    return ok(result);
  };
  return { tasks, edges, commands, put, link, run, failNext: verb => { failOnce = verb; } };
}

function fixture() {
  const s = store();
  const admission = createWorkspaceAdmission({ kind: 'standalone', profile: Symbol(),
    authority: async () => ({ principalId: AGENT, workspaceId: WORKSPACE, workspaceStatus: 'active' }) });
  const projects = async () => [{ projectId: PROJECT, asset: 'example', prefix: 'ex', cwd: '/spokes/example' },
    { projectId: OTHER, asset: 'example-shop', prefix: 'sh', cwd: '/spokes/example-shop' }];
  const directory = { catalog: async () => [{ projectId: PROJECT, logicalKey: 'example', displayName: 'Example', prefix: 'ex' },
    { projectId: OTHER, logicalKey: 'example-shop', displayName: 'Example Shop', prefix: 'sh' }] };
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
  assert.match(await f.refusal('close_task', args), /^refused: /u);
  assert.equal(f.tasks.get('ex-work').status, 'closed', 'the close landed although its answer was lost');
  const retried = (await f.call('close_task', args)).structuredContent;
  assert.deepEqual([retried.replayed, retried.task.status], [true, 'closed']);
  assert.equal(f.closes().length, 1, 'the retry found the earlier close instead of running another');
  assert.equal(await f.refusal('close_task', { ...args, idempotency_key: 'close-work-0003' }),
    'refused: ex-work is already closed; get_task shows its close reason.');
});
