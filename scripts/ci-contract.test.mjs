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

const REQUIRED_RUNS = [
  'pnpm install --frozen-lockfile',
  'pnpm -r typecheck',
  'pnpm -r test',
  'pnpm test:scripts',
  'pnpm -r build',
];

// The step that gives the suites a Postgres server (bead ro-ujb9.76.15).
// Without one, scripts/postgres-model.test.mjs and postgres-migrate.test.mjs
// would skip, and CI would pass without ever running the D27 workspace-
// isolation proof; so would the Workers' suites on the store they are moving
// to (epic ro-ujb9.76: workers/ingest/test/postgres-store.test.ts,
// apps/tower/test/postgres-store.test.ts and postgres-runtime.test.ts).
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

test('required CI runs the root operator-script suite in gate order', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const commands = runCommands(jobBlock(workflow, 'build'));
  const positions = REQUIRED_RUNS.map((command) => commands.indexOf(command));

  for (const [index, command] of REQUIRED_RUNS.entries()) {
    assert.notEqual(
      positions[index],
      -1,
      `${command} is absent from .github/workflows/ci.yml; recursive workspace tests do not cover the root script suite`,
    );
    assert.equal(
      commands.lastIndexOf(command),
      positions[index],
      `${command} appears more than once in the required CI job`,
    );
  }

  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    `required CI gates are out of order: ${commands.join(' -> ')}`,
  );
});

test('job extraction cannot borrow a missing gate from a sibling job', () => {
  const workflow = 'jobs:\n  build:\n    steps:\n      - run: pnpm -r test\n\n  user-journeys:\n    steps:\n      - run: pnpm test:scripts\n';
  assert.deepEqual(runCommands(jobBlock(workflow, 'build')), ['pnpm -r test']);
  assert.throws(() => jobBlock(workflow, 'missing'), /must declare the missing job/u);
});

test('CI runs the isolated user journeys inside the required build job', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const job = jobBlock(workflow, 'build');
  assert.deepEqual(runCommands(job), [
    ...REQUIRED_RUNS.slice(0, 2),
    POSTGRES_STEP,
    ...REQUIRED_RUNS.slice(2),
    'pnpm --filter @noticeos/tower run journey:install --with-deps',
    'pnpm test:journeys',
  ]);
  assert.doesNotMatch(job, /continue-on-error:\s*true/u);
  assert.match(job, /uses: actions\/upload-artifact@/u);
  assert.match(job, /if: always\(\)/u);
  assert.match(job, /apps\/tower\/e2e\/playwright-report\//u);
  assert.match(job, /apps\/tower\/e2e\/test-results\//u);
  // The screenshot every flow-gate failure names (bead ro-ujb9.95).
  assert.match(job, /apps\/tower\/e2e\/ux-flows-results\//u);
  // The journeys' workers and the flow gate's lanes on the runner (bead
  // ro-ujb9.167): unset, a small runner would walk every flow on one lane.
  assert.match(job, /- run: pnpm test:journeys\n\s+env:\n(?:\s+#.*\n)*\s+JOURNEY_WORKERS: \d+\n/u);

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

test('CI runs the Postgres proofs on a real server and never lets them skip', () => {
  const job = jobBlock(readFileSync(WORKFLOW, 'utf8'), 'build');
  const commands = runCommands(job);
  assert.equal(
    commands.indexOf(POSTGRES_STEP),
    commands.indexOf('pnpm -r test') - 1,
    'the Postgres server binaries go on PATH right before the first suite that starts a server',
  );
  // Match the pinned host major, including its builtin C.UTF-8 locale.
  assert.equal(Number(/postgresql\/(\d+)\/bin/u.exec(POSTGRES_STEP)[1]), 18);
  // Ubuntu's runner removes PGDG after preparing its bundled PostgreSQL 16.
  assert.match(POSTGRES_STEP, /apt\.postgresql\.org\.sh -y/u);
  assert.match(job, /NOTICEOS_TEST_POSTGRES17_BIN: \/usr\/lib\/postgresql\/17\/bin/u, 'the cross-major restore proof receives explicit old binaries');
  for (const suite of ['pnpm -r test', 'pnpm test:scripts']) {
    const step = new RegExp(`- run: ${suite}\\n\\s+env:\\n\\s+NOTICEOS_REQUIRE_POSTGRES: '1'\\n`, 'u');
    assert.match(job, step, `${suite} must run with NOTICEOS_REQUIRE_POSTGRES=1, so a server that cannot start fails the build`);
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
