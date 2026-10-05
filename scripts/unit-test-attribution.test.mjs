import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  attributionReporter, traceOn, unfinishedFiles, unfinishedReport, unitTestAttribution,
} from './unit-test-attribution.mjs';

// A unit-test worker that dies names the file it was running (bead
// ro-ujb9.179). Vitest alone said "Worker exited unexpectedly" and counted the
// file as neither passed nor failed ("1 passed (2)").

const root = fileURLToPath(new URL('../', import.meta.url));

/** A stand-in for Vitest's TestModule. */
const module = (name, state) => ({ moduleId: `/repo/${name}`, relativeModuleId: name, state: () => state });

test('the files still queued or running at the end are the unfinished ones, the running one first', () => {
  const modules = [
    module('test/done.test.ts', 'passed'),
    module('test/failed.test.ts', 'failed'),
    module('test/skipped.test.ts', 'skipped'),
    module('test/waiting.test.ts', 'queued'),
    module('test/dying.test.ts', 'pending'),
  ];
  assert.deepEqual(unfinishedFiles(modules, new Map([['/repo/test/dying.test.ts', 'suite > dies']])), [
    { file: 'test/dying.test.ts', started: true, test: 'suite > dies' },
    { file: 'test/waiting.test.ts', started: false, test: null },
  ]);
});

test('the report names each file and what it was doing, and says nothing when all finished', () => {
  assert.equal(unfinishedReport([]), null);
  assert.equal(
    unfinishedReport([
      { file: 'test/dying.test.ts', started: true, test: 'dies' },
      { file: 'test/importing.test.ts', started: true, test: null },
      { file: 'test/waiting.test.ts', started: false, test: null },
    ]),
    '\nUnit test files that never finished — their test worker exited:\n' +
      '  test/dying.test.ts — while running "dies"\n' +
      '  test/importing.test.ts — started\n' +
      '  test/waiting.test.ts — not started\n',
  );
});

test('the reporter follows which test each file is in, and speaks only after a worker died', () => {
  const lines = [];
  const reporter = attributionReporter({ env: {}, write: (text) => lines.push(text) });
  const dying = module('test/dying.test.ts', 'pending');
  const other = module('test/other.test.ts', 'passed');
  reporter.onTestModuleStart(dying);
  reporter.onTestCaseReady({ fullName: 'first', module: dying });
  reporter.onTestCaseResult({ fullName: 'first', module: dying });
  reporter.onTestCaseReady({ fullName: 'second', module: dying });
  reporter.onTestCaseReady({ fullName: 'fine', module: other });
  reporter.onTestCaseResult({ fullName: 'fine', module: other });
  // No trace line without UNIT_TEST_TRACE.
  assert.deepEqual(lines, []);

  // A clean run, and an interrupted one, say nothing.
  reporter.onTestRunEnd([other], [], 'passed');
  reporter.onTestRunEnd([dying, other], [new Error('x')], 'interrupted');
  assert.deepEqual(lines, []);

  reporter.onTestRunEnd([dying, other], [new Error('Worker exited unexpectedly')], 'failed');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /test\/dying\.test\.ts — while running "second"/);
  assert.doesNotMatch(lines[0], /other\.test\.ts/);
});

test('UNIT_TEST_TRACE=1 prints each file as it starts', () => {
  assert.equal(traceOn({}), false);
  assert.equal(traceOn({ UNIT_TEST_TRACE: '0' }), false);
  assert.equal(traceOn({ UNIT_TEST_TRACE: '1' }), true);
  assert.equal(traceOn({ UNIT_TEST_TRACE: 'true' }), true);
  const lines = [];
  attributionReporter({ env: { UNIT_TEST_TRACE: '1' }, write: (text) => lines.push(text) })
    .onTestModuleStart(module('test/a.test.ts', 'pending'));
  assert.deepEqual(lines, ['▶ test/a.test.ts\n']);
});

test('the plugin adds its reporter beside the ones Vitest chose, never instead of them', () => {
  const reporters = [['agent', {}], ['github-actions', {}]];
  unitTestAttribution({}).configureVitest({ vitest: { config: { reporters } } });
  assert.equal(reporters.length, 3);
  assert.deepEqual(reporters.slice(0, 2), [['agent', {}], ['github-actions', {}]]);
  assert.equal(typeof reporters[2].onTestRunEnd, 'function');
});

test('both unit suites load it', () => {
  for (const config of ['apps/tower/vitest.config.ts', 'workers/ingest/vitest.config.ts']) {
    const source = readFileSync(path.join(root, config), 'utf8');
    assert.match(source, /unitTestAttribution\(\),/, config);
  }
});

// The real thing, against the Vitest this repo installs: a worker killed in
// the middle of a test. Proves the hook still exists and still hears of it.
//
// The worker is killed only once the main process has heard the test start
// (bead ro-ujb9.225). A Vitest worker sends test events in batches, at most
// one batch per 100 ms (the runner's `sendTasksUpdateThrottled`), so a fixed
// wait before the kill (it was 100 ms) raced the batch that says the test
// started, and on a loaded host the kill won: "dying.test.mjs — started", with
// no test named. Now a reporter in the main process writes `heard` when it is
// told the test started, and the test kills its worker once that file exists.
//
// The beforeEach is what makes that batch go out at all. Vitest holds a batch
// on a timer, and a timer that fires with the clock exactly 100 ms on leaves
// the batch unsent until the worker's next event more than 100 ms later: a
// test waiting for `heard` would wait forever. The hook's end is that event.
test('a real Vitest run whose worker is killed mid-test names the file and the test', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'unit-test-attribution-'));
  try {
    const heard = JSON.stringify(path.join(dir, 'heard'));
    writeFileSync(path.join(dir, 'fine.test.mjs'), "it('passes', () => {});\n");
    writeFileSync(path.join(dir, 'dying.test.mjs'),
      "import { existsSync } from 'node:fs';\n" +
      'beforeEach(() => new Promise((resolve) => setTimeout(resolve, 150)));\n' +
      "it('dies mid-run', async () => {\n" +
      `  while (!existsSync(${heard})) await new Promise((resolve) => setTimeout(resolve, 10));\n` +
      "  process.kill(process.pid, 'SIGKILL');\n" +
      '  await new Promise((resolve) => setTimeout(resolve, 5000));\n' +
      '}, 60_000);\n');
    const plugin = JSON.stringify(path.join(root, 'scripts/unit-test-attribution.mjs'));
    writeFileSync(path.join(dir, 'vitest.config.mjs'),
      "import { writeFileSync } from 'node:fs';\n" +
      `import { unitTestAttribution } from ${plugin};\n` +
      // Added the way the attribution plugin adds its own, beside Vitest's reporters.
      'const heard = { name: "heard", configureVitest({ vitest }) { vitest.config.reporters.push({\n' +
      `  onTestCaseReady(testCase) { if (testCase.name === "dies mid-run") writeFileSync(${heard}, ""); },\n` +
      '}); } };\n' +
      'export default { plugins: [unitTestAttribution({}), heard], test: { globals: true, pool: "forks", include: ["*.test.mjs"] } };\n');
    const run = spawnSync(process.execPath, [
      path.join(root, 'apps/tower/node_modules/vitest/vitest.mjs'), 'run', '--root', dir, '--config', path.join(dir, 'vitest.config.mjs'),
    ], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, CI: '1', NO_COLOR: '1' } });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 1, output);
    // Vitest's own cause varies with timing: "Worker exited unexpectedly", or
    // "write EPIPE" when it next writes to the dead fork. Either way it is the
    // pool's error, and either way the file is named.
    assert.match(output, /Worker forks emitted error/, output);
    assert.match(output, /Unit test files that never finished — their test worker exited:\n {2}dying\.test\.mjs — while running "dies mid-run"/, output);
    assert.doesNotMatch(output, /fine\.test\.mjs — /, output);
    assert.ok(existsSync(path.join(dir, 'heard')), 'the worker was killed after the main process heard the test start');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
