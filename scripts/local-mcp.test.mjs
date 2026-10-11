import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { linkedProjects, main, parseOptions, runTaskClient } from './local-mcp.mjs';
import { chooseProject, main as bdMain } from './local-bd.mjs';
import { standaloneProjectId } from './standalone-tasks.mjs';

// scripts/local-mcp.mjs and scripts/local-bd.mjs: the MCP server and the task
// client a standalone installation runs inside its app container for this
// machine (pnpm os:mcp, pnpm os:bd). The served tools are proved in
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

test('the task client runs with the installation\'s declared client, bounded in time', async () => {
  const calls = [];
  const result = await runTaskClient(['--sandbox', '--json', 'ready'], '/spokes/example', { env: { BEADS_BD_BIN: '/usr/local/bin/bd', PATH: '/usr/bin' },
    run: async (...args) => { calls.push(args); return { code: 0, stdout: '[]', stderr: 'notice' }; } });
  assert.deepEqual(result, { code: 0, stdout: '[]' });
  assert.deepEqual(calls, [['/usr/local/bin/bd', ['--sandbox', '--json', 'ready'], { cwd: '/spokes/example',
    env: { BEADS_BD_BIN: '/usr/local/bin/bd', PATH: '/usr/bin' }, timeoutMs: 30_000 }]]);
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
