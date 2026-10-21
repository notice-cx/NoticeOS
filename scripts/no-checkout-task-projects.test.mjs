import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTaskProjects, readTaskProjectConfig } from './task-project-config.mjs';
import { linkedProjects, openStandaloneMcp } from './standalone-mcp.mjs';
import { standaloneProjectId } from './standalone-tasks.mjs';
import { memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';
import { collectBeadsSnapshot } from './runner/task-snapshot.mjs';
import { assertTaskFixtureOutsideGit } from './test-fixtures/hosted-task-projects.mjs';
import { parseBeadsProjects } from './runner/task-hub.mjs';

const WORKSPACE = '5f42e967-bb21-4e9b-9c69-8b082e8491a6';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-no-checkout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let saved = { spokes: [{ asset: 'example.com', prefix: 'ex', database: 'example_tasks' }] };
  let host = { repositories: structuredClone(saved.spokes) };
  const options = { repoRoot: root, env: {}, token: 'fixture', readHost: async () => JSON.stringify(host),
    fetchImpl: async () => Response.json({ ready: true, documents: [{ file: 'config/beads.json', version: 1, body: saved }] }) };
  return { root, options, read: () => readTaskProjects(options),
    set: (next, links) => { saved = { spokes: next }; host = { repositories: links }; } };
}

test('no-checkout MCP creates, claims and closes against the same connection as the snapshot', async t => {
  const f = await fixture(t), calls = [], tasks = new Map();
  const repo = path.join(f.root, 'unrelated-checkout');
  await fs.mkdir(repo);
  const projects = linkedProjects({ read: f.read });
  const [connection] = await f.read();
  assert.equal(connection.repo, '');
  assert.ok(connection.cwd.startsWith(path.join(f.root, 'installation/task-projects/')));
  const client = async (argv, cwd) => {
    calls.push({ argv, cwd });
    const metadata = JSON.parse(await fs.readFile(path.join(cwd, '.beads/metadata.json'), 'utf8'));
    assert.equal(metadata.dolt_database, 'example_tasks');
    assert.equal(metadata.dolt_mode, 'server');
    assert.match(await fs.readFile(path.join(cwd, '.beads/config.yaml'), 'utf8'), /issue-prefix: ex\nno-git-ops: true/);
    assert.equal(await fs.stat(path.join(cwd, '.git')).catch(() => null), null);
    const words = argv.filter(word => !word.startsWith('--'));
    const kind = words[0], flag = name => argv.find(word => word.startsWith(name + '='))?.slice(name.length + 1);
    let value = [];
    if (kind === 'create') {
      const task = { id: 'ex-1', title: flag('--title'), status: 'open', issue_type: 'task',
        metadata: JSON.parse(flag('--metadata') ?? '{}'), created_at: new Date().toISOString() };
      tasks.set(task.id, task); value = task;
    } else if (kind === 'show') value = [tasks.get(argv.at(-1))];
    else if (kind === 'update') {
      const task = tasks.get(argv.at(-1));
      if (argv.includes('--claim')) Object.assign(task, { status: 'in_progress', assignee: 'fixture-agent' });
      value = task;
    } else if (kind === 'close') {
      const task = tasks.get(argv.at(-1));
      Object.assign(task, { status: 'closed', closed_at: new Date().toISOString(), close_reason: flag('--reason') }); value = task;
    } else if (kind === 'list' || kind === 'ready') value = [...tasks.values()];
    return { code: 0, stdout: JSON.stringify(value) };
  };
  const store = { onlyWorkspace: async () => WORKSPACE, close: async () => {},
    inWorkspace: async (_id, work) => work({ query: async sql => sql.includes('pg_try_advisory') ? [{ acquired: true }] : [] }) };
  const mcp = await openStandaloneMcp({ store, projects, run: client, receipts: memoryReceipts(Date.now) });
  t.after(() => mcp.close());
  const call = async (name, args = {}) => {
    const body = await (await mcp.handle(new Request('http://localhost/api/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noticeos-actor': 'fixture-agent' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name,
        arguments: { workspace: WORKSPACE, ...(name === 'list_projects' ? {} : { project: standaloneProjectId('example_tasks') }), ...args } } }) }))).json();
    assert.equal(body.result.isError, undefined, JSON.stringify(body));
    return body.result.structuredContent;
  };
  const catalog = await call('list_projects');
  assert.equal(catalog.projects[0].projectId, standaloneProjectId('example_tasks'));
  const create = { title: 'Synthetic task', idempotency_key: 'fixture-create-1' };
  await call('create_task', create); await call('create_task', create);
  await call('claim_task', { task: 'ex-1', idempotency_key: 'fixture-claim-1' });
  assert.equal(tasks.get('ex-1').assignee, 'fixture-agent');
  await call('close_task', { task: 'ex-1', reason: 'Fixture verified', idempotency_key: 'fixture-close-1' });
  assert.equal(tasks.get('ex-1').status, 'closed');
  assert.equal(calls.filter(call => call.argv.includes('create')).length, 1);
  const snapshot = await collectBeadsSnapshot({ projects: parseBeadsProjects(await readTaskProjectConfig(f.options)),
    run: async argv => { assert.equal(argv[1], connection.cwd); return { code: 0, stdout: '[]' }; } });
  assert.equal(snapshot.projects[0].ok, true);
  assert.ok(calls.every(call => call.cwd === connection.cwd));
  assert.deepEqual(await fs.readdir(repo), []);
});

test('concurrent preparations share immutable bindings, rebind safely and clean their stages', async t => {
  const f = await fixture(t);
  const all = await Promise.all(Array.from({ length: 8 }, f.read));
  const directory = all[0][0].cwd;
  assert.ok(all.every(rows => rows[0].cwd === directory));
  const moved = { asset: 'other.example', prefix: 'ex', database: 'example_tasks' };
  f.set([moved], [moved]);
  assert.equal((await f.read())[0].cwd, directory);
  const rebound = { ...moved, database: 'different_tasks' };
  f.set([rebound], [moved]);
  assert.match((await f.read())[0].unavailableReason, /no matching task connection/);
  f.set([rebound], [rebound]);
  assert.notEqual((await f.read())[0].cwd, directory);
  const root = path.dirname(directory);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.prepare-')), false);
  await fs.writeFile(path.join(directory, '.beads/metadata.json'), '{}');
  const second = { asset: 'second.example', prefix: 'sy', database: 'second_tasks' };
  f.set([moved, second], [moved, second]);
  const failed = await f.read();
  assert.match(failed[0].unavailableReason, /task client configuration is unavailable/);
  assert.equal(failed[0].cwd, undefined);
  assert.ok(failed[1].cwd);
  assert.equal(failed[1].unavailableReason, undefined);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.prepare-')), false);
});

test('task fixture initialization cannot discover a parent project checkout', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-fixture-git-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, 'scratch/fixture');
  await fs.mkdir(nested, { recursive: true });
  assertTaskFixtureOutsideGit(nested);
  await fs.mkdir(path.join(root, '.git'));
  assert.throws(() => assertTaskFixtureOutsideGit(nested), /Task fixtures must be outside Git checkouts/);
  assert.deepEqual(await fs.readdir(nested), []);
});

test('explicit installation selection reads the same host inventory and writes only its client folder', async t => {
  const f = await fixture(t), selected = path.join(f.root, 'selected-installation');
  await fs.mkdir(selected);
  await fs.writeFile(path.join(selected, 'task-host.json'), JSON.stringify({ repositories: [{ asset: 'example.com', prefix: 'ex', database: 'example_tasks' }] }));
  const [project] = await readTaskProjects({ ...f.options, readHost: undefined, env: { NOTICEOS_INSTALLATION_DIR: selected } });
  assert.ok(project.cwd.startsWith(path.join(selected, 'task-projects') + path.sep));
  assert.equal(await fs.stat(path.join(f.root, 'installation')).catch(() => null), null);
});
