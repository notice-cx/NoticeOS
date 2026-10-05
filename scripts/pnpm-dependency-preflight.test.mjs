// ro-ujb9.253: exercise pinned pnpm against an owned, local-only workspace.
// No real OS action, checkout dependency install, or installation is accessed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCommand } from './run-command.mjs';
import { towerDependenciesReady } from './runner/tower-launch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fingerprint(directory) {
  const entries = [];
  function visit(file) {
    const stat = fs.lstatSync(file);
    const relative = path.relative(directory, file);
    if (stat.isSymbolicLink()) entries.push([relative, 'link', fs.readlinkSync(file)]);
    else if (stat.isDirectory()) {
      entries.push([relative, 'directory', stat.mode & 0o777]);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    } else {
      entries.push([relative, 'file', stat.mode & 0o777, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  }
  visit(directory);
  return entries;
}

test('pinned pnpm refuses stale dependencies without installing or running an action; explicit frozen setup restores execution', { timeout: 60_000 }, async t => {
  // pnpm exposes its actual executable to package scripts. A direct node test
  // must supply one explicitly; never invoke a tool-manager shim that might
  // install itself in an empty HOME.
  const executable = process.env.NOTICEOS_TEST_PNPM_EXECUTABLE ?? process.env.npm_execpath;
  assert.ok(executable && path.isAbsolute(executable), 'Run through pnpm test:scripts or set NOTICEOS_TEST_PNPM_EXECUTABLE to the pinned executable.');
  const packageManager = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager;
  assert.match(packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
  const pinnedVersion = packageManager.slice('pnpm@'.length);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-dependency-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'workspace');
  const library = path.join(project, 'packages', 'fixture-library');
  for (const folder of [library, path.join(directory, 'home'), path.join(directory, 'config'), path.join(directory, 'cache'), path.join(directory, 'tmp')]) fs.mkdirSync(folder, { recursive: true });
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${path.dirname(executable)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: path.join(directory, 'home'), XDG_CONFIG_HOME: path.join(directory, 'config'),
    XDG_CACHE_HOME: path.join(directory, 'cache'), TMPDIR: path.join(directory, 'tmp'),
    // The executable's exact version is checked below. Keep this fixture
    // offline by disabling only package-manager acquisition, not dep checks.
    CI: '1', NO_COLOR: '1', PNPM_CONFIG_PM_ON_FAIL: 'ignore',
  };
  const invoke = args => runCommand(executable, args, { cwd: project, env, timeoutMs: 25_000 });
  const version = await invoke(['--version']);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), pinnedVersion);
  // Copy only tracked package-manager configuration, never hooks or runtime
  // files. Its real setting must govern the fixture, without a CLI override.
  const workspace = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspace, /^verifyDepsBeforeRun: error$/mu);
  fs.writeFileSync(path.join(project, 'pnpm-workspace.yaml'), workspace);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    name: 'maintenance-fixture', private: true, packageManager,
    dependencies: { 'fixture-library': 'workspace:*' },
    scripts: {
      preinstall: 'node markers.mjs install', postinstall: 'node markers.mjs install',
      'maintenance-fixture': 'node markers.mjs action',
    },
  }));
  fs.writeFileSync(path.join(project, 'markers.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync(`${process.argv[2]}.marker`, 'ran\\n');\n");
  const libraryFile = path.join(library, 'package.json');
  fs.writeFileSync(libraryFile, JSON.stringify({ name: 'fixture-library', version: '1.0.0' }));
  const initial = await invoke(['install', '--offline', '--store-dir', path.join(directory, 'store')]);
  assert.equal(initial.code, 0, `${initial.stdout}\n${initial.stderr}`);
  assert.ok(fs.existsSync(path.join(project, 'install.marker')), 'the fixture detects real lifecycle execution');
  fs.rmSync(path.join(project, 'install.marker'));
  fs.writeFileSync(path.join(project, 'node_modules', 'preserved.marker'), 'existing dependency state');
  // A linked workspace package changing version makes the installed workspace
  // state stale while its workspace:* lockfile remains valid for frozen setup.
  fs.writeFileSync(libraryFile, JSON.stringify({ name: 'fixture-library', version: '2.0.0' }));
  const before = fingerprint(project);
  const runnerPreflight = () => towerDependenciesReady({ root: project, env, run: (_command, args, options) => runCommand(executable, args, options) });
  assert.equal(await runnerPreflight(), false, 'direct runtime launch retains the real pnpm stale-dependency interlock');
  assert.deepEqual(fingerprint(project), before);
  for (const args of [['run', 'maintenance-fixture'], ['exec', 'node', 'markers.mjs', 'action']]) {
    const refused = await invoke(args);
    assert.notEqual(refused.code, 0);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /ERR_PNPM_VERIFY_DEPS_BEFORE_RUN/u);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /pnpm install/u);
    assert.equal(fs.existsSync(path.join(project, 'install.marker')), false);
    assert.equal(fs.existsSync(path.join(project, 'action.marker')), false);
    assert.deepEqual(fingerprint(project), before, 'refusal preserves all dependency, lockfile and fixture bytes');
  }
  const setup = await invoke(['install', '--offline', '--frozen-lockfile', '--store-dir', path.join(directory, 'store')]);
  assert.equal(setup.code, 0, `${setup.stdout}\n${setup.stderr}`);
  assert.equal(await runnerPreflight(), true, 'prepared dependencies permit direct runtime launch');
  assert.ok(fs.existsSync(path.join(project, 'install.marker')), 'only explicit setup runs lifecycle scripts');
  const ready = await invoke(['run', 'maintenance-fixture']);
  assert.equal(ready.code, 0, `${ready.stdout}\n${ready.stderr}`);
  assert.equal(fs.readFileSync(path.join(project, 'action.marker'), 'utf8'), 'ran\n');
  assert.equal(fs.readFileSync(path.join(project, 'node_modules', 'preserved.marker'), 'utf8'), 'existing dependency state');
});
