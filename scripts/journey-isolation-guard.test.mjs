// The browser-journey server's isolation guard (apps/tower/e2e/isolation-guard.mjs,
// bead ro-ujb9.81) must refuse the operator's secrets files, the checkout's own
// config/ directory (bead ro-ujb9.89), its installation folder (bead
// ro-ujb9.125) and owner ports BEFORE the filesystem or
// network is touched. The harness test proves a full journey trips it zero
// times; this proves the guard would have tripped.
//
// Run in a child process whose fs and socket primitives are stubs installed
// before the guard, so a broken guard reaches a stub — never the operator's
// real file or live door.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = pathToFileURL(path.join(REPO_ROOT, 'apps', 'tower', 'e2e', 'isolation-guard.mjs')).href;
const OWNER_CONSTANTS = path.join(REPO_ROOT, 'config', 'constants.json');
const OWNER_PULL = path.join(REPO_ROOT, 'config', 'pull.json');
const OWNER_INSTALLED = path.join(REPO_ROOT, 'installation', 'pull.json');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'apps', 'tower', 'e2e', 'fixture-repo', 'installation', 'task-host.json');

const PROBE = `
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const reached = [];
// Node 24 loads ESM through this primitive. Only these public module sources
// retain real reads; every configuration/secret probe still reaches a stub.
const moduleFiles = new Set(${JSON.stringify([fileURLToPath(GUARD), path.join(REPO_ROOT, 'scripts/installation.mjs'), path.join(REPO_ROOT, 'scripts/product-env.mjs')])});
const sourceRead = fs.readFileSync.bind(fs);
fs.readFileSync = (file, ...args) => {
  if (moduleFiles.has(file instanceof URL ? fileURLToPath(file) : String(file))) return sourceRead(file, ...args);
  reached.push('readFileSync ' + file); return '';
};
fs.promises.readFile = async (file) => { reached.push('promises.readFile ' + file); return ''; };
fs.readFile = (file, done) => { reached.push('readFile ' + file); done(null, ''); };
net.Socket.prototype.connect = function () { reached.push('connect'); return this; };
const { installIsolationGuard, VIOLATION_MARK, ARMED_MARK } = await import(${JSON.stringify(GUARD)});
const lines = [];
const guard = installIsolationGuard({ report: (line) => lines.push(line) });
const outcomes = {};
const attempt = async (name, run) => {
  try { await run(); outcomes[name] = 'allowed'; } catch { outcomes[name] = 'refused'; }
};
await attempt('readFileSync .dev.vars', () => fs.readFileSync('/nowhere/workers/ingest/.dev.vars', 'utf8'));
await attempt('fs.promises.readFile .dev.secrets.json', () => fs.promises.readFile('/nowhere/workers/ingest/.dev.secrets.json', 'utf8'));
const { readFile } = await import('node:fs/promises');
await attempt('named readFile .dev.vars', () => readFile(new URL('file:///nowhere/.dev.vars')));
await attempt('callback readFile .dev.vars', () => new Promise((resolve, reject) =>
  fs.readFile('/nowhere/.dev.vars', 'utf8', (error) => (error ? reject(error) : resolve()))));
await attempt('readFileSync .dev.vars.example', () => fs.readFileSync('/nowhere/.dev.vars.example', 'utf8'));
await attempt('readFileSync owner constants.json', () => fs.readFileSync(${JSON.stringify(OWNER_CONSTANTS)}, 'utf8'));
await attempt('named readFile owner pull.json', () => readFile(${JSON.stringify(OWNER_PULL)}, 'utf8'));
await attempt('readFileSync installation pull.json', () => fs.readFileSync(${JSON.stringify(OWNER_INSTALLED)}, 'utf8'));
await attempt('readFileSync fixture task-host.json', () => fs.readFileSync(${JSON.stringify(FIXTURE_CONFIG)}, 'utf8'));
for (const port of [8791, 5173]) {
  await attempt('connect ' + port, () => new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('error', reject);
    setTimeout(resolve, 50);
  }));
}
guard.noteFetch('http://127.0.0.1:8791/api/config-documents?bodies=1');
guard.noteFetch('http://127.0.0.1:4188/api/wall');
process.stdout.write(JSON.stringify({
  reached, outcomes,
  armed: lines.includes(ARMED_MARK),
  violations: lines.filter((line) => line.startsWith(VIOLATION_MARK)).map((line) => JSON.parse(line.slice(VIOLATION_MARK.length + 1))),
}));
`;

test('the journey isolation guard refuses secrets files, owner config and owner ports before touching them', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
    timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.armed, true);
  assert.deepEqual(result.outcomes, {
    'readFileSync .dev.vars': 'refused',
    'fs.promises.readFile .dev.secrets.json': 'refused',
    'named readFile .dev.vars': 'refused',
    'callback readFile .dev.vars': 'refused',
    'readFileSync .dev.vars.example': 'allowed',
    'readFileSync owner constants.json': 'refused',
    'named readFile owner pull.json': 'refused',
    'readFileSync installation pull.json': 'refused',
    'readFileSync fixture task-host.json': 'allowed',
    'connect 8791': 'refused',
    'connect 5173': 'refused',
  });
  // Only the example file and the fixture repo's own host links reached the
  // (stubbed) filesystem; the checkout's config/ and installation folder never
  // did, and no socket opened.
  assert.deepEqual(result.reached, [
    'readFileSync /nowhere/.dev.vars.example',
    `readFileSync ${FIXTURE_CONFIG}`,
  ]);
  assert.deepEqual(result.violations.map((row) => row.kind), [
    'read', 'read', 'read', 'read', 'read', 'read', 'read', 'connect to', 'connect to', 'contact',
  ]);
  assert.deepEqual(result.violations.slice(4, 7).map((row) => row.target), [OWNER_CONSTANTS, OWNER_PULL, OWNER_INSTALLED]);
  assert.deepEqual(result.violations.slice(7).map((row) => row.target), [
    '127.0.0.1:8791', '127.0.0.1:5173', '127.0.0.1:8791',
  ]);
});
