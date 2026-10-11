import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { createStandaloneTaskExecutor, standaloneProjectId, standaloneTaskDirectory, StandaloneTaskRefused } from './standalone-tasks.mjs';
import { HumanDecisionRefused } from './hosted-task-command.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// scripts/standalone-tasks.mts: a standalone installation's linked task
// projects behind the shared task operations, so its local MCP server offers
// the hosted task tools. The task client here is a stand-in that answers in
// the pinned client's JSON and records each command and folder.

const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6';
const origin = 'http://localhost';

function fixture({ human = [] } = {}) {
  const commands = [];
  const run = async (argv, cwd) => {
    commands.push({ argv: [...argv], cwd });
    const words = argv.filter(word => !word.startsWith('--'));
    if (words[0] === 'show') {
      const id = argv.at(-1);
      return { code: 0, stdout: JSON.stringify([{ id, title: 'Task', status: 'open', issue_type: id.endsWith('gate') ? 'gate' : 'task',
        labels: human.includes(id) ? ['human'] : [] }]) };
    }
    if (words[0] === 'create') return { code: 0, stdout: JSON.stringify({ id: 'ex-1', title: 'Created', status: 'open', issue_type: 'task' }) };
    if (words[0] === 'lint') return { code: 0, stdout: JSON.stringify({ total: 0, issues: 0, results: null }) };
    if (words[0] === 'fail') return { code: 1, stdout: '' };
    return { code: 0, stdout: JSON.stringify({ status: 'added' }) };
  };
  const admission = createWorkspaceAdmission({ kind: 'standalone', profile: Symbol(),
    authority: async () => ({ principalId: 'agent-1', workspaceId: WORKSPACE, workspaceStatus: 'active' }) });
  const projects = async () => [{ projectId: standaloneProjectId('example'), asset: 'example', prefix: 'ex', cwd: '/spokes/example' }];
  const executor = createStandaloneTaskExecutor({ admission, projects, run });
  const proof = () => new Request(origin + MCP_PATH, { method: 'POST' });
  const execute = operation => executor.execute(proof(), WORKSPACE, { projectId: standaloneProjectId('example'), operation });
  return { commands, admission, projects, run, executor, execute };
}

test('a project\'s id is a UUID derived from its asset alone, the same on every read', () => {
  const id = standaloneProjectId('example');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(standaloneProjectId('example'), id);
  assert.notEqual(standaloneProjectId('example-2'), id);
});

test('a task command runs in its project\'s folder as the admitted actor, inserted before every command word', async () => {
  const f = fixture();
  assert.equal((await f.execute({ kind: 'create', title: '--file=literal' })).id, 'ex-1');
  await f.execute({ kind: 'depend', taskId: 'ex-1', dependsOn: 'ex-2', type: 'blocks' });
  assert.deepEqual(f.commands.map(command => command.argv), [
    ['--sandbox', '--json', '--actor=agent-1', 'create', '--title=--file=literal', '--'],
    ['--sandbox', '--json', '--actor=agent-1', 'dep', 'add', '--type=blocks', '--', 'ex-1', 'ex-2']]);
  assert.ok(f.commands.every(command => command.cwd === '/spokes/example'));
});

test('decisions, the runner\'s poll, other workspaces and unknown projects are refused before any command', async () => {
  const f = fixture();
  for (const operation of [{ kind: 'respond', taskId: 'ex-1', response: 'Yes' }, { kind: 'resolve-gate', taskId: 'ex-gate' },
    { kind: 'dismiss', taskId: 'ex-1' }, { kind: 'snapshot', closedSince: '2026-10-01' }]) {
    await assert.rejects(f.execute(operation), StandaloneTaskRefused, operation.kind);
  }
  await assert.rejects(f.executor.execute(new Request(origin), '11111111-1111-4111-8111-111111111111',
    { projectId: standaloneProjectId('example'), operation: { kind: 'show', taskId: 'ex-1' } }));
  await assert.rejects(f.executor.execute(new Request(origin), WORKSPACE,
    { projectId: standaloneProjectId('other'), operation: { kind: 'show', taskId: 'ex-1' } }), StandaloneTaskRefused);
  await assert.rejects(f.execute({ kind: 'sql', query: 'DROP TABLE issues' }));
  assert.deepEqual(f.commands, []);
});

test('no ordinary write closes, unmarks or unhooks a person\'s decision', async () => {
  const f = fixture({ human: ['ex-ask'] });
  for (const [operation, decision] of [[{ kind: 'close', taskId: 'ex-gate', reason: 'Approved it myself' }, 'ex-gate'],
    [{ kind: 'update', taskId: 'ex-ask', removeLabels: ['human'] }, 'ex-ask'], [{ kind: 'update', taskId: 'ex-ask', status: 'closed' }, 'ex-ask'],
    [{ kind: 'undepend', taskId: 'ex-1', dependsOn: 'ex-gate' }, 'ex-gate'], [{ kind: 'undepend', taskId: 'ex-1', dependsOn: 'ex-ask' }, 'ex-ask']]) {
    await assert.rejects(f.execute(operation), error => error instanceof HumanDecisionRefused && error.taskId === decision, JSON.stringify(operation));
  }
  await assert.rejects(f.execute({ kind: 'update', taskId: 'ex-1', status: 'closed', addLabels: ['human'] }), StandaloneTaskRefused);
  assert.deepEqual(f.commands.filter(command => !command.argv.includes('show')), [], 'only reads ran');
  await f.execute({ kind: 'undepend', taskId: 'ex-1', dependsOn: 'ex-2' });
  assert.deepEqual(f.commands.at(-1).argv, ['--sandbox', '--json', '--actor=agent-1', 'dep', 'remove', '--', 'ex-1', 'ex-2']);
});

test('a failed or unreadable task command is a refusal, never a guess', async () => {
  const f = fixture();
  const executor = createStandaloneTaskExecutor({ admission: f.admission, projects: f.projects,
    run: async () => ({ code: 0, stdout: 'Created task ex-1' }) });
  await assert.rejects(executor.execute(new Request(origin), WORKSPACE,
    { projectId: standaloneProjectId('example'), operation: { kind: 'show', taskId: 'ex-1' } }), StandaloneTaskRefused);
  const failing = createStandaloneTaskExecutor({ admission: f.admission, projects: f.projects, run: async () => ({ code: 1, stdout: '{}' }) });
  await assert.rejects(failing.execute(new Request(origin), WORKSPACE,
    { projectId: standaloneProjectId('example'), operation: { kind: 'show', taskId: 'ex-1' } }), StandaloneTaskRefused);
});

test('the standalone MCP endpoint serves its one workspace in full, with no credential and the hosted task tools', async () => {
  const f = fixture();
  const operations = createHostedTaskOperations({ admission: f.admission, directory: standaloneTaskDirectory(f.projects),
    executor: f.executor, receipts: memoryReceipts(Date.now) });
  const mcp = createHostedMcp({ profile: 'standalone', trustedOrigin: origin, standaloneWorkspaceId: WORKSPACE, operations });
  let id = 1;
  const call = async (name, args, headers = {}) => mcp(new Request(origin + MCP_PATH, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }) }));
  const result = async (name, args) => (await (await call(name, args)).json()).result;
  assert.deepEqual((await result('list_workspaces', {})).structuredContent.workspaces,
    [{ workspaceId: WORKSPACE, name: 'This installation', role: 'owner', status: 'active', access: ['tasks:read', 'tasks:write'] }]);
  assert.deepEqual((await result('list_projects', { workspace: WORKSPACE })).structuredContent.projects,
    [{ projectId: standaloneProjectId('example'), key: 'example', name: 'example', prefix: 'ex' }]);
  const created = (await result('create_task', { workspace: WORKSPACE, project: standaloneProjectId('example'), title: 'Probe',
    idempotency_key: 'local-create-0001' })).structuredContent;
  assert.deepEqual(created, { id: 'ex-1', project: 'example', replayed: false, lint: { missing: [] } });
  assert.match((await result('list_tasks', { workspace: '11111111-1111-4111-8111-111111111111', project: standaloneProjectId('example') }))
    .content[0].text, /^invalid arguments: workspace/u);
  assert.equal((await call('list_workspaces', {}, { authorization: 'Bearer agent-token-0000000001' })).status, 400, 'no credential is taken');
  // An agent is told why a person's decision refuses its change, and what it can do instead.
  const decided = (await result('close_task', { workspace: WORKSPACE, project: standaloneProjectId('example'), task: 'ex-gate',
    reason: 'Approved it myself', idempotency_key: 'local-close-0001' })).content[0].text;
  assert.match(decided, /^refused: ex-gate is a person's decision, a gate or a task labelled human\. Only a person closes it, takes off its human label or removes a dependency on it, on Tasks in the Tower; ask with request_human_approval or a comment\.$/u);
  assert.match((await result('get_task', { workspace: WORKSPACE, project: standaloneProjectId('other'), task: 'ex-1' })).content[0].text,
    /^refused: this workspace, project or task is not available to you/u, 'every other refusal keeps one answer');
  for (const bad of [{}, { standaloneWorkspaceId: 'not-a-uuid' }, { standaloneWorkspaceId: WORKSPACE, demoWorkspaceId: WORKSPACE }]) {
    assert.throws(() => createHostedMcp({ profile: 'standalone', trustedOrigin: origin, operations, ...bad }), /configuration refused/u);
  }
  assert.throws(() => createHostedMcp({ profile: 'demo', trustedOrigin: origin, operations, demoWorkspaceId: WORKSPACE,
    standaloneWorkspaceId: WORKSPACE }), /configuration refused/u);
});
