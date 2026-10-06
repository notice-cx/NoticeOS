import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The root is intentionally not a pnpm workspace. That keeps the recursive
// workspace commands valid when there are zero workspaces, but it also means
// `pnpm -r test` cannot discover this directory. CI once skipped every operator
// script test while still presenting one green test step (bead ro-osp). This
// contract makes dropping the explicit root-suite step fail the very suite the
// step is responsible for running.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const MANIFEST = path.join(REPO_ROOT, 'package.json');

// The step that gives the suites a Postgres server (bead ro-ujb9.76.15).
// Without one, scripts/postgres-model.test.mjs and postgres-migrate.test.mjs
// would skip, and CI would pass without ever running the D27 workspace-
// isolation proof; so would the Workers' suites on the store they are moving
// to (epic ro-ujb9.76: workers/ingest/test/postgres-store.test.ts,
// apps/tower/test/postgres-store.test.ts and runner-door-e2e.test.ts).
const POSTGRES_STEP =
  '(test -x /usr/lib/postgresql/18/bin/initdb && test -x /usr/lib/postgresql/17/bin/initdb || (sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y && sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends postgresql-17 postgresql-18)) && echo /usr/lib/postgresql/18/bin >> "$GITHUB_PATH"';

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
// is not a workspace, so no `pnpm -r` reaches it, bead ro-osp), the build with
// the browser journeys, and the journey harness with the UX flow gate. Every
// job that starts Postgres puts the server binaries on PATH first.
const INSTALL = 'pnpm install --frozen-lockfile';
const BROWSER_INSTALL = 'pnpm --filter @noticeos/tower run journey:install --with-deps';
const JOBS = {
  'tower-unit': [INSTALL, 'pnpm --filter @noticeos/tower run typecheck', POSTGRES_STEP, 'pnpm --filter @noticeos/tower run test'],
  'ingest-unit': [INSTALL, "pnpm -r --filter '!@noticeos/tower' typecheck", POSTGRES_STEP, "pnpm -r --filter '!@noticeos/tower' test"],
  scripts: [INSTALL, POSTGRES_STEP, 'pnpm test:scripts'],
  browser: [INSTALL, POSTGRES_STEP, 'pnpm -r build', BROWSER_INSTALL, 'pnpm --filter @noticeos/tower run test:journeys'],
  'flow-gate': [INSTALL, POSTGRES_STEP, BROWSER_INSTALL, 'pnpm --filter @noticeos/tower run test:journey-harness',
    'pnpm --filter @noticeos/tower run test:ux-flows'],
};
/** The jobs a documentation-only pull request skips (scripts/ci-scope.mjs). */
const RUNTIME_JOBS = ['tower-unit', 'ingest-unit', 'browser', 'flow-gate'];
/** The suites that start a Postgres server, so must run after POSTGRES_STEP. */
const POSTGRES_SUITES = ['pnpm --filter @noticeos/tower run test', "pnpm -r --filter '!@noticeos/tower' test", 'pnpm test:scripts',
  'pnpm --filter @noticeos/tower run test:journeys', 'pnpm --filter @noticeos/tower run test:journey-harness',
  'pnpm --filter @noticeos/tower run test:ux-flows'];

test('required CI runs every gate exactly once, each in its job, in gate order', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const gates = new Map();
  for (const [name, expected] of Object.entries(JOBS)) {
    const commands = runCommands(jobBlock(workflow, name));
    assert.deepEqual(commands, expected, `the ${name} job's gates`);
    for (const command of commands) gates.set(command, (gates.get(command) ?? 0) + 1);
  }
  for (const [command, count] of gates) {
    if (command === INSTALL || command === POSTGRES_STEP || command === BROWSER_INSTALL) continue;
    assert.equal(count, 1, `${command} runs in more than one job`);
  }
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

// `pnpm test:journeys` is one command for an agent at a checkout, and two
// jobs in CI so the journeys and the flow gate run side by side. Every step of
// it still runs: the journeys' types in the Tower typecheck (pinned below),
// the rest as the same commands.
test('CI runs every step of pnpm test:journeys', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const steps = [...manifest.scripts['test:journeys'].matchAll(/pnpm --filter @noticeos\/tower run [\w:-]+/gu)].map((match) => match[0]);
  assert.equal(steps.length, 4, `the steps of pnpm test:journeys: ${steps.join(', ')}`);
  const ci = Object.keys(JOBS).flatMap((name) => runCommands(jobBlock(workflow, name)));
  for (const step of steps) {
    const ran = step === 'pnpm --filter @noticeos/tower run typecheck:journeys' ? 'pnpm --filter @noticeos/tower run typecheck' : step;
    assert.ok(ci.includes(ran), `${step} never runs in CI`);
  }
});

test('documentation-only pull requests skip the unit, browser and flow-gate jobs; the script suite and every push run everything', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/mu);
  const scope = jobBlock(workflow, 'scope');
  assert.deepEqual(runCommands(scope), ['node scripts/ci-scope.mjs']);
  assert.match(scope, /fetch-depth: 2\n/u, "the merge commit's base parent is fetched");
  assert.match(scope, /runtime: \$\{\{ steps\.scope\.outputs\.runtime \}\}/u);
  for (const name of RUNTIME_JOBS) {
    const job = jobBlock(workflow, name);
    assert.match(job, /^ {4}needs: scope\n {4}if: needs\.scope\.outputs\.runtime == 'true'\n/mu, `${name} runs unless the change is documentation only`);
  }
  // The root suite reads every tracked Markdown file, so it always runs.
  assert.doesNotMatch(jobBlock(workflow, 'scripts'), /^ {4}if:/mu);
  const build = jobBlock(workflow, 'build');
  assert.match(build, /^ {4}needs: \[scope, tower-unit, ingest-unit, scripts, browser, flow-gate\]\n {4}if: always\(\)\n/mu, 'the required check judges every job');
  const [verdict] = runCommands(build);
  assert.ok(verdict.includes(`[${RUNTIME_JOBS.map((name) => (name.includes('-') ? `."${name}"` : `.${name}`)).join(', ')}] | map(.result)`),
    'the verdict judges every job a documentation-only change may skip');
  assert.match(verdict, /^jq -e --arg runtime "\$RUNTIME" '/u);
  assert.match(verdict, /\.scope\.result == "success" and \.scripts\.result == "success"/u, 'the scope job and the script suite always pass');
  assert.match(verdict, /\(\. == "skipped" and \$runtime == "false"\)/u, 'a runtime job may skip only on a documentation-only change');
  assert.match(build, /NEEDS: \$\{\{ toJSON\(needs\) \}\}\n\s+RUNTIME: \$\{\{ needs\.scope\.outputs\.runtime \}\}/u);
});

test('job extraction cannot borrow a missing gate from a sibling job', () => {
  const workflow = 'jobs:\n  build:\n    steps:\n      - run: pnpm -r test\n\n  user-journeys:\n    steps:\n      - run: pnpm test:scripts\n';
  assert.deepEqual(runCommands(jobBlock(workflow, 'build')), ['pnpm -r test']);
  assert.throws(() => jobBlock(workflow, 'missing'), /must declare the missing job/u);
});

test('CI runs the isolated user journeys and the flow gate and keeps their evidence', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  for (const [name, step, evidence] of [
    ['browser', 'test:journeys', ['playwright-report', 'test-results']],
    // The screenshot every flow-gate failure names (bead ro-ujb9.95).
    ['flow-gate', 'test:ux-flows', ['ux-flows-results']],
  ]) {
    const job = jobBlock(workflow, name);
    assert.doesNotMatch(job, /continue-on-error:\s*true/u);
    assert.match(job, /uses: actions\/upload-artifact@/u);
    assert.match(job, /if: always\(\)/u);
    for (const folder of evidence) assert.match(job, new RegExp(`apps/tower/e2e/${folder}/`, 'u'), `${name} keeps ${folder}`);
    // The journeys' workers and the flow gate's lanes on the runner (bead
    // ro-ujb9.167): unset, a small runner would run them all on one.
    assert.match(job, new RegExp(`- run: pnpm --filter @noticeos/tower run ${step}\\n\\s+env:\\n(?:\\s+#.*\\n)*\\s+JOURNEY_WORKERS: \\d+\\n`, 'u'),
      `${name} sets JOURNEY_WORKERS`);
  }

  // The journeys end with the UX flow gate, so every agent that touches the
  // Tower and runs the journeys meets it, and so does CI (bead ro-ujb9.95).
  // The gate runs even when a journey fails, and the step fails if either
  // does: a red journey once hid the gate's verdict for whole runs (issue #3).
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(manifest.scripts?.['test:journeys'],
    'pnpm --filter @noticeos/tower run typecheck:journeys && pnpm --filter @noticeos/tower run test:journey-harness && { pnpm --filter @noticeos/tower run test:journeys; journeys=$?; pnpm --filter @noticeos/tower run test:ux-flows && exit $journeys; }');
  const tower = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps', 'tower', 'package.json'), 'utf8'));
  assert.equal(tower.scripts?.['test:ux-flows'], 'node e2e/flow-gate.mjs');
  assert.equal(manifest.scripts?.['ux:flows'], 'node apps/tower/e2e/flow-gate.mjs');
  assert.equal(manifest.scripts?.['ux:flows:baseline'], 'node apps/tower/e2e/flow-gate.mjs --write-baseline');
});

test('the Postgres suites run with NOTICEOS_REQUIRE_POSTGRES=1, the unit suites on the whole runner', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  // Match the pinned host major, including its builtin C.UTF-8 locale.
  assert.equal(Number(/postgresql\/(\d+)\/bin/u.exec(POSTGRES_STEP)[1]), 18);
  // Ubuntu's runner removes PGDG after preparing its bundled PostgreSQL 16.
  assert.match(POSTGRES_STEP, /apt\.postgresql\.org\.sh -y/u);
  const scripts = jobBlock(workflow, 'scripts');
  assert.match(scripts, /NOTICEOS_TEST_POSTGRES17_BIN: \/usr\/lib\/postgresql\/17\/bin/u, 'the cross-major restore proof receives explicit old binaries');
  for (const [name, suite] of [['tower-unit', 'pnpm --filter @noticeos/tower run test'], ['ingest-unit', "pnpm -r --filter '!@noticeos/tower' test"], ['scripts', 'pnpm test:scripts']]) {
    const step = new RegExp(`- run: ${suite.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n\\s+env:\\n\\s+NOTICEOS_REQUIRE_POSTGRES: '1'\\n`, 'u');
    assert.match(jobBlock(workflow, name), step, `${suite} must run with NOTICEOS_REQUIRE_POSTGRES=1, so a server that cannot start fails the build`);
  }
  // Each unit suite has its runner to itself (scripts/unit-test-workers.mts).
  for (const name of ['tower-unit', 'ingest-unit']) {
    assert.match(jobBlock(workflow, name), /UNIT_TEST_WORKERS: 100%\n/u, `${name} uses every core`);
  }
});

// The journey harness stubs the ingest door's typed RPC. When that contract
// changed, only the journey step noticed, after every other gate was green
// (bead ro-ujb9.78). Type-checking the browser-journey code inside the Tower's
// own typecheck puts contract drift in the first CI gate.
test('the Tower typecheck gate also type-checks the browser-journey harness', () => {
  const tower = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps', 'tower', 'package.json'), 'utf8'));
  const steps = String(tower.scripts?.typecheck ?? '').split('&&').map((step) => step.trim());
  assert.ok(steps.includes('tsc -p e2e/tsconfig.json'),
    `apps/tower typecheck must run tsc -p e2e/tsconfig.json; it runs: ${steps.join(' && ')}`);
  assert.equal(tower.scripts?.['typecheck:journeys'], 'tsc -p e2e/tsconfig.json');
});

test('the CI root-suite command still targets every operator-script test', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  // The preload arms the config guard in each test file's process (bead
  // ro-ujb9.97, scripts/test-config-isolation.mjs); the global setup gives the
  // run one folder for its Worker bundles (issue #10).
  assert.equal(
    manifest.scripts?.['test:scripts'],
    'node --import ./scripts/script-tests-setup.mjs --test-global-setup=./scripts/script-tests-global.mjs --test scripts/*.test.mjs',
    'test:scripts must remain the root Node suite over every scripts/*.test.mjs file, run on fixture configuration',
  );
});
