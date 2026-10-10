import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as osUp from './os-up.mjs';
import { REPO_ROOT } from './runner/config.mjs';
import { runPanelRefresh } from './runner/panel-refresh.mjs';

// scripts/runner/panel-refresh.mjs: the daily panel refresh
// child. The command is answered here; nothing runs `pnpm signals:refresh`.

const UP = { running: true, ready: true };

function lane(answer = { code: 0 }) {
  const ran = [];
  const lines = [];
  const deps = {
    run: async (command, args, options) => {
      ran.push({ command, args, cwd: options.cwd, timeoutMs: options.timeoutMs });
      return answer;
    },
    state: { skipping: null, running: false },
    emit: (level, text) => lines.push(`${level} ${text}`),
    stopped: () => false,
  };
  return { deps, ran, lines };
}

test('one pass runs pnpm signals:refresh from the code checkout and reports its exit', async () => {
  const { deps, ran, lines } = lane();
  const result = await runPanelRefresh(UP, deps);
  assert.deepEqual(ran, [{ command: 'pnpm', args: ['signals:refresh'], cwd: REPO_ROOT, timeoutMs: 15 * 60_000 }]);
  assert.equal(result.code, 0);
  assert.match(lines.at(-1), /^INFO panel refresh finished in \d+s$/u);
  const failing = lane({ code: 2 });
  assert.equal((await runPanelRefresh(UP, failing.deps)).code, 2);
  assert.match(failing.lines.at(-1), /^ERROR panel refresh exited 2 after/u);
});

test('a down runtime or a pass still running runs nothing, said once', async () => {
  const { deps, ran, lines } = lane();
  assert.equal(await runPanelRefresh({ running: false, ready: false }, deps), null);
  assert.equal(await runPanelRefresh({ running: false, ready: false }, deps), null);
  deps.state.running = true;
  assert.equal(await runPanelRefresh(UP, deps), null);
  assert.deepEqual(ran, []);
  assert.deepEqual(lines.map((line) => line.split(' — ')[1]), [
    'ingest is down/restarting (silent until it changes)',
    'the previous pass has not finished (silent until it changes)',
  ]);
});

test('a command that could not start is a failed pass, not a crash', async () => {
  const { deps } = lane({ code: null, error: new Error('pnpm not found') });
  assert.deepEqual(await runPanelRefresh(UP, deps), { code: 1, seconds: 0 });
  assert.equal(deps.state.running, false, 'the lane is free for the next pass');
});

test('os-up.mjs still offers the same panel refresh', () => {
  assert.equal(osUp.runPanelRefresh, runPanelRefresh);
});
