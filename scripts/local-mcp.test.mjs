import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main, parseOptions } from './local-mcp.mjs';
import { chooseProject, main as bdMain } from './local-bd.mjs';
import { actorOf, linkedProjects, openStandaloneMcp, runTaskClient, storeSites } from './standalone-mcp.mjs';
import { standaloneProjectId } from './standalone-tasks.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { postgresRequired, startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';

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

test('only linked projects are served, each in its own folder under its database\'s id, read again after a few seconds', async () => {
  let reads = 0, time = 0;
  const projects = linkedProjects({ read: async () => { reads++; return PROJECTS; }, root: '/opt/noticeos', now: () => time });
  const first = await projects();
  assert.deepEqual(first.map(project => [project.projectId, project.asset, project.cwd]), [
    [standaloneProjectId('example_tasks'), 'example', '/spokes/example'], [standaloneProjectId('second_tasks'), 'second', '/opt/noticeos/spokes/second']]);
  time = 4_000; assert.equal(await projects(), first);
  time = 5_000; await projects();
  assert.equal(reads, 2);
});

test('the site list is read read-only in the store\'s workspace, kept a few seconds, and a failed read is not kept', async () => {
  const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6', reads = [];
  let time = 0, fail = false;
  const rows = [{ id: 'example.com', displayName: 'Example', isOs: false }];
  const sites = storeSites({ inWorkspace: async (workspaceId, work, options) => {
    reads.push([workspaceId, options]);
    if (fail) throw new Error('store unavailable');
    return work({ workspaceId, query: async sql => { assert.match(sql, /FROM noticeos\.assets/u); return rows; } });
  } }, WORKSPACE, () => time);
  assert.deepEqual(await sites(), rows);
  assert.deepEqual(reads, [[WORKSPACE, { readOnly: true }]]);
  time = 4_000; await sites(); assert.equal(reads.length, 1);
  time = 5_000; fail = true;
  await assert.rejects(sites(), /store unavailable/u);
  fail = false; assert.deepEqual(await sites(), rows);
  assert.equal(reads.length, 3);
});

test('the task client runs in the project\'s folder with the installation\'s declared client, and its exit code is kept', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-task-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bd = path.join(dir, 'bd');
  writeFileSync(bd, `#!${process.execPath}\nif (process.argv.includes('hang')) setInterval(() => {}, 1000);\nelse {\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(process.argv.includes('fail') ? 3 : 0);\n}\n`);
  chmodSync(bd, 0o755);
  const result = await runTaskClient(['--sandbox', '--json', 'ready'], dir, { BEADS_BD_BIN: bd, PATH: process.env.PATH });
  assert.deepEqual([result.code, JSON.parse(result.stdout), result.timedOut], [0, { args: ['--sandbox', '--json', 'ready'], cwd: dir }, false]);
  const failed = await runTaskClient(['fail'], dir, { BEADS_BD_BIN: bd, PATH: process.env.PATH });
  assert.deepEqual([failed.code, failed.timedOut], [3, false]);
  // A client that outlives its time is killed, and the refusal can say so.
  const hung = await runTaskClient(['hang'], dir, { BEADS_BD_BIN: bd, PATH: process.env.PATH }, 300);
  assert.deepEqual([hung.code, hung.timedOut], [1, true]);
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
  const mcp = await openStandaloneMcp({ store: { onlyWorkspace: async () => WORKSPACE, close: async () => { closed = true; },
    inWorkspace: async (workspaceId, work) => work({ workspaceId, query: async () => [{ id: 'example', displayName: 'Example', isOs: false }] }) },
    receipts: memoryReceipts(Date.now), projects: async () => [{ projectId: standaloneProjectId('example'), asset: 'example', prefix: 'ex', cwd: '/spokes/example' }],
    run: async argv => { commands.push(argv); return { code: 0, stdout: argv.includes('lint') ? '{"results":null}' : '{"id":"ex-1"}' }; },
    tower: 'http://127.0.0.1:5173', fetch: async (url, init) => { forwarded.push([url, init.headers.get('x-noticeos-mcp-part')]); return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { properties: [] } } }); } });
  const call = (name, args, headers = {}) => mcp.handle(new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }))
    .then(response => response.json());
  assert.deepEqual((await call('list_projects', { workspace: WORKSPACE })).result.structuredContent.projects,
    [{ projectId: standaloneProjectId('example'), key: 'example', name: 'Example', prefix: 'ex' }], 'a project is named from the store\'s site list');
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

test('on the store, each project is named from the site list: the System for the installation\'s own row, else its stored name', async (t) => {
  let cluster;
  try { cluster = await startTestCluster(); } catch (error) {
    const reason = unavailableReason(error);
    if (reason === null || postgresRequired()) throw error;
    return t.skip(`no Postgres here: ${reason}`);
  }
  t.after(() => cluster.close());
  const url = cluster.url(await cluster.createDatabase());
  const seed = openStore(url, { maxConnections: 1 });
  try {
    await seed.inWorkspace(cluster.workspaceId, tx => tx.execute(`INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, is_os)
      VALUES ($1, 'os-test', NULL, 'Stored name of the OS row', 'live', true), ($1, 'example.com', 'example.com', 'Example', 'live', false)`,
    [cluster.workspaceId]));
  } finally { await seed.close(); }
  const linked = [['os-test', 'sy'], ['example.com', 'ex'], ['unlisted.example', 'un']]
    .map(([asset, prefix]) => ({ projectId: standaloneProjectId(prefix), asset, prefix, cwd: `/spokes/${prefix}` }));
  const mcp = await openStandaloneMcp({ databaseUrl: url, projects: async () => linked, run: async () => ({ code: 1, stdout: '' }) });
  t.after(() => mcp.close());
  const listed = await mcp.handle(new Request('http://localhost/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: { workspace: cluster.workspaceId } } }) }))
    .then(response => response.json());
  assert.deepEqual(listed.result.structuredContent.projects.map(project => [project.prefix, project.key, project.name]),
    [['sy', 'os-test', 'System'], ['ex', 'example.com', 'Example'], ['un', 'unlisted.example', 'unlisted.example']]);
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
    { noticeos_closed_by: 'claude', noticeos_closed_at: CLOSED_AT, noticeos_closed_model: 'Example Model 1', noticeos_resolution: 'done' });
  await mcp.close();
});

test('a close as a duplicate checks and links the other task first, then records the resolution with the closer', async () => {
  const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6', commands = [], CLOSED_AT = '2026-10-12T10:00:00Z';
  // What the attribution writes, read back on the closed task.
  let metadata = {};
  const row = (id, status) => ({ id, title: 'Probe', status, issue_type: 'task', priority: 2, assignee: '', labels: [], metadata,
    ...(status === 'closed' ? { closed_at: CLOSED_AT, close_reason: 'Same as ex-2' } : {}) });
  const mcp = await openStandaloneMcp({ store: { onlyWorkspace: async () => WORKSPACE, close: async () => {} },
    receipts: memoryReceipts(Date.now), projects: async () => [{ projectId: standaloneProjectId('example'), asset: 'example', prefix: 'ex', cwd: '/spokes/example' },
      { projectId: standaloneProjectId('other'), asset: 'other', prefix: 'ot', cwd: '/spokes/other' }],
    run: async argv => {
      commands.push(argv);
      const written = argv.find(arg => arg.startsWith('--metadata='));
      if (written) metadata = { ...metadata, ...JSON.parse(written.slice('--metadata='.length)) };
      // ex-3 is the one id this project does not hold.
      const listed = argv.find(arg => arg.startsWith('--id='));
      const stdout = listed ? listed.slice('--id='.length).split(',').filter(id => id !== 'ex-3').map(id => row(id, 'open'))
        : argv.includes('lint') ? { results: null } : argv.includes('comments') || argv.includes('ready') ? []
        : argv.includes('dep') ? { status: 'added' } : [row('ex-1', argv.includes('close') || argv.includes('show') && commands.some(c => c.includes('close')) ? 'closed' : 'open')];
      return { code: 0, stdout: JSON.stringify(stdout) };
    } });
  const call = (name, args) => mcp.handle(new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-noticeos-actor': 'claude' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { workspace: WORKSPACE, project: standaloneProjectId('example'), ...args } } }) }))
    .then(response => response.json());
  const writes = () => commands.filter(argv => !argv.includes('--readonly'));
  const closing = { task: 'ex-1', reason: 'Same as ex-2', resolution: 'duplicate', duplicate_of: 'ex-2', idempotency_key: 'local-dup-0001' };
  // Each refusal names the field or the task at fault, and nothing is written.
  for (const [args, cause] of [
    [{ ...closing, resolution: 'fixed' }, /resolution \(one of done, wont-do, duplicate, cant-reproduce, already-handled\)/u],
    [{ ...closing, resolution: undefined }, /duplicate_of \(only with resolution duplicate\)/u],
    [{ ...closing, duplicate_of: undefined }, /duplicate_of \(required with resolution duplicate/u],
    [{ ...closing, duplicate_of: 'ex-1' }, /duplicate_of \(another task/u],
    [{ ...closing, duplicate_of: 'ex-3', idempotency_key: 'local-dup-0002' }, /ex-3 is not a task in projectId/u],
    [{ ...closing, duplicate_of: 'ot-1', idempotency_key: 'local-dup-0003' }, /ot-1 is not in projectId .*tasks with prefix ot are in projectId/u],
  ]) {
    const answer = (await call('close_task', args)).result;
    assert.equal(answer.isError, true, String(cause));
    assert.match(answer.content[0].text, cause);
  }
  assert.deepEqual(writes(), []);
  const closed = (await call('close_task', closing)).result;
  assert.equal(closed.isError, undefined);
  assert.equal(closed.structuredContent.task.closeReason, 'Same as ex-2', 'the reason is the caller\'s own text');
  assert.equal(closed.structuredContent.task.resolution, 'duplicate');
  assert.equal(closed.structuredContent.task.duplicateOf, 'ex-2');
  const [linked, close, recorded] = writes();
  assert.deepEqual(linked.slice(2), ['--actor=claude', 'dep', 'add', '--type=related', '--', 'ex-1', 'ex-2']);
  assert.deepEqual(close.slice(2), ['--actor=claude', 'close', '--reason=Same as ex-2', '--', 'ex-1']);
  assert.deepEqual(JSON.parse(recorded.find(arg => arg.startsWith('--metadata=')).slice('--metadata='.length)),
    { noticeos_closed_by: 'claude', noticeos_closed_at: CLOSED_AT, noticeos_resolution: 'duplicate', noticeos_duplicate_of: 'ex-2' });
  await mcp.close();
});

test('an agent\'s new tasks record the agent as their filer and the model it names, one at a time or several', async () => {
  const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6', commands = [];
  let filed = 0;
  const mcp = await openStandaloneMcp({ store: { onlyWorkspace: async () => WORKSPACE, close: async () => {} },
    receipts: memoryReceipts(Date.now), projects: async () => [{ projectId: standaloneProjectId('example'), asset: 'example', prefix: 'ex', cwd: '/spokes/example' }],
    run: async argv => {
      commands.push(argv);
      return { code: 0, stdout: JSON.stringify(argv.includes('lint') ? { results: null } : { id: `ex-${++filed}` }) };
    } });
  const call = (name, args) => mcp.handle(new Request('http://localhost/api/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-noticeos-actor': 'claude' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { workspace: WORKSPACE, project: standaloneProjectId('example'), ...args } } }) }))
    .then(response => response.json());
  assert.equal((await call('create_task', { title: 'Found work', model: 'Example Model 1', idempotency_key: 'local-file-0001' })).result.isError, undefined);
  assert.equal((await call('create_tasks', { tasks: [{ title: 'First' }, { title: 'Second' }], model: 'Example Model 1',
    idempotency_key: 'local-file-0002' })).result.isError, undefined);
  assert.equal((await call('create_task', { title: 'No model named', idempotency_key: 'local-file-0003' })).result.isError, undefined);
  const metadata = commands.filter(argv => argv.includes('create'))
    .map(argv => JSON.parse(argv.find(arg => arg.startsWith('--metadata=')).slice('--metadata='.length)));
  assert.deepEqual(metadata.map(row => [row.noticeos_filed_by, row.noticeos_filed_model]), [
    ['claude', 'Example Model 1'], ['claude', 'Example Model 1'], ['claude', 'Example Model 1'], ['claude', undefined]]);
  assert.match((await call('create_task', { title: 'Padded', model: ' Example', idempotency_key: 'local-file-0004' })).result.content[0].text,
    /^invalid arguments: model/u);
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
