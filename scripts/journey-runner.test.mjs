import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
