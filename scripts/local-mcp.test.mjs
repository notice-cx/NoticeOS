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

test('os:bd runs in the one linked project, or the one --project names, as the operator', async () => {
  assert.equal(chooseProject([PROJECTS[0], PROJECTS[2]]).asset, 'example');
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
  assert.equal(await run([]), 2);
  assert.equal(await run(['list']), 1, 'two linked projects need --project');
  assert.equal(spawned.length, 2);
});
