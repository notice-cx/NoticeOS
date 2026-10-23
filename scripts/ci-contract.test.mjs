import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PR_SMOKE } from '../apps/tower/e2e/fixtures.ts';
import { JOBS as SCOPED_JOBS, neededJobs } from './ci-scope.mjs';

// The root is intentionally not a pnpm workspace. That keeps the recursive
// workspace commands valid when there are zero workspaces, but it also means
// `pnpm -r test` cannot discover this directory, and CI can skip every operator
// script test while still presenting one green test step. This contract makes
// dropping the explicit root-suite step fail the very suite the step is
// responsible for running.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const MANIFEST = path.join(REPO_ROOT, 'package.json');

// The step that gives the suites a Postgres server. Without one,
// scripts/postgres-model.test.mjs and postgres-migrate.test.mjs would skip,
// and CI would pass without ever running the workspace-isolation proof; so
// would the Workers' suites on the store (workers/ingest/test/postgres-store.test.ts,
// apps/tower/test/postgres-store.test.ts and runner-door-e2e.test.ts).
const POSTGRES_STEP =
  '(test -x /usr/lib/postgresql/18/bin/initdb || (sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && sudo apt-get install -y -qq --no-install-recommends postgresql-18)) && echo /usr/lib/postgresql/18/bin >> "$GITHUB_PATH"';

function runCommands(workflow) {
  return [...workflow.matchAll(/^\s*-\s+run:\s*(.+?)\s*$/gmu)].map((match) => match[1]);
}

// Keep the checked-in two-space job layout explicit. Looking through the whole
// workflow could borrow a required gate from a different, optional job.
function jobBlock(workflow, name) {
  const lines = workflow.split('\n');
  const jobsAt = lines.indexOf('jobs:');
  assert.notEqual(jobsAt, -1, 'CI must declare jobs');
  const jobAt = lines.indexOf(`  ${name}:`, jobsAt + 1);
  assert.notEqual(jobAt, -1, `CI must declare the ${name} job`);
  const rest = lines.slice(jobAt + 1);
  const nextBlock = rest.findIndex((line) => /^(?:\S| {2}\S)/u.test(line));
  return rest.slice(0, nextBlock === -1 ? undefined : nextBlock).join('\n');
}

// Each gate in one job, in order (issue #2): the Tower's unit suite, the other
// workspaces' (the two filters split `pnpm -r` between them, so every
// workspace is typechecked and tested once), the root script suite (the root
// is not a workspace, so no `pnpm -r` reaches it), the build with the browser
// smoke journeys and the journey harness (PR lane), the build with every
// browser journey, the journey harness with the UX flow gate, and the task
// store (full lane). Every job that starts Postgres puts the server binaries
// on PATH first.
const INSTALL = 'pnpm install --frozen-lockfile';
const BROWSER_INSTALL = 'pnpm --filter @noticeos/tower run journey:install --with-deps';
const TASK_TOOLS = 'node scripts/task-store-test-tools.mjs --out "$RUNNER_TEMP/task-store" >> "$GITHUB_ENV"';
const HARNESS = 'pnpm --filter @noticeos/tower run test:journey-harness';
// The journeys run as one matrix job of shards; each runs its share.
const JOURNEYS = 'pnpm --filter @noticeos/tower run test:journeys -- --shard=${{ matrix.shard }}/3';
const SMOKE = `pnpm --filter @noticeos/tower run test:journeys -- --grep ${PR_SMOKE}`;
const JOBS = {
  'tower-unit': [INSTALL, 'pnpm --filter @noticeos/tower run typecheck', POSTGRES_STEP, 'pnpm --filter @noticeos/tower run test'],
  'ingest-unit': [INSTALL, "pnpm -r --filter '!@noticeos/tower' typecheck", POSTGRES_STEP, "pnpm -r --filter '!@noticeos/tower' test"],
  scripts: [INSTALL, POSTGRES_STEP, 'pnpm test:scripts'],
  smoke: [INSTALL, POSTGRES_STEP, 'pnpm -r build', BROWSER_INSTALL, HARNESS, SMOKE],
  browser: [INSTALL, POSTGRES_STEP, 'pnpm -r build', BROWSER_INSTALL, JOURNEYS],
  'flow-gate': [INSTALL, POSTGRES_STEP, BROWSER_INSTALL, HARNESS, 'pnpm --filter @noticeos/tower run test:ux-flows'],
  // The opt-in real task store suites get their pinned inputs first.
  'task-store': [INSTALL, POSTGRES_STEP, TASK_TOOLS, 'pnpm test:task-store'],
};
/** The suites that start a Postgres server, so must run after POSTGRES_STEP. */
const POSTGRES_SUITES = ['pnpm --filter @noticeos/tower run test', "pnpm -r --filter '!@noticeos/tower' test", 'pnpm test:scripts',
  JOURNEYS, SMOKE, HARNESS, 'pnpm --filter @noticeos/tower run test:ux-flows', 'pnpm test:task-store'];
/** A suite's command without the arguments that pick its share of tests. */
const suiteOf = (command) => command.replace(/ -- .*$/u, '');
/** The lanes: a pull request whose change reaches every job it can run, and every other run. */
const LANES = { 'pull request': neededJobs('pull_request', ['pnpm-lock.yaml']), full: neededJobs('push') };

test('the workflow declares every job the scope decides, with the gates pinned here', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.deepEqual(Object.keys(JOBS), [...SCOPED_JOBS]);
  for (const [name, expected] of Object.entries(JOBS)) {
    assert.deepEqual(runCommands(jobBlock(workflow, name)), expected, `the ${name} job's gates`);
  }
});

test('each lane runs every one of its gates exactly once, and the full lane runs every suite any lane runs', () => {
  const ran = {};
  for (const [lane, needed] of Object.entries(LANES)) {
    const gates = new Map();
    for (const name of Object.keys(JOBS).filter((job) => needed[job])) {
      for (const command of JOBS[name]) gates.set(command, (gates.get(command) ?? 0) + 1);
    }
    for (const [command, count] of gates) {
      if (command === INSTALL || command === POSTGRES_STEP || command === BROWSER_INSTALL) continue;
      assert.equal(count, 1, `the ${lane} lane runs ${command} in more than one job`);
    }
    ran[lane] = new Set([...gates.keys()].map(suiteOf));
  }
  for (const suite of ran['pull request']) assert.ok(ran.full.has(suite), `${suite} runs on a pull request but not in the full lane`);
  const every = new Set(Object.values(JOBS).flat().map(suiteOf));
  assert.deepEqual([...every].filter((suite) => !ran.full.has(suite)), [], 'the full lane runs every suite');
});

test('a Postgres suite never runs before its job puts the server binaries on PATH', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  for (const name of Object.keys(JOBS)) {
    const commands = runCommands(jobBlock(workflow, name));
    for (const suite of POSTGRES_SUITES.filter((command) => commands.includes(command))) {
      assert.ok(commands.indexOf(POSTGRES_STEP) !== -1 && commands.indexOf(POSTGRES_STEP) < commands.indexOf(suite),
        `${name}: ${suite} runs before the Postgres step`);
    }
  }
});

// A job downloads only what its own suites start, and PostgreSQL 18 is the
// one supported major: no job installs, or points a suite at, another.
test('each job installs only its own prerequisites, on PostgreSQL 18 alone', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  for (const [step, owners] of [[BROWSER_INSTALL, ['smoke', 'browser', 'flow-gate']], [TASK_TOOLS, ['task-store']]]) {
    const jobs = Object.keys(JOBS).filter((name) => runCommands(jobBlock(workflow, name)).includes(step));
    assert.deepEqual(jobs, owners, `${step} runs only in the jobs whose suites use it`);
  }
  assert.deepEqual([...POSTGRES_STEP.matchAll(/postgresql-(\d+)/gu)].map((match) => match[1]), ['18'], 'the step installs one server major');
  assert.deepEqual([...new Set([...workflow.matchAll(/postgresql[-/](\d+)/gu)].map((match) => match[1]))], ['18'], 'no job names another PostgreSQL major');
  assert.doesNotMatch(workflow, /NOTICEOS_TEST_POSTGRES\d+_BIN/u, 'no suite receives a second set of server binaries');
});

// `pnpm test:journeys` is one command for an agent at a checkout, and two
// jobs in CI so the journeys and the flow gate run side by side. Every step of
// it still runs in the full lane: the journeys' types in the Tower typecheck
// (pinned below), the rest as the same commands.
test('CI runs every step of pnpm test:journeys', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const steps = [...manifest.scripts['test:journeys'].matchAll(/pnpm --filter @noticeos\/tower run [\w:-]+/gu)].map((match) => match[0]);
  assert.equal(steps.length, 4, `the steps of pnpm test:journeys: ${steps.join(', ')}`);
  const full = Object.keys(JOBS).filter((name) => LANES.full[name]).flatMap((name) => JOBS[name].map(suiteOf));
  for (const step of steps) {
    const ran = step === 'pnpm --filter @noticeos/tower run typecheck:journeys' ? 'pnpm --filter @noticeos/tower run typecheck' : step;
    assert.ok(full.includes(ran), `${step} never runs in the full lane`);
  }
});

// GitHub counts a skipped required check as passing, so the verdict itself
// must refuse a job that skipped although the scope needed it.
test('the scope decides every job but the script suite, and the verdict judges each against it', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}merge_group:\n(?: {2}#.*\n)* {2}schedule:\n {4}- cron: '[\d* ]+'\n {2}workflow_dispatch:\n/mu,
    'pull requests, the merge queue, main, a nightly run and a hand-started run');
  const scope = jobBlock(workflow, 'scope');
  assert.deepEqual(runCommands(scope), ['node scripts/ci-scope.mjs']);
  assert.match(scope, /fetch-depth: 2\n/u, "the merge commit's base parent is fetched");
  assert.match(scope, /needed: \$\{\{ steps\.scope\.outputs\.needed \}\}/u);
  for (const name of SCOPED_JOBS.filter((job) => job !== 'scripts')) {
    assert.match(jobBlock(workflow, name), new RegExp(`^ {4}needs: scope\\n {4}if: fromJSON\\(needs\\.scope\\.outputs\\.needed\\)\\['${name}'\\]\\n`, 'mu'),
      `${name} runs when the scope needs it`);
  }
  // The root suite reads every tracked Markdown file, so it always runs.
  assert.doesNotMatch(jobBlock(workflow, 'scripts'), /^ {4}if:/mu);
  const build = jobBlock(workflow, 'build');
  assert.match(build, new RegExp(`^ {4}needs: \\[scope, ${SCOPED_JOBS.join(', ')}\\]\\n {4}if: always\\(\\)\\n`, 'mu'), 'the required check judges every job');
  assert.match(build, /NEEDS: \$\{\{ toJSON\(needs\) \}\}\n\s+NEEDED: \$\{\{ needs\.scope\.outputs\.needed \}\}/u);

  const [verdict] = runCommands(build);
  const program = /^jq -e --argjson needed "\$NEEDED" '(.+)' <<< "\$NEEDS"$/u.exec(verdict)?.[1];
  assert.ok(program, 'the verdict is one jq program over the jobs and the scope');
  const judge = (results, needed) => {
    const needs = Object.fromEntries(Object.entries({ scope: 'success', ...results }).map(([job, result]) => [job, { result }]));
    const run = spawnSync('jq', ['-e', '--argjson', 'needed', JSON.stringify(needed), program], { input: JSON.stringify(needs), encoding: 'utf8' });
    assert.equal(run.error, undefined, 'jq runs, as it does on the runner');
    return run.status === 0;
  };
  for (const [lane, needed] of Object.entries(LANES)) {
    const passed = Object.fromEntries(SCOPED_JOBS.map((job) => [job, needed[job] ? 'success' : 'skipped']));
    assert.equal(judge(passed, needed), true, `the ${lane} lane passes when each needed job passed`);
    for (const job of SCOPED_JOBS.filter((name) => needed[name])) {
      assert.equal(judge({ ...passed, [job]: 'skipped' }, needed), false, `${lane}: a needed ${job} that skipped fails`);
      assert.equal(judge({ ...passed, [job]: 'cancelled' }, needed), false, `${lane}: a cancelled ${job} fails`);
    }
    for (const job of SCOPED_JOBS.filter((name) => !needed[name])) {
      assert.equal(judge({ ...passed, [job]: 'failure' }, needed), false, `${lane}: an unneeded ${job} that ran and failed still fails`);
    }
    assert.equal(judge({ ...passed, unnamed: 'skipped' }, needed), false, `${lane}: a job the scope does not name may not skip`);
    assert.equal(judge({ ...passed, scope: 'failure' }, needed), false, `${lane}: a failed scope fails`);
  }
});

test('job extraction cannot borrow a missing gate from a sibling job', () => {
  const workflow = 'jobs:\n  build:\n    steps:\n      - run: pnpm -r test\n\n  user-journeys:\n    steps:\n      - run: pnpm test:scripts\n';
  assert.deepEqual(runCommands(jobBlock(workflow, 'build')), ['pnpm -r test']);
  assert.throws(() => jobBlock(workflow, 'missing'), /must declare the missing job/u);
});

test('CI runs the isolated user journeys and the flow walker and keeps their evidence', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  for (const [name, step, evidence] of [
    ['browser', 'test:journeys', ['playwright-report', 'test-results']],
    // The walker's measurements, and the screenshot a flow that could not finish names.
    ['flow-gate', 'test:ux-flows', ['ux-flows-results']],
  ]) {
    const job = jobBlock(workflow, name);
    assert.doesNotMatch(job, /continue-on-error:\s*true/u);
    assert.match(job, /uses: actions\/upload-artifact@/u);
    assert.match(job, /if: always\(\)/u);
    for (const folder of evidence) assert.match(job, new RegExp(`apps/tower/e2e/${folder}/`, 'u'), `${name} keeps ${folder}`);
    // The journeys' workers and the flow gate's lanes on the runner: unset, a
    // small runner would run them all on one.
    assert.match(job, new RegExp(`- run: pnpm --filter @noticeos/tower run ${step}(?: -- [^\\n]+)?\\n\\s+env:\\n(?:\\s+#.*\\n)*\\s+JOURNEY_WORKERS: \\d+\\n`, 'u'),
      `${name} sets JOURNEY_WORKERS`);
  }

  // The journeys end with the flow walker, so every agent that touches the
  // Tower and runs the journeys sees its report, and so does CI. The walker
  // runs even when a journey fails, and the step fails if either does: a red
  // journey once hid the walker's result for whole runs (issue #3).
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(manifest.scripts?.['test:journeys'],
    'pnpm --filter @noticeos/tower run typecheck:journeys && pnpm --filter @noticeos/tower run test:journey-harness && { pnpm --filter @noticeos/tower run test:journeys; journeys=$?; pnpm --filter @noticeos/tower run test:ux-flows && exit $journeys; }');
  const tower = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps', 'tower', 'package.json'), 'utf8'));
  assert.equal(tower.scripts?.['test:ux-flows'], 'node e2e/flow-gate.mjs');
  assert.equal(manifest.scripts?.['audit:flows'], 'node apps/tower/e2e/flow-gate.mjs');
  assert.equal(manifest.scripts?.['audit:flows:baseline'], undefined, 'the walker keeps no budget to lower');
});

// Each shard runs its share of the journeys and keeps its own evidence; a
// failed shard leaves the others running, and `build` fails on any of them.
test('the journey shards together run every journey once', () => {
  const browser = jobBlock(readFileSync(WORKFLOW, 'utf8'), 'browser');
  const matrix = /^ {4}strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}shard: \[([\d, ]+)\]\n/mu.exec(browser);
  assert.ok(matrix, 'the browser job is a matrix of shards, and one failing shard does not stop the rest');
  const shards = matrix[1].split(',').map(Number);
  assert.deepEqual(shards, shards.map((_, index) => index + 1), 'the shards are numbered from 1 with none missing');
  assert.ok(runCommands(browser).includes(`pnpm --filter @noticeos/tower run test:journeys -- --shard=\${{ matrix.shard }}/${shards.length}`),
    'each shard runs its own share of all the shards');
  assert.match(browser, /name: user-journey-browser-evidence-\$\{\{ matrix\.shard \}\}\n/u, 'each shard keeps its own evidence');
});

test('every job stops after at most 30 minutes', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  for (const name of [...Object.keys(JOBS), 'scope', 'build']) {
    const limit = /^ {4}timeout-minutes: (\d+)\n/mu.exec(jobBlock(workflow, name));
    assert.ok(limit && Number(limit[1]) <= 30, `${name} declares a time limit of at most 30 minutes`);
  }
});

// A cancelled run must not leave a skipped required check, which GitHub
// counts as passing.
test('a newer push cancels only the pull request run it replaces', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^concurrency:\n {2}group: ci-\$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.number \|\| github\.run_id \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/mu,
    'pull request runs share a group per pull request; every other run has its own');
  assert.match(jobBlock(workflow, 'build'), /^ {4}if: always\(\)\n/mu, 'build runs, and fails, on a cancelled run');
});

test('the Postgres suites run with NOTICEOS_REQUIRE_POSTGRES=1, the unit suites on the whole runner', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  // Match the pinned host major, including its builtin C.UTF-8 locale.
  assert.equal(Number(/postgresql\/(\d+)\/bin/u.exec(POSTGRES_STEP)[1]), 18);
  // Ubuntu's runner removes PGDG after preparing its bundled PostgreSQL 16.
  assert.match(POSTGRES_STEP, /apt\.postgresql\.org\.sh -y/u);
  for (const [name, suite] of [['tower-unit', 'pnpm --filter @noticeos/tower run test'], ['ingest-unit', "pnpm -r --filter '!@noticeos/tower' test"], ['scripts', 'pnpm test:scripts'],
    ['task-store', 'pnpm test:task-store']]) {
    const step = new RegExp(`- run: ${suite.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n\\s+env:\\n\\s+NOTICEOS_REQUIRE_POSTGRES: '1'\\n`, 'u');
    assert.match(jobBlock(workflow, name), step, `${suite} must run with NOTICEOS_REQUIRE_POSTGRES=1, so a server that cannot start fails the build`);
  }
  // Each unit suite has its runner to itself (scripts/unit-test-workers.mts).
  for (const name of ['tower-unit', 'ingest-unit']) {
    assert.match(jobBlock(workflow, name), /UNIT_TEST_WORKERS: 100%\n/u, `${name} uses every core`);
  }
});

// The journey harness stubs the ingest door's typed RPC. Type-checking the
// browser-journey code inside the Tower's own typecheck puts contract drift in
// the first CI gate rather than in the journey step.
test('the Tower typecheck gate also type-checks the browser-journey harness', () => {
  const tower = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps', 'tower', 'package.json'), 'utf8'));
  const steps = String(tower.scripts?.typecheck ?? '').split('&&').map((step) => step.trim());
  assert.ok(steps.includes('tsc -p e2e/tsconfig.json'),
    `apps/tower typecheck must run tsc -p e2e/tsconfig.json; it runs: ${steps.join(' && ')}`);
  assert.equal(tower.scripts?.['typecheck:journeys'], 'tsc -p e2e/tsconfig.json');
});

test('the CI root-suite command still targets every operator-script test', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  // The preload arms the config guard in each test file's process
  // (scripts/test-config-isolation.mjs); the global setup gives the run one
  // folder for its Worker bundles.
  assert.equal(
    manifest.scripts?.['test:scripts'],
    'node --import ./scripts/script-tests-setup.mjs --test-global-setup=./scripts/script-tests-global.mjs --test scripts/*.test.mjs',
    'test:scripts must remain the root Node suite over every scripts/*.test.mjs file, run on fixture configuration',
  );
});
