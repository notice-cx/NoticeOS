import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, prepareDatabase, prepareTaskProject, writeInstallationDocuments } from './os-setup-container.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'postgresql://noticeos_owner:PRIVATE-OWNER-SENTINEL@postgres:5432/noticeos?sslmode=disable';
const PASSWORD = 'c'.repeat(64);

function temp(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-setup-container-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sink = () => { const io = { text: '', write: (chunk) => { io.text += chunk; } }; return io; };

test('the owner address arrives on stdin, each step runs in order, and only the new asset is printed', async () => {
  const order = [];
  const out = sink();
  const code = await main({ input: Readable.from([`${OWNER}\n`]), out, err: sink(), env: {},
    database: (url) => { order.push('database'); assert.equal(url, OWNER); },
    tasks: async () => { order.push('tasks'); },
    asset: async (address) => { order.push('asset'); assert.equal(address, 'postgresql://app'); return 'os-0123456789abcdef'; },
    documents: (asset) => { order.push(`documents ${asset}`); },
    bindings: () => ({ DATABASE_URL: 'postgresql://app' }) });
  assert.equal(code, 0);
  assert.deepEqual(order, ['database', 'tasks', 'asset', 'documents os-0123456789abcdef']);
  assert.equal(out.text, '{"asset":"os-0123456789abcdef"}\n');
});

test('a refusal says its own sentence; any other failure never repeats what it carried', async () => {
  const run = async (database) => {
    const err = sink();
    const code = await main({ input: Readable.from([OWNER]), out: sink(), err, env: {}, database, tasks: async () => {}, bindings: () => ({}) });
    return { code, text: err.text };
  };
  const notEmpty = await run((url) => prepareDatabase(url, { root: ROOT, empty: () => false }));
  assert.deepEqual(notEmpty, { code: 1, text: 'setup refused: the database is not empty; setup applies nothing to an existing database.\n' });
  const leaked = await run(() => { throw new Error(`connection to ${OWNER} failed`); });
  assert.equal(leaked.code, 1);
  assert.doesNotMatch(leaked.text, /PRIVATE-OWNER-SENTINEL/u);
});

test('the task project is a new checkout bound to the stack\'s task server; the password reaches only its children\'s environment', async (t) => {
  const base = temp(t);
  const state = path.join(base, 'state');
  mkdirSync(path.join(state, 'dolt'), { recursive: true });
  writeFileSync(path.join(state, 'dolt', 'credentials'), `[dolt:3306]\npassword=${PASSWORD}\n`);
  const project = { prefix: 'no', database: 'noticeos_tasks', repo: path.join(base, 'spokes', 'noticeos') };
  mkdirSync(path.dirname(project.repo));
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (command === 'bd') {
      mkdirSync(path.join(project.repo, '.beads'));
      writeFileSync(path.join(project.repo, '.beads', 'config.yaml'), 'prefix: no\nsync.remote: origin\n');
    }
    return { code: 0, stdout: '' };
  };
  await prepareTaskProject({ run, env: { BEADS_BD_BIN: 'bd' }, project, state });
  assert.deepEqual(calls.map(({ command, args }) => `${command} ${args[0]}`), ['git init', 'git config', 'git config', 'dolt --host=dolt', 'bd init']);
  assert.ok(calls.find(({ command }) => command === 'dolt').args.includes('CREATE DATABASE `noticeos_tasks`'));
  const init = calls.find(({ command }) => command === 'bd');
  assert.deepEqual(init.args.slice(0, 9), ['init', '--server', '--external', '--server-host', 'dolt', '--server-port', '3306', '--server-user', 'noticeos']);
  assert.equal(init.env.BEADS_DOLT_PASSWORD, PASSWORD);
  assert.equal(calls.find(({ command }) => command === 'dolt').env.DOLT_CLI_PASSWORD, PASSWORD);
  assert.ok(calls.every(({ args }) => !args.join(' ').includes(PASSWORD)));
  assert.ok(calls.filter(({ command }) => command === 'git').every(({ env }) => env.BEADS_DOLT_PASSWORD === undefined && env.DOLT_CLI_PASSWORD === undefined));
  assert.equal(readFileSync(path.join(project.repo, '.beads', 'config.yaml'), 'utf8'), 'prefix: no\nno-git-ops: true\nimport.auto: false\nexport.auto: false\n');
  await assert.rejects(prepareTaskProject({ run, env: {}, project, state }), /already exists/u);
});

test('the installation\'s settings name the new asset and its task project, privately', (t) => {
  const base = temp(t);
  mkdirSync(path.join(base, 'config'));
  mkdirSync(path.join(base, 'installation'));
  writeFileSync(path.join(base, 'config', 'integrations.json'), JSON.stringify({ version: 1, assets: {} }));
  writeFileSync(path.join(base, 'config', 'signal-panels.json'), JSON.stringify({ version: 1, assets: {} }));
  writeInstallationDocuments('os-0123456789abcdef', { root: base, installation: path.join(base, 'installation') });
  const read = (name) => JSON.parse(readFileSync(path.join(base, 'installation', name), 'utf8'));
  assert.deepEqual(read('integrations.json'), { version: 1, assets: { 'os-0123456789abcdef': {} } });
  assert.equal(read('signal-panels.json').assets['os-0123456789abcdef'].enabled, false);
  assert.deepEqual(read('beads.json'), { version: 1, hub: { host: 'dolt', port: 3306, user: 'noticeos', dataDir: '/state/dolt' },
    spokes: [{ asset: 'os-0123456789abcdef', prefix: 'no', database: 'noticeos_tasks' }] });
  assert.deepEqual(read('task-host.json').repositories, [{ asset: 'os-0123456789abcdef', prefix: 'no', database: 'noticeos_tasks', repo: '/spokes/noticeos' }]);
  assert.equal(statSync(path.join(base, 'installation', 'beads.json')).mode & 0o777, 0o600);
  assert.throws(() => writeInstallationDocuments('os-0123456789abcdef', { root: base, installation: path.join(base, 'installation') }), /EEXIST/u);
});
