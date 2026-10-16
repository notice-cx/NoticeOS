import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { createStandaloneTaskExecutor, formerStandaloneProjectId, standaloneProjectId, standaloneTaskDirectory,
  StandaloneTaskRefused } from './standalone-tasks.mjs';
import { linkedProjects } from './standalone-mcp.mjs';
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
    if (words[0] === 'ready' || words[0] === 'comments') return { code: 0, stdout: '[]' };
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

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

test('a project\'s id is a UUID derived from its database alone, the same on every read and never a site-derived id', () => {
  const id = standaloneProjectId('example');
  assert.match(id, UUID_V8);
  assert.equal(standaloneProjectId('example'), id);
  assert.notEqual(standaloneProjectId('example_2'), id);
  assert.match(formerStandaloneProjectId('example.com'), UUID_V8);
  assert.notEqual(formerStandaloneProjectId('example'), id, 'a site and a database with one name answer different ids');
});

/** The tools an agent calls, over a linked-project read and a site list. */
function endpoint({ read, sites }) {
  const f = fixture();
  const projects = linkedProjects({ read, root: '/spokes', now: () => 0 });
  const directory = standaloneTaskDirectory(projects, sites);
  const executor = createStandaloneTaskExecutor({ admission: f.admission, projects, run: f.run });
  const mcp = createHostedMcp({ profile: 'standalone', trustedOrigin: origin, standaloneWorkspaceId: WORKSPACE,
    operations: createHostedTaskOperations({ admission: f.admission, directory, executor, receipts: memoryReceipts(Date.now) }) });
  const call = async (name, args) => (await (await mcp(new Request(origin + MCP_PATH, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { workspace: WORKSPACE, ...args } } }) }))).json()).result;
  const listed = async () => (await call('list_projects', {})).structuredContent.projects;
  return { directory, call, listed, commands: f.commands };
}

const SITES = [{ id: 'os-1f2e', displayName: 'Stored name of the OS row', isOs: true },
  { id: 'example.com', displayName: 'Example', isOs: false }, { id: 'example.org', displayName: 'Example Org', isOs: 0 }];

test('a project moved to another site keeps its projectId, and the site it left gives its id to no other project', async () => {
  let rows = [{ asset: 'os-1f2e', prefix: 'ex', database: 'ex', repo: 'ex' }];
  const tools = () => endpoint({ read: async () => rows, sites: async () => SITES });
  const before = await tools().listed();
  assert.deepEqual(before, [{ projectId: standaloneProjectId('ex'), key: 'os-1f2e', name: 'System', prefix: 'ex' }]);
  // The Site cell of the ex row is edited, then a new project takes the site it left.
  rows = [{ asset: 'example.com', prefix: 'ex', database: 'ex', repo: 'ex' }, { asset: 'os-1f2e', prefix: 'sy', database: 'sy', repo: 'sy' }];
  const after = tools();
  assert.deepEqual(await after.listed(), [{ projectId: before[0].projectId, key: 'example.com', name: 'Example', prefix: 'ex' },
    { projectId: standaloneProjectId('sy'), key: 'os-1f2e', name: 'System', prefix: 'sy' }]);
  assert.notEqual(standaloneProjectId('sy'), before[0].projectId);
  // The kept id still reaches the ex project, in its own folder.
  const read = await after.call('get_task', { project: before[0].projectId, task: 'ex-1' });
  assert.equal(read.isError, undefined, read.content[0].text);
  assert.ok(after.commands.length > 0 && after.commands.every(command => command.cwd === '/spokes/ex'));
});

test('a project is named by its site\'s on-screen name: the System for the installation\'s own row, else the stored name or the site\'s id', async () => {
  const rows = [{ asset: 'os-1f2e', prefix: 'sy', database: 'sy', repo: 'sy' }, { asset: 'example.org', prefix: 'eo', database: 'eo', repo: 'eo' },
    { asset: 'unlisted.example', prefix: 'un', database: 'un', repo: 'un' }];
  const named = async sites => (await endpoint({ read: async () => rows, sites }).listed()).map(project => [project.prefix, project.key, project.name]);
  assert.deepEqual(await named(async () => SITES),
    [['sy', 'os-1f2e', 'System'], ['eo', 'example.org', 'Example Org'], ['un', 'unlisted.example', 'unlisted.example']]);
  // An unreadable site list names each project by its site's id; the call still answers.
  assert.deepEqual(await named(async () => { throw new Error('store unavailable'); }),
    [['sy', 'os-1f2e', 'os-1f2e'], ['eo', 'example.org', 'example.org'], ['un', 'unlisted.example', 'unlisted.example']]);
});

test('a site-derived id names no project, and the directory finds the project now filed under that site', async () => {
  const rows = [{ asset: 'example.com', prefix: 'ex', database: 'ex', repo: 'ex' }];
  const tools = endpoint({ read: async () => rows, sites: async () => SITES });
  assert.deepEqual(await tools.directory.formerly(WORKSPACE, formerStandaloneProjectId('example.com')),
    { projectId: standaloneProjectId('ex'), logicalKey: 'example.com', displayName: 'Example', prefix: 'ex' });
  assert.equal(await tools.directory.formerly(WORKSPACE, formerStandaloneProjectId('example.org')), null, 'no linked project is filed there');
  assert.equal(await tools.directory.formerly(WORKSPACE, standaloneProjectId('ex')), null, 'a current id is not a former one');
  assert.match((await tools.call('get_task', { project: formerStandaloneProjectId('example.com'), task: 'ex-1' })).content[0].text, /^refused:/u);
  assert.deepEqual(tools.commands, []);
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
  const operations = createHostedTaskOperations({ admission: f.admission,
    directory: standaloneTaskDirectory(f.projects, async () => [{ id: 'example', displayName: 'Example', isOs: false }]),
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
    [{ projectId: standaloneProjectId('example'), key: 'example', name: 'Example', prefix: 'ex' }]);
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
