import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './test-config-isolation.mjs';

// `pnpm --filter @noticeos/tower run test:journeys -- -g <title>` hands the
// script a literal `--` before the options, and Playwright ignores every
// argument after a `--`: without apps/tower/e2e/run-journeys.mjs dropping it,
// the filter reaches nothing and every journey runs. These start the runner
// with the arguments pnpm gives it, plus `--list`, so no browser or server
// starts. A runner that lost `--list` with the `--` would start the suite, so
// each listing is interrupted after a minute. The title is the README's example.

const TOWER = path.join(REPO_ROOT, 'apps', 'tower');
const TITLE = 'exact task and approval';

/** Each listed journey as `[project] title`, from `--list` after pnpm's `--`. */
function listed(...options) {
  const result = spawnSync(process.execPath, ['e2e/run-journeys.mjs', '--', '--list', ...options],
    { cwd: TOWER, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGINT' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return [...result.stdout.matchAll(/^\s+\[(\w+)\] › \S+ › (.+)$/gmu)].map(([, project, title]) => `[${project}] ${title}`);
}

test("the Tower's test:journeys runs the journeys through run-journeys.mjs", () => {
  const tower = JSON.parse(readFileSync(path.join(TOWER, 'package.json'), 'utf8'));
  assert.equal(tower.scripts['test:journeys'], 'node e2e/run-journeys.mjs');
});

test('-- -g <title> runs only the journeys whose title matches, on both viewports', () => {
  const matching = listed('-g', TITLE);
  assert.deepEqual(matching.map((line) => line.split(' ')[0]), ['[desktop]', '[mobile]'], matching.join('\n'));
  for (const line of matching) assert.ok(line.endsWith(TITLE), line);
  assert.ok(listed().length > matching.length, 'with no filter, more journeys run');
});

test('-- --project desktop runs only the desktop viewport', () => {
  assert.deepEqual(listed('--project', 'desktop', '-g', TITLE).map((line) => line.split(' ')[0]), ['[desktop]']);
  const desktop = listed('--project', 'desktop');
  assert.ok(desktop.length > 0 && desktop.every((line) => line.startsWith('[desktop] ')), desktop.join('\n'));
});

test('every journey spec is discovered and included in the CI typecheck', () => {
  const e2e = path.join(TOWER, 'e2e');
  const specs = [...globSync('**/*.spec.ts', { cwd: e2e })];
  const result = spawnSync(process.execPath, ['e2e/run-journeys.mjs', '--list', '--project', 'desktop', '--project', 'mobile'],
    { cwd: TOWER, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGINT' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const discovered = new Set([...result.stdout.matchAll(/\] › (.+?):\d+:\d+ ›/gu)].map(([, file]) => file));
  const ts = createRequire(path.join(TOWER, 'package.json'))('typescript');
  const config = ts.getParsedCommandLineOfConfigFile(path.join(e2e, 'tsconfig.json'), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  });
  assert.ok(config);
  assert.deepEqual(config.errors, []);
  const checked = new Set(config.fileNames);
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    assert.ok(discovered.has(spec), `${spec} must run in the browser CI job`);
    assert.ok(checked.has(path.join(e2e, spec)), `${spec} must be included in the journey typecheck`);
  }
});
