import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTaskProjects } from './task-project-config.mjs';
import { assertTaskFixtureOutsideGit } from './test-fixtures/hosted-task-projects.mjs';

/** A declared Dolt home, as the synthetic viewer's NOTICEOS_DOLT_HOME names one. */
async function doltHome(root) {
  const home = path.join(root, 'viewer-home'), dolt = path.join(home, 'dolt');
  await fs.mkdir(path.join(dolt, 'secrets'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(dolt, 'client-home'), { mode: 0o700 });
  const profile = { project: 'noticeos-start-0123456789abcdef', composeFile: path.join(dolt, 'compose.yaml'),
    secretsDir: path.join(dolt, 'secrets'), credentialsFile: path.join(dolt, 'credentials'), port: 5773 };
  await fs.writeFile(path.join(dolt, 'profile.json'), JSON.stringify(profile), { mode: 0o600 });
  for (const name of ['root', 'noticeos']) await fs.writeFile(path.join(profile.secretsDir, name), 'a'.repeat(64) + '\n', { mode: 0o600 });
  await fs.writeFile(profile.credentialsFile, '[127.0.0.1:5773]\npassword=' + 'a'.repeat(64) + '\n', { mode: 0o600 });
  return home;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-no-checkout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let saved = { spokes: [{ asset: 'example.com', prefix: 'ex', database: 'example_tasks' }] };
  let host = { repositories: structuredClone(saved.spokes) };
  const env = { NOTICEOS_DOLT_HOME: await doltHome(root) };
  const options = { repoRoot: root, env, token: 'fixture', readHost: async () => JSON.stringify(host),
    fetchImpl: async () => Response.json({ ready: true, documents: [{ file: 'config/beads.json', version: 1, body: saved }] }) };
  return { root, env, options, read: () => readTaskProjects(options),
    set: (next, links) => { saved = { spokes: next }; host = { repositories: links }; } };
}

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
  const [project] = await readTaskProjects({ ...f.options, readHost: undefined, env: { ...f.env, NOTICEOS_INSTALLATION_DIR: selected } });
  assert.ok(project.cwd.startsWith(path.join(selected, 'task-projects') + path.sep));
  assert.equal(await fs.stat(path.join(f.root, 'installation')).catch(() => null), null);
});

test('without a declared task client the saved projects are read and no task folder is made', async t => {
  const f = await fixture(t);
  const projects = await readTaskProjects({ ...f.options, env: {} });
  assert.deepEqual(projects.map(({ asset, prefix, cwd, unavailableReason }) => ({ asset, prefix, cwd, unavailableReason })),
    [{ asset: 'example.com', prefix: 'ex', cwd: undefined, unavailableReason: undefined }]);
  assert.equal(await fs.stat(path.join(f.root, 'installation')).catch(() => null), null);
});
