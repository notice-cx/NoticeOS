import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main, parseOptions } from './local-mcp.mjs';
import { chooseProject, main as bdMain } from './local-bd.mjs';
import { actorOf, linkedProjects, openStandaloneMcp, runTaskClient } from './standalone-mcp.mjs';
import { standaloneProjectId } from './standalone-tasks.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';

// scripts/standalone-mcp.mts, local-mcp.mjs and local-bd.mjs: a standalone
// installation's MCP endpoint (the Tower's /api/mcp and pnpm os:mcp) and its
// task client for this machine (pnpm os:bd). The served tools are proved in
// standalone-tasks.test.mjs and hosted-mcp.test.mjs; this is their setup.

const PROJECTS = [{ asset: 'example', prefix: 'ex', database: 'example_tasks', repo: '/spokes/example' },
  { asset: 'second', prefix: 'se', database: 'second_tasks', repo: 'spokes/second' },
  { asset: 'unlinked', prefix: 'un', database: 'unlinked_tasks', repo: '', unavailableReason: 'unlinked has no checkout linked on this host' }];

test('an agent is named with --actor, in the grammar a task records, or is "agent"', () => {
  assert.deepEqual(parseOptions([]), { actor: 'agent' });
  assert.deepEqual(parseOptions(['--actor', 'claude:review-1']), { actor: 'claude:review-1' });
  for (const argv of [['--actor'], ['--actor', '-x'], ['--actor', 'a b'], ['--http'], ['--actor', 'a', 'b']]) {
    assert.throws(() => parseOptions(argv), /Usage: local-mcp\.mjs \[--actor <name>\]/u, argv.join(' '));
  }
});

test('a refused option stops before anything is read, and a missing database is one sentence', async () => {
  let said = '';
  const err = { write: text => { said += text; } };
  assert.equal(await main(['--actor', 'a b'], { err }), 2);
  assert.match(said, /^Usage/u);
  said = '';
  assert.equal(await main([], { err, secretFiles: { secretsFile: '/nonexistent/.dev.secrets.json', varsFile: '/nonexistent/.dev.vars' } }), 1);
  assert.match(said, /^NoticeOS MCP could not reach the installation's database: could not read \/nonexistent\/\.dev\.vars/u);
});

test('only linked projects are served, each in its own folder under a stable id, read again after a few seconds', async () => {
  let reads = 0, time = 0;
  const projects = linkedProjects({ read: async () => { reads++; return PROJECTS; }, root: '/opt/noticeos', now: () => time });
  const first = await projects();
  assert.deepEqual(first.map(project => [project.projectId, project.asset, project.cwd]), [
    [standaloneProjectId('example'), 'example', '/spokes/example'], [standaloneProjectId('second'), 'second', '/opt/noticeos/spokes/second']]);
  time = 4_000; assert.equal(await projects(), first);
  time = 5_000; await projects();
  assert.equal(reads, 2);
});

test('the task client runs in the project\'s folder with the installation\'s declared client, and its exit code is kept', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-task-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bd = path.join(dir, 'bd');
  writeFileSync(bd, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(process.argv.includes('fail') ? 3 : 0);\n`);
  chmodSync(bd, 0o755);
  const result = await runTaskClient(['--sandbox', '--json', 'ready'], dir, { BEADS_BD_BIN: bd, PATH: process.env.PATH });
  assert.deepEqual([result.code, JSON.parse(result.stdout)], [0, { args: ['--sandbox', '--json', 'ready'], cwd: dir }]);
  assert.equal((await runTaskClient(['fail'], dir, { BEADS_BD_BIN: bd, PATH: process.env.PATH })).code, 3);
});

test('a request acts as the agent its header names, or as agent', () => {
  const named = value => new Request('http://localhost/api/mcp', { headers: value === undefined ? {} : { 'x-noticeos-actor': value } });
  assert.equal(actorOf(named(undefined)), 'agent');
  assert.equal(actorOf(named('claude:review-1')), 'claude:review-1');
  for (const value of ['-x', 'a b', 'x'.repeat(129)]) assert.equal(actorOf(named(value)), null, value);
});

test('the endpoint serves the store\'s one workspace as the named agent, and the Tower\'s read models', async () => {
  const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6', commands = [], forwarded = [];
  let closed = false;
  const mcp = await openStandaloneMcp({ store: { onlyWorkspace: async () => WORKSPACE, close: async () => { closed = true; } },
    receipts: memoryReceipts(Date.now), projects: async () => [{ projectId: standaloneProjectId('example'), asset: 'example', prefix: 'ex', cwd: '/spokes/example' }],
    run: async argv => { commands.push(argv); return { code: 0, stdout: argv.includes('lint') ? '{"results":null}' : '{"id":"ex-1"}' }; },
    tower: 'http://127.0.0.1:5173', fetch: async (url, init) => { forwarded.push([url, init.headers.get('x-noticeos-mcp-part')]); return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { properties: [] } } }); } });
  const call = (name, args, headers = {}) => mcp.handle(new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }))
    .then(response => response.json());
  const created = await call('create_task', { workspace: WORKSPACE, project: standaloneProjectId('example'), title: 'Probe', idempotency_key: 'local-create-0001' },
    { 'x-noticeos-actor': 'claude' });
  assert.equal(created.result.structuredContent.id, 'ex-1');
  assert.equal(commands[0][2], '--actor=claude');
  assert.match((await call('list_tasks', { workspace: WORKSPACE, project: standaloneProjectId('example') }, { 'x-noticeos-actor': 'a b' })).result.content[0].text, /^refused:/u);
  assert.deepEqual((await call('list_properties', { workspace: WORKSPACE })).result.structuredContent, { properties: [] });
  assert.deepEqual(forwarded, [['http://127.0.0.1:5173/api/mcp', 'read-models']]);
  await mcp.close();
  assert.equal(closed, true);
  await assert.rejects(openStandaloneMcp({ store: { onlyWorkspace: async () => { throw new Error('no single workspace'); }, close: async () => { closed = 'again'; } } }),
    /no single workspace/u);
  assert.equal(closed, 'again', 'a store that names no workspace is closed');
});

test('an agent\'s claim and close name its model, and its close records the agent as the closer', async () => {
  const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6', commands = [], CLOSED_AT = '2026-10-12T10:00:00Z';
  const row = status => ({ id: 'ex-1', title: 'Probe', status, issue_type: 'task', priority: 2, assignee: 'claude', labels: [],
    ...(status === 'closed' ? { closed_at: CLOSED_AT, close_reason: 'Done · abc1234' } : {}) });
  const mcp = await openStandaloneMcp({ store: { onlyWorkspace: async () => WORKSPACE, close: async () => {} },
    receipts: memoryReceipts(Date.now), projects: async () => [{ projectId: standaloneProjectId('example'), asset: 'example', prefix: 'ex', cwd: '/spokes/example' }],
    run: async argv => {
      commands.push(argv);
      const stdout = argv.includes('lint') ? { results: null } : argv.includes('comments') ? [] : [row(argv.includes('close') ? 'closed' : 'in_progress')];
      return { code: 0, stdout: JSON.stringify(stdout) };
    } });
  const call = (name, args) => mcp.handle(new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-noticeos-actor': 'claude' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { workspace: WORKSPACE, project: standaloneProjectId('example'), ...args } } }) }))
    .then(response => response.json());
  const writes = () => commands.filter(argv => !argv.includes('--readonly'));
  assert.equal((await call('claim_task', { task: 'ex-1', model: 'Example Model 1', idempotency_key: 'local-claim-0001' })).result.isError, undefined);
  assert.deepEqual(writes().at(-1).slice(2), ['--actor=claude', 'update', '--claim', '--metadata={"noticeos_claimed_model":"Example Model 1"}', '--', 'ex-1']);
  assert.equal((await call('close_task', { task: 'ex-1', reason: 'Done · abc1234', model: 'Example Model 1', idempotency_key: 'local-close-0001' })).result.isError, undefined);
  const [close, recorded] = writes().slice(-2);
  assert.ok(close.includes('close') && close.includes('--actor=claude'));
  assert.deepEqual(JSON.parse(recorded.find(arg => arg.startsWith('--metadata=')).slice('--metadata='.length)),
    { noticeos_closed_by: 'claude', noticeos_closed_at: CLOSED_AT, noticeos_closed_model: 'Example Model 1' });
  await mcp.close();
});

test('os:bd runs in the project a task id or --project names, or the only linked one, as the operator', async () => {
  assert.equal(chooseProject([PROJECTS[0], PROJECTS[2]]).asset, 'example');
  assert.equal(chooseProject(PROJECTS, undefined, ['show', 'se-1x2.3']).asset, 'second', 'a task id names its project by its prefix');
  assert.throws(() => chooseProject(PROJECTS, undefined, ['dep', 'add', 'ex-1', 'se-2']), /Name a project with --project/u, 'two projects\' ids');
  assert.throws(() => chooseProject(PROJECTS, undefined, ['show', 'zz-1']), /Name a project with --project/u, 'no linked project has that prefix');
  assert.throws(() => chooseProject(PROJECTS), { message: 'Name a project with --project: ex (example), se (second).' });
  assert.equal(chooseProject(PROJECTS, 'se').asset, 'second');
  assert.equal(chooseProject(PROJECTS, 'example').asset, 'example');
  assert.throws(() => chooseProject(PROJECTS, 'un'), /No linked task project is un/u);
  assert.throws(() => chooseProject([PROJECTS[2]]), /links no task project/u);
  const spawned = [];
  const spawnChild = (...args) => { spawned.push(args); const child = new EventEmitter(); setImmediate(() => child.emit('exit', 3)); return child; };
  const run = argv => bdMain(argv, { env: { PATH: '/usr/bin' }, read: async () => PROJECTS, root: '/opt/noticeos', spawnChild,
    err: { write() {} } });
  assert.equal(await run(['--project=se', 'ready', '--json']), 3, 'its exit code is the command\'s');
  assert.deepEqual(spawned[0].slice(0, 2), ['bd', ['ready', '--json']]);
  assert.equal(spawned[0][2].cwd, '/opt/noticeos/spokes/second');
  assert.equal(spawned[0][2].env.BEADS_ACTOR, 'operator');
  await run(['--project', 'ex', 'list', '--actor', 'sam']);
  assert.deepEqual([spawned[1][1], spawned[1][2].cwd], [['list', '--actor', 'sam'], '/spokes/example']);
  await run(['view', 'se-9', '--project', 'ex']);
  assert.deepEqual([spawned[2][1], spawned[2][2].cwd], [['view', 'se-9'], '/spokes/example'], '--project wherever it stands wins');
  await run(['view', 'se-9']);
  assert.deepEqual([spawned[3][1], spawned[3][2].cwd], [['view', 'se-9'], '/opt/noticeos/spokes/second']);
  assert.equal(await run([]), 2);
  assert.equal(await run(['list']), 1, 'two linked projects and no task id need --project');
  assert.equal(spawned.length, 4);
});
