import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { codeLine, inspectCode } from './os-control.mjs';
import { DEPLOY_HEALTH_WAIT_MS, NEXT_STEP, POSTGRES_MIGRATION_SEQUENCE, parseDeployArgs, runDeploy } from './os-deploy.mjs';
import {
  RUNTIME_SLOTS,
  SHARED_STATE,
  runtimeLayout,
  statePaths,
} from './os-runtime.mjs';
import { parseJobRuns, runnerPaths, startupCatchupPlan } from './os-up.mjs';
import { postgresRequired, startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';
import { runCommand } from './run-command.mjs';
import { runnerRecordedMigrations } from './runner/database.mjs';
import { hostBackupFile } from './host-backup.mjs';

// `pnpm os:deploy`. Every case runs against a throwaway home checkout (a real
// git repository with a fake Postgres record) and a fake launchd: nothing here
// touches the operator's service, ports 5173/8791, or the checkout this test
// lives in. A commit that opens the Postgres store is held against a fake
// record, and once against a throwaway Postgres read the way the runner reads
// it.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homes = [];
after(() => {
  for (const home of homes) {
    // The secret stand-ins are chmod 000 on purpose; give them back so rm works.
    for (const file of ['.dev.secrets.json', '.dev.vars']) {
      try {
        chmodSync(path.join(home, 'workers', 'ingest', file), 0o600);
      } catch {
        // already gone
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});

function sh(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const git = (cwd, ...args) => sh(cwd, 'git', args);

function write(root, file, text) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

function commit(home, files, message) {
  for (const [file, text] of Object.entries(files)) write(home, file, text);
  git(home, 'add', '-A');
  git(home, 'commit', '-q', '-m', message);
  return git(home, 'rev-parse', 'HEAD');
}

const INIT = 'CREATE SCHEMA noticeos;\n';
const initialRecord = { version: 1, name: '0001_init', sha256: createHash('sha256').update(INIT).digest('hex') };
const wrangler = () => JSON.stringify({ hyperdrive: [{ binding: 'POSTGRES', id: 'fixture' }] });

/** A home checkout on main with a live store that has applied its one migration. */
function makeHome() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'os-deploy-home-')));
  homes.push(home);
  git(home, 'init', '-q', '-b', 'main');
  git(home, 'config', 'user.email', 'test@example.invalid');
  git(home, 'config', 'user.name', 'Deploy Test');
  git(home, 'config', 'commit.gpgsign', 'false');
  const first = commit(
    home,
    {
      '.gitignore': 'node_modules\n.local\n.wrangler\n.dev.vars\n.dev.secrets.json\n',
      'scripts/os-runtime.mjs': '// the runtime-copy marker\n',
      'scripts/os-up.mjs': '// the runner\n',
      'workers/ingest/wrangler.jsonc': wrangler(),
      'apps/tower/wrangler.jsonc': wrangler(),
      'db/postgres/migrations/0001_init.sql': INIT,
    },
    'init',
  );
  mkdirSync(path.join(home, '.wrangler', 'state'), { recursive: true });
  mkdirSync(statePaths(home).logsDir, { recursive: true });
  // Secret stand-ins nobody may read: mode 000, so any open would throw.
  for (const file of [statePaths(home).devSecrets, statePaths(home).devVars]) {
    writeFileSync(file, 'OPERATOR_TOKEN=never-read\n');
    chmodSync(file, 0o000);
  }
  return { home, first };
}

const plistFor = (home, runsFrom) =>
  `<plist><array><string>/opt/homebrew/bin/node</string><string>${
    runsFrom === 'runtime' ? path.join(runtimeLayout(home).current, 'scripts', 'os-up.mjs') : path.join(home, 'scripts', 'os-up.mjs')
  }</string></array></plist>`;

/** Real throwaway Git copies, a fake Postgres record, pnpm and launchd. */
function machine(home, overrides = {}) {
  const calls = { install: [], restart: [], out: [] };
  const deps = {
    run: runCommand,
    install: async ({ cwd }) => {
      calls.install.push(cwd);
      return { code: 0, stdout: '', stderr: '' };
    },
    readPlist: async () => plistFor(home, 'runtime'),
    readPostgresMigrations: async () => ({ ok: true, records: [initialRecord] }),
    service: async () => ({ loaded: true, state: 'running' }),
    // The restarted runner reports the commit its copy is on, as os-up does.
    restart: async ({ timeoutMs }) => {
      calls.restart.push(timeoutMs);
      const commit = git(runtimeLayout(home).current, 'rev-parse', 'HEAD');
      return { state: 'healthy', heartbeat: { pid: 2, commit } };
    },
    statusLines: () => ['● NoticeOS HEALTHY — fake'],
    out: (line) => calls.out.push(line),
    ...overrides,
  };
  return { calls, deps, text: () => calls.out.join('\n') };
}

const liveSlot = (home) => {
  const current = runtimeLayout(home).current;
  return existsSync(current) ? readlinkSync(current) : null;
};
const slotRoot = (home, name) => path.join(runtimeLayout(home).dir, name);
const records = (home) =>
  existsSync(statePaths(home).deploysFile)
    ? readFileSync(statePaths(home).deploysFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];

/** A home whose service already runs runtime-a at its first commit. */
async function deployedHome(options) {
  const fixture = makeHome(options);
  const first = machine(fixture.home);
  assert.equal(await runDeploy({ homeRoot: fixture.home, deps: first.deps }), 0, first.text());
  return fixture;
}

test('the first deploy prepares a runtime copy from main and hands the switch-over to os:install', async () => {
  const { home, first } = makeHome();
  const { calls, deps, text } = machine(home, { readPlist: async () => plistFor(home, 'checkout') });

  assert.equal(await runDeploy({ homeRoot: home, deps }), 0, text());
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);
  assert.equal(git(slotRoot(home, RUNTIME_SLOTS[0]), 'rev-parse', 'HEAD'), first);
  assert.deepEqual(calls.install, [slotRoot(home, RUNTIME_SLOTS[0])]);
  assert.deepEqual(calls.restart, [], 'the service still runs the checkout, so nothing restarts');
  assert.match(text(), /Switch it over once: pnpm os:install/u);
  // Locked, so `git worktree remove` / prune cannot take production away.
  assert.match(git(home, 'worktree', 'list', '--porcelain'), /locked NoticeOS live runtime: moved only by pnpm os:deploy/u);
  assert.equal(records(home).at(-1).result, 'prepared');
});

test('a deploy moves the live OS to main with ONE restart and a health wait, and rollback returns', async () => {
  const { home, first } = await deployedHome();
  const second = commit(home, { 'apps/tower/src/new.ts': 'export const x = 1;\n' }, 'feature');
  const { calls, deps, text } = machine(home);

  assert.equal(await runDeploy({ homeRoot: home, deps }), 0, text());
  assert.equal(liveSlot(home), RUNTIME_SLOTS[1], 'the idle copy became live');
  assert.equal(git(slotRoot(home, RUNTIME_SLOTS[1]), 'rev-parse', 'HEAD'), second);
  assert.equal(git(slotRoot(home, RUNTIME_SLOTS[0]), 'rev-parse', 'HEAD'), first, 'the previous copy is untouched');
  assert.deepEqual(calls.install, [slotRoot(home, RUNTIME_SLOTS[1])], 'installed once, in the idle copy only');
  assert.deepEqual(calls.restart, [DEPLOY_HEALTH_WAIT_MS], 'exactly one restart, with the health wait');
  assert.match(text(), new RegExp(`Deployed ${second.slice(0, 8)} \\(was ${first.slice(0, 8)}\\)`, 'u'));
  assert.deepEqual(
    { action: records(home).at(-1).action, from: records(home).at(-1).from, to: records(home).at(-1).to, result: records(home).at(-1).result },
    { action: 'deploy', from: first, to: second, result: 'healthy' },
  );

  // Deploying main again is a no-op: no install, no restart.
  const again = machine(home);
  assert.equal(await runDeploy({ homeRoot: home, deps: again.deps }), 0, again.text());
  assert.deepEqual([again.calls.install, again.calls.restart], [[], []]);
  assert.match(again.text(), /Nothing to deploy/u);

  const back = machine(home);
  assert.equal(await runDeploy({ homeRoot: home, argv: ['--rollback'], deps: back.deps }), 0, back.text());
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);
  assert.deepEqual(back.calls.install, [], 'the previous copy is already installed');
  assert.deepEqual(back.calls.restart, [DEPLOY_HEALTH_WAIT_MS]);
  assert.match(back.text(), new RegExp(`Rolled back to ${first.slice(0, 8)}`, 'u'));
});

test('deploy refuses a dirty runtime copy, and changes nothing', async () => {
  const { home } = await deployedHome();
  commit(home, { 'README.md': 'next\n' }, 'next');
  const live = slotRoot(home, RUNTIME_SLOTS[0]);

  for (const edit of [
    () => writeFileSync(path.join(live, 'scripts', 'os-up.mjs'), '// hot-fixed in production\n'),
    () => writeFileSync(path.join(live, 'stray.txt'), 'untracked\n'),
  ]) {
    git(live, 'checkout', '--', '.');
    rmSync(path.join(live, 'stray.txt'), { force: true });
    edit();
    const { calls, deps, text } = machine(home);
    assert.equal(await runDeploy({ homeRoot: home, deps }), 1, text());
    assert.match(text(), /os:deploy refused — nothing was changed/u);
    assert.match(text(), /the live runtime copy .* has local changes/u);
    assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);
    assert.equal(existsSync(slotRoot(home, RUNTIME_SLOTS[1])), false, 'no idle copy was prepared');
    assert.deepEqual([calls.install, calls.restart], [[], []]);
  }
});

test('a hand edit in production never blocks a rollback, and the next deploy still refuses it', async () => {
  const { home } = await deployedHome();
  commit(home, { 'h.txt': 'h\n' }, 'h');
  assert.equal(await runDeploy({ homeRoot: home, deps: machine(home).deps }), 0);
  const edited = slotRoot(home, RUNTIME_SLOTS[1]);
  writeFileSync(path.join(edited, 'scripts', 'os-up.mjs'), '// hot-fixed in production\n');

  const back = machine(home);
  assert.equal(await runDeploy({ homeRoot: home, argv: ['--rollback'], deps: back.deps }), 0, back.text());
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);

  commit(home, { 'i.txt': 'i\n' }, 'i');
  const next = machine(home);
  assert.equal(await runDeploy({ homeRoot: home, deps: next.deps }), 1, next.text());
  assert.match(next.text(), /the idle runtime copy .* has local changes: M scripts\/os-up\.mjs/u);
  assert.equal(readFileSync(path.join(edited, 'scripts', 'os-up.mjs'), 'utf8'), '// hot-fixed in production\n', 'the edit is kept');
});

test('deploy refuses a commit that is not on main', async () => {
  const { home } = await deployedHome();
  git(home, 'checkout', '-q', '-b', 'feature');
  const feature = commit(home, { 'apps/tower/src/wip.ts': 'export {};\n' }, 'wip');
  git(home, 'checkout', '-q', 'main');
  const { calls, deps, text } = machine(home);

  assert.equal(await runDeploy({ homeRoot: home, argv: ['--', 'feature'], deps }), 1, text());
  assert.match(text(), new RegExp(`${feature.slice(0, 8)} is not on main`, 'u'));
  assert.deepEqual([calls.install, calls.restart], [[], []]);
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);
});

test('deploy refuses to move backwards; going back is the explicit rollback', async () => {
  const { home, first } = await deployedHome();
  commit(home, { 'a.txt': 'a\n' }, 'a');
  assert.equal(await runDeploy({ homeRoot: home, deps: machine(home).deps }), 0);
  const { calls, deps, text } = machine(home);

  assert.equal(await runDeploy({ homeRoot: home, argv: [first], deps }), 1, text());
  assert.match(text(), /is not a fast-forward from the running/u);
  assert.match(text(), /pnpm os:deploy -- --rollback/u);
  assert.deepEqual([calls.install, calls.restart], [[], []]);
});

test('the runtime copy LINKS to the home store, logs and secrets — same paths as today, nothing copied or read', async () => {
  const { home } = await deployedHome();
  const copy = slotRoot(home, RUNTIME_SLOTS[0]);

  // (a) + (d): each shared path in the copy is a link that resolves to home's.
  // The secret stand-ins are mode 000, so the deploy above would have thrown had
  // it opened either; they are referenced by path only.
  for (const { path: relative } of SHARED_STATE) {
    assert.equal(lstatSync(path.join(copy, relative)).isSymbolicLink(), true, `${relative} is not a link`);
    assert.equal(readlinkSync(path.join(copy, relative)), path.join(home, relative));
  }
  assert.equal(statSync(statePaths(home).devSecrets).mode & 0o777, 0, 'the secret file was never re-permissioned');
  assert.equal(git(copy, 'status', '--porcelain'), '', 'the links are ignored, so the copy stays clean');

  // Paths other code finds relative to its own file land on home's through the links.
  for (const relative of [
    path.join('.wrangler', 'state'),
    path.join('.local', 'logs'),
    path.join('workers', 'ingest', '.dev.secrets.json'),
    path.join('workers', 'ingest', '.dev.vars'),
  ]) {
    assert.equal(realpathSync(path.join(copy, relative)), realpathSync(path.join(home, relative)));
  }

  // The runner's own paths: a runner started from the copy with the plist's
  // environment resolves EXACTLY the paths a runner started from home always has.
  const fromCopy = runnerPaths(copy, { REINDEX_OS_HOME: home });
  const fromHome = runnerPaths(home, {});
  assert.deepEqual(fromCopy, fromHome);
  assert.equal(fromCopy.towerEnv.OS_UP_PERSIST_STATE, path.join(home, '.wrangler', 'state'));
  // …and without the environment (started by hand from the copy) it still finds home.
  assert.deepEqual(runnerPaths(copy, {}), fromHome);
  // The nightly backup runs from the home checkout, so the offsite folder it
  // hands the set to is the HOME installation's host-backup.json, and the
  // checkout name a filed bead qualifies its paths with is home's too.
  assert.equal(hostBackupFile(fromCopy.backupRoot), hostBackupFile(home));
  assert.ok(hostBackupFile(fromCopy.backupRoot).startsWith(`${home}${path.sep}`));
  assert.equal(fromCopy.osCheckout, path.basename(home));
});

test('bounded catch-up plans the same recovery from the same job-run record after a deploy', async () => {
  const { home } = await deployedHome();
  const nowMs = Date.parse('2026-09-23T13:00:00.000Z');
  const record = [
    { job: 'cron 15 12 * * *', at: '2026-09-22T12:15:04.000Z', outcome: 'ran' },
    { job: 'cron 0 * * * *', at: '2026-09-23T10:00:02.000Z', outcome: 'ran' },
  ];
  writeFileSync(statePaths(home).jobRunsFile, record.map((line) => `${JSON.stringify(line)}\n`).join(''));
  const crons = ['15 12 * * *', '0 * * * *', '*/15 * * * *'];
  const copy = slotRoot(home, RUNTIME_SLOTS[0]);

  const readFrom = (codeRoot, env) => parseJobRuns(readFileSync(runnerPaths(codeRoot, env).jobRunsFile, 'utf8'));
  const planFromHome = startupCatchupPlan(crons, readFrom(home, {}), nowMs);
  const planFromCopy = startupCatchupPlan(crons, readFrom(copy, { REINDEX_OS_HOME: home }), nowMs);
  assert.deepEqual(planFromCopy, planFromHome);
  assert.ok(planFromCopy.due.some((entry) => entry.job === 'cron 15 12 * * *'), 'the missed daily lane is still owed once');
  assert.equal(
    runnerPaths(copy, { REINDEX_OS_HOME: home }).scheduleStatusFile,
    path.join(home, '.local', 'scheduled-jobs.json'),
    'the Tower reads the schedule status where the runner writes it',
  );
});

test('--check verifies and changes nothing', async () => {
  const { home } = await deployedHome();
  const next = commit(home, { 'b.txt': 'b\n' }, 'b');
  const { calls, deps, text } = machine(home);

  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps }), 0, text());
  assert.match(text(), new RegExp(`Ready: deploying would move the OS to ${next.slice(0, 8)}`, 'u'));
  assert.match(text(), /✓ .* is on main/u);
  assert.match(text(), /✓ the installation's database has all 1 of its Postgres migrations applied \(read-only check\)/u);
  assert.equal(existsSync(slotRoot(home, RUNTIME_SLOTS[1])), false);
  assert.deepEqual([calls.install, calls.restart], [[], []]);
});

// ─── The raw-signal archive a commit opens ──────────────────────────────────

/** An ingest config whose raw-signal bucket is `bucket`, as a commit carries it. */
const ingestWithBucket = (bucket) => JSON.stringify({
  hyperdrive: [{ binding: 'POSTGRES', id: 'fixture' }],
  r2_buckets: [{ binding: 'RAW_SIGNALS', bucket_name: bucket }],
});

/** Archives in the local store under the pre-rename bucket. */
function holdArchivesUnder(home, bucket) {
  const r2 = path.join(statePaths(home).persistState, 'v3', 'r2');
  mkdirSync(path.join(r2, 'miniflare-R2BucketObject'), { recursive: true });
  write(r2, `${bucket}/blobs/0001`, 'an archived raw signal');
}

test('a commit whose configs rename the bucket deploys onto an older store that names its own', async () => {
  const { home } = await deployedHome();
  holdArchivesUnder(home, 'reindex-os-raw-signals');
  write(home, 'installation/resource-names.json', '{ "database": "reindex-os-central", "rawSignalsBucket": "reindex-os-raw-signals" }\n');
  commit(home, { 'workers/ingest/wrangler.jsonc': ingestWithBucket('noticeos-raw-signals') }, 'new names');
  const { calls, deps, text } = machine(home);

  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps }), 0, text());
  assert.match(text(), /✓ the installation's database has all 1 of its Postgres migrations applied/u, 'the Postgres record is checked independently of R2 names');
  assert.match(text(), /✓ its raw-signal archive stays under reindex-os-raw-signals/u);
  assert.deepEqual([calls.install, calls.restart], [[], []]);
});

test('a commit that would open an empty bucket beside the archives is refused, naming the file that fixes it', async () => {
  const { home } = await deployedHome();
  holdArchivesUnder(home, 'reindex-os-raw-signals');
  commit(home, { 'workers/ingest/wrangler.jsonc': ingestWithBucket('noticeos-raw-signals') }, 'new names');
  const { calls, deps, text } = machine(home);

  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps }), 1, text());
  assert.match(text(), /would open the raw-signal archive "noticeos-raw-signals", but this installation's archives are under "reindex-os-raw-signals"\. Name the bucket in installation\/resource-names\.json/u);
  assert.deepEqual([calls.install, calls.restart], [[], []]);
});

test('a new installation with no archives yet deploys on the checked-in names', async () => {
  const { home } = await deployedHome();
  commit(home, { 'workers/ingest/wrangler.jsonc': ingestWithBucket('noticeos-raw-signals') }, 'new names');
  const { deps, text } = machine(home);

  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps }), 0, text());
  assert.doesNotMatch(text(), /raw-signal archive/u);
});

test('--check before the cut-over says the service switches with os:install, not with a restart', async () => {
  const { home, first } = makeHome();
  const { calls, deps, text } = machine(home, { readPlist: async () => plistFor(home, 'checkout') });

  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps }), 0, text());
  assert.match(text(), /no runtime copy is live yet/u);
  assert.match(
    text(),
    new RegExp(`Ready: deploying would prepare the runtime copy at ${first.slice(0, 8)} without touching the running service; pnpm os:install then switches`, 'u'),
  );
  assert.equal(existsSync(runtimeLayout(home).dir), false, 'nothing was created');
  assert.deepEqual([calls.install, calls.restart], [[], []]);
});

// ─── A restart that does not come back healthy ──────────────────────────────

/** What restartAndWait throws when health does not return: status + redacted log. */
const healthFailure = (action, marker) =>
  `${action} did not return NoticeOS to healthy within 90s\n` +
  '! NoticeOS UNHEALTHY — launchd says running, but Tower does not answer\n' +
  `--- recent redacted runner log ---\n[tower] ${marker}`;

/**
 * A machine whose restart fails its health wait `failures` times (each with its
 * own log line, `boom <n>`), then comes back the way os-up does.
 */
function failingMachine(home, failures, { onFailure = () => {}, ...overrides } = {}) {
  const m = machine(home, overrides);
  const healthy = m.deps.restart;
  m.calls.actions = [];
  let left = failures;
  m.deps.restart = async (options) => {
    m.calls.actions.push(options.action);
    if (left <= 0) return healthy(options);
    left -= 1;
    m.calls.restart.push(options.timeoutMs);
    onFailure();
    throw new Error(healthFailure(options.action, `boom ${m.calls.restart.length}`));
  };
  return m;
}

const s = (sha) => sha.slice(0, 8);
const recordsSince = (home, count) => records(home).slice(count).map(({ at, ...entry }) => (assert.ok(at), entry));

test('a deploy that does not come back healthy goes back to the previous copy by itself, with one more restart', async () => {
  const { home, first } = await deployedHome();
  const second = commit(home, { 'c.txt': 'c\n' }, 'c');
  const before = records(home).length;
  const { calls, deps, text } = failingMachine(home, 1);

  assert.equal(await runDeploy({ homeRoot: home, deps }), 1, 'the deploy asked for did not happen');
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0], 'current points at the previous copy again');
  assert.equal(git(runtimeLayout(home).current, 'rev-parse', 'HEAD'), first, 'the failed commit is not left current');
  assert.deepEqual(calls.restart, [DEPLOY_HEALTH_WAIT_MS, DEPLOY_HEALTH_WAIT_MS], 'the deploy restart and exactly one more');
  assert.deepEqual(calls.actions, ['deploy', 'rollback']);
  assert.deepEqual(calls.install, [slotRoot(home, RUNTIME_SLOTS[1])], 'the previous copy needed no install');
  assert.deepEqual(recordsSince(home, before), [
    { action: 'deploy', from: first, to: second, slot: RUNTIME_SLOTS[1], result: 'failed' },
    { action: 'rollback', automatic: true, from: second, to: first, slot: RUNTIME_SLOTS[0], result: 'healthy' },
  ]);

  // What failed (with its status and log), that it went back, and how that went.
  assert.ok(
    text().includes(
      `✗ ${s(second)} did not come back healthy:\n${healthFailure('deploy', 'boom 1')}\n… going back to ${s(first)} by itself: one more restart`,
    ),
    text(),
  );
  assert.deepEqual(text().split('\n').slice(-2), [
    `Deploy of ${s(second)} failed, so the OS went back to ${s(first)} (${RUNTIME_SLOTS[0]}) by itself.`,
    `✓ ${s(first)} is healthy again. ${s(second)} is not live; why it failed is in the log above.`,
  ]);

  // os:status, unchanged: the commit that runs, and main ahead of it.
  const code = await inspectCode({ homeRoot: home, heartbeat: { codeRoot: slotRoot(home, RUNTIME_SLOTS[0]), commit: first } });
  assert.equal(codeLine(code), `  code        ${s(first)} · main is 1 commit ahead — pnpm os:deploy`);
});

test('when going back fails too, the deploy stops there — no loop — and names the next command', async () => {
  const { home, first } = await deployedHome();
  const second = commit(home, { 'c.txt': 'c\n' }, 'c');
  const before = records(home).length;
  const { calls, deps, text } = failingMachine(home, Infinity);

  await assert.rejects(runDeploy({ homeRoot: home, deps }), (error) => {
    assert.ok(error.message.startsWith(healthFailure('rollback', 'boom 2')), 'the rollback failure reads as os:restart prints it');
    assert.deepEqual(error.message.split('\n').slice(-2), [
      `Deploy of ${s(second)} failed, and going back to ${s(first)} did not come back healthy either. Nothing more was tried.`,
      NEXT_STEP,
    ]);
    return true;
  });
  assert.match(text(), /\[tower\] boom 1/u, "the deploy's own failure was printed before going back");
  assert.deepEqual(calls.restart, [DEPLOY_HEALTH_WAIT_MS, DEPLOY_HEALTH_WAIT_MS], 'two restarts, never a third');
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0], 'the failed commit is not left current');
  assert.deepEqual(recordsSince(home, before), [
    { action: 'deploy', from: first, to: second, slot: RUNTIME_SLOTS[1], result: 'failed' },
    { action: 'rollback', automatic: true, from: second, to: first, slot: RUNTIME_SLOTS[0], result: 'failed' },
  ]);
});

test('a refused automatic rollback stops without a second restart', async () => {
  const { home, first } = await deployedHome();
  const second = commit(home, { 'c.txt': 'c\n' }, 'c');
  // While the new copy fails, somebody edits the previous one by hand.
  const previous = slotRoot(home, RUNTIME_SLOTS[0]);
  const { calls, deps } = failingMachine(home, Infinity, {
    onFailure: () => writeFileSync(path.join(previous, 'scripts', 'os-up.mjs'), '// hot-fixed in production\n'),
  });

  await assert.rejects(runDeploy({ homeRoot: home, deps }), (error) => {
    assert.match(error.message, /The automatic rollback was refused:\n {2}✗ the idle runtime copy .* has local changes/u);
    assert.deepEqual(error.message.split('\n').slice(-2), [
      `Deploy of ${s(second)} failed, and going back to ${s(first)} did not finish. Nothing more was tried.`,
      NEXT_STEP,
    ]);
    return true;
  });
  assert.deepEqual(calls.restart, [DEPLOY_HEALTH_WAIT_MS]);
  assert.equal(records(home).at(-1).result, 'failed');
});

test('a failed --rollback never goes forward again by itself', async () => {
  const { home, first } = await deployedHome();
  const second = commit(home, { 'c.txt': 'c\n' }, 'c');
  assert.equal(await runDeploy({ homeRoot: home, deps: machine(home).deps }), 0);
  const before = records(home).length;
  const { calls, deps, text } = failingMachine(home, Infinity);

  await assert.rejects(runDeploy({ homeRoot: home, argv: ['--rollback'], deps }), (error) => {
    assert.ok(error.message.startsWith(healthFailure('rollback', 'boom 1')));
    assert.deepEqual(error.message.split('\n').slice(-2), [
      `Going back to ${s(first)} did not come back healthy. Nothing more was tried.`,
      NEXT_STEP,
    ]);
    return true;
  });
  assert.deepEqual(calls.restart, [DEPLOY_HEALTH_WAIT_MS], 'one restart only');
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0], 'current stays where the rollback put it');
  assert.doesNotMatch(text(), /by itself/u);
  assert.deepEqual(recordsSince(home, before), [
    { action: 'rollback', from: second, to: first, slot: RUNTIME_SLOTS[0], result: 'failed' },
  ]);
});

test('a first deploy that does not come back healthy has no previous copy to go back to, and says so', async () => {
  // The service already runs the runtime copy's path, but no copy was ever made.
  const { home, first } = makeHome();
  const { calls, deps } = failingMachine(home, Infinity);

  await assert.rejects(runDeploy({ homeRoot: home, deps }), (error) => {
    assert.ok(error.message.startsWith(healthFailure('deploy', 'boom 1')), 'the status and log, as os:restart prints them');
    assert.deepEqual(error.message.split('\n').slice(-2), [
      'There is no previous runtime copy to go back to, so the service was left as this restart left it.',
      NEXT_STEP,
    ]);
    return true;
  });
  assert.deepEqual(calls.restart, [DEPLOY_HEALTH_WAIT_MS], 'nothing else was tried');
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);
  assert.deepEqual(recordsSince(home, 0), [{ action: 'deploy', from: null, to: first, slot: RUNTIME_SLOTS[0], result: 'failed' }]);
});

test('a restarted runner reporting another commit is not a deploy', async () => {
  const { home } = await deployedHome();
  commit(home, { 'd.txt': 'd\n' }, 'd');
  const { deps, text } = machine(home, {
    restart: async () => ({ state: 'healthy', heartbeat: { pid: 3, commit: 'f'.repeat(40) } }),
  });
  assert.equal(await runDeploy({ homeRoot: home, deps }), 1, text());
  assert.match(text(), /reports ffffffff instead of/u);
});

test('with the service stopped, a deploy moves the link but starts nothing', async () => {
  const { home } = await deployedHome();
  commit(home, { 'e.txt': 'e\n' }, 'e');
  const { calls, deps, text } = machine(home, { service: async () => ({ loaded: false, state: null }) });
  assert.equal(await runDeploy({ homeRoot: home, deps }), 0, text());
  assert.equal(liveSlot(home), RUNTIME_SLOTS[1]);
  assert.deepEqual(calls.restart, []);
  assert.match(text(), /pnpm os:start runs this commit/u);
});

test('a real directory where a link belongs stops the deploy before anything live moves', async () => {
  const { home } = await deployedHome();
  commit(home, { 'f.txt': 'f\n' }, 'f');
  // The idle copy exists from an earlier deploy and somebody ran a second store in it.
  const idle = slotRoot(home, RUNTIME_SLOTS[1]);
  git(home, 'worktree', 'add', '-q', '--detach', idle, 'HEAD~1');
  mkdirSync(path.join(idle, '.wrangler', 'state'), { recursive: true });
  const { calls, deps, text } = machine(home);

  assert.equal(await runDeploy({ homeRoot: home, deps }), 1, text());
  assert.match(text(), /the live OS was not changed/u);
  assert.match(text(), /\.wrangler is a real directory, not a link to/u);
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);
  assert.deepEqual([calls.install, calls.restart], [[], []]);
  assert.equal(existsSync(path.join(idle, '.wrangler', 'state')), true, 'nothing was deleted');
});

test('a failed install leaves the live OS where it was', async () => {
  const { home } = await deployedHome();
  commit(home, { 'g.txt': 'g\n' }, 'g');
  const { calls, deps, text } = machine(home, {
    install: async () => ({ code: 1, stdout: '', stderr: 'ERR_PNPM_OUTDATED_LOCKFILE' }),
  });
  assert.equal(await runDeploy({ homeRoot: home, deps }), 1, text());
  assert.match(text(), /the live OS was not changed: pnpm install --frozen-lockfile failed/u);
  assert.match(text(), /ERR_PNPM_OUTDATED_LOCKFILE/u);
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);
  assert.deepEqual(calls.restart, []);
});

// ─── A commit that opens the Postgres store ─────────────────────────────────

const onPostgres = () => ({ 'workers/ingest/wrangler.jsonc': wrangler(), 'apps/tower/wrangler.jsonc': wrangler() });

/** A baseline with text beyond ASCII, as the real one has: its hash is of its UTF-8 bytes. */
const BASELINE = 'CREATE SCHEMA noticeos;\n-- one store per installation — its first migration ✓\n';
const MORE = 'CREATE TABLE noticeos.more (id bigint);\n';
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const recordOf = (version, name, text) => ({ version, name, sha256: sha(text) });

/** A fake of the runner's reader: answers `records` (or a failure), counting each read. */
function postgresRecord(records) {
  const read = async () => {
    read.calls += 1;
    return Array.isArray(records) ? { ok: true, records } : records;
  };
  read.calls = 0;
  return read;
}

/** A home whose live OS runs a commit on the Postgres store, its database having applied that commit's baseline. */
async function deployedPostgresHome() {
  const fixture = makeHome();
  const onStore = commit(fixture.home, { ...onPostgres(), 'db/postgres/migrations/0001_init.sql': BASELINE }, 'postgres');
  const baseline = recordOf(1, '0001_init', BASELINE);
  const first = machine(fixture.home, { readPostgresMigrations: postgresRecord([baseline]) });
  assert.equal(await runDeploy({ homeRoot: fixture.home, deps: first.deps }), 0, first.text());
  assert.match(first.text(), /✓ the installation's database has all 1 of its Postgres migrations applied \(read-only check\)/u);
  return { ...fixture, onStore, baseline };
}

/** Each step of `sequence` appears in `text` after `anchor`, in order. */
function assertSequence(text, sequence, anchor = '') {
  let at = text.indexOf(anchor);
  assert.ok(at >= 0, `${anchor} is missing in:\n${text}`);
  for (const step of sequence) {
    const index = text.indexOf(step, at + 1);
    assert.ok(index > at, `${step} is missing or out of order in:\n${text}`);
    at = index;
  }
}

test("on the Postgres store, a commit carrying a migration the database has not applied is refused with the operator's pnpm postgres:migrate sequence", async () => {
  const { home, baseline } = await deployedPostgresHome();
  const withMigration = commit(home, { 'db/postgres/migrations/0002_more.sql': MORE }, 'migration');
  const record = postgresRecord([baseline]);
  const { calls, deps, text } = machine(home, { readPostgresMigrations: record });

  assert.equal(await runDeploy({ homeRoot: home, deps }), 1, text());
  assert.match(text(), new RegExp(`${s(withMigration)} carries 1 Postgres migration the installation's database has not applied: 0002_more\\.`, 'u'));
  assert.match(text(), /operator-only \(db\/postgres\/README\.md, "Applying it to an installation's own database"\)/u);
  assertSequence(text(), POSTGRES_MIGRATION_SEQUENCE);
  assert.deepEqual(POSTGRES_MIGRATION_SEQUENCE, [
    'pnpm os:stop',
    'pnpm postgres:migrate apply --database <name> [<connection>] --confirm <name>',
    'pnpm os:start',
  ]);
  assert.equal(record.calls, 1, 'the record is read once');
  assert.deepEqual([calls.install, calls.restart], [[], []], 'a deploy never applies a migration');
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);

  // Once the operator has applied it, the same commit deploys.
  const applied = machine(home, { readPostgresMigrations: postgresRecord([baseline, recordOf(2, '0002_more', MORE)]) });
  assert.equal(await runDeploy({ homeRoot: home, deps: applied.deps }), 0, applied.text());
  assert.match(applied.text(), /✓ the installation's database has all 2 of its Postgres migrations applied/u);
  assert.equal(liveSlot(home), RUNTIME_SLOTS[1]);
});

test('on the Postgres store, a commit whose recorded migration file changed is refused, and applying is not offered', async () => {
  const { home, baseline } = await deployedPostgresHome();
  const edited = commit(home, { 'db/postgres/migrations/0001_init.sql': `${BASELINE}-- edited after it was applied\n` }, 'edit');
  const { calls, deps, text } = machine(home, { readPostgresMigrations: postgresRecord([baseline]) });

  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps }), 1, text());
  assert.match(text(), new RegExp(`${s(edited)}'s 0001_init differs from what the installation's database applied under the same number \\(another name or SHA-256\\)`, 'u'));
  assert.match(text(), /the change as the next migration \(db\/postgres\/README\.md, "Changing the schema"\)/u);
  assert.doesNotMatch(text(), /pnpm postgres:migrate apply --database/u, 'applying would not help, so it is not offered');
  assert.deepEqual([calls.install, calls.restart], [[], []]);

  // A migration older than one the database has is refused too, and is no apply's either.
  const home2 = (await deployedPostgresHome()).home;
  commit(home2, { 'db/postgres/migrations/0002_more.sql': MORE, 'db/postgres/migrations/0003_last.sql': MORE }, 'two');
  const skipped = machine(home2, { readPostgresMigrations: postgresRecord([recordOf(1, '0001_init', BASELINE), recordOf(3, '0003_last', MORE)]) });
  assert.equal(await runDeploy({ homeRoot: home2, argv: ['--check'], deps: skipped.deps }), 1, skipped.text());
  assert.match(skipped.text(), /carries 0002_more, older than a migration the installation's database has already applied/u);
  assert.doesNotMatch(skipped.text(), /pnpm postgres:migrate apply --database/u);
});

test('a migration the database has and the commit does not carry is named and allowed: a rollback past a migration, typed or automatic, is never blocked', async () => {
  const { home, onStore, baseline } = await deployedPostgresHome();
  const withMigration = commit(home, { 'db/postgres/migrations/0002_more.sql': MORE }, 'migration');
  // The operator applied 0002 (pnpm os:stop → pnpm postgres:migrate apply → pnpm os:start), so the database is ahead of the running commit.
  const both = [baseline, recordOf(2, '0002_more', MORE)];

  // The deploy of the commit that carries it fails its health wait, and goes back by itself.
  const failing = failingMachine(home, 1, { readPostgresMigrations: postgresRecord(both) });
  assert.equal(await runDeploy({ homeRoot: home, deps: failing.deps }), 1, failing.text());
  assert.deepEqual(failing.calls.actions, ['deploy', 'rollback'], 'the automatic rollback was not refused');
  assert.equal(git(runtimeLayout(home).current, 'rev-parse', 'HEAD'), onStore);

  // The commit that carries it still checks out: the database has it.
  const now = machine(home, { readPostgresMigrations: postgresRecord(both) });
  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps: now.deps }), 0, now.text());
  assert.match(now.text(), new RegExp(`Ready: deploying would move the OS to ${s(withMigration)}`, 'u'));

  // Deployed, then rolled back by hand: allowed, and the newer migration named.
  assert.equal(await runDeploy({ homeRoot: home, deps: machine(home, { readPostgresMigrations: postgresRecord(both) }).deps }), 0);
  const back = machine(home, { readPostgresMigrations: postgresRecord(both) });
  assert.equal(await runDeploy({ homeRoot: home, argv: ['--rollback'], deps: back.deps }), 0, back.text());
  assert.match(back.text(), /✓ the installation's database has all 1 of its Postgres migrations applied \(read-only check\)/u);
  assert.match(
    back.text(),
    new RegExp(
      `✓ the installation's database also has 0002_more, which ${s(onStore)} does not carry \\(a rollback past a migration\\); ` +
        'allowed: a migration keeps the code before it working \\(db/postgres/README\\.md, "Changing the schema"\\)',
      'u',
    ),
  );
  assert.equal(git(runtimeLayout(home).current, 'rev-parse', 'HEAD'), onStore);
});

test("a record that cannot be read stops the deploy in its reader's own sentence", async () => {
  const { home } = await deployedPostgresHome();
  commit(home, { 'x.txt': 'x\n' }, 'x');
  const line = 'the database DATABASE_URL in home/workers/ingest/.dev.secrets.json names does not answer; start it (db/postgres/host/README.md), then try again.';
  const { calls, deps, text } = machine(home, { readPostgresMigrations: postgresRecord({ ok: false, line }) });

  assert.equal(await runDeploy({ homeRoot: home, deps }), 1, text());
  assert.ok(text().includes(`opens the Postgres store, but which migrations its database has applied is unknown: ${line}`), text());
  assert.deepEqual([calls.install, calls.restart], [[], []]);
  assert.equal(liveSlot(home), RUNTIME_SLOTS[0]);
});

// ─── On a throwaway Postgres, read the way the runner reads it ──────────────

const POSTGRES_MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'postgres', 'migrations');

async function throwawayCluster(t) {
  try {
    const started = await startTestCluster();
    t.after(() => started.close());
    return started;
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason === null || postgresRequired()) throw error;
    t.skip(`no Postgres here: ${reason}`);
    return null;
  }
}

test('on a throwaway Postgres with the baseline applied and recorded: one more migration is refused, a changed file is refused, one the commit lacks is allowed, and the record is only read', { timeout: 180_000 }, async (t) => {
  const pg = await throwawayCluster(t);
  if (!pg) return;
  // A copy of the run's template: every real migration applied and recorded
  // by the runner with its SHA-256, and the installation's one workspace.
  const database = await pg.createDatabase();
  const { home } = makeHome();

  // The home's secrets file holds the copy's application address, made at run
  // time; the deploy reads it only through the runner's own reader.
  const secretFiles = { secretsFile: statePaths(home).devSecrets, varsFile: statePaths(home).devVars };
  chmodSync(secretFiles.secretsFile, 0o600);
  writeFileSync(secretFiles.secretsFile, `${JSON.stringify({ DATABASE_URL: pg.url(database) })}\n`, { mode: 0o600 });
  const readPostgresMigrations = () => runnerRecordedMigrations({ secretFiles });

  // The real migrations, byte for byte, in a commit on the Postgres store alone.
  const names = readdirSync(POSTGRES_MIGRATIONS_DIR).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  const real = Object.fromEntries(names.map((name) => [`db/postgres/migrations/${name}`, readFileSync(path.join(POSTGRES_MIGRATIONS_DIR, name), 'utf8')]));
  rmSync(path.join(home, 'db', 'postgres', 'migrations', '0001_init.sql'));
  const onStore = commit(home, { ...onPostgres(), ...real }, 'postgres');
  const recordedBefore = await readPostgresMigrations();
  assert.equal(recordedBefore.ok, true, recordedBefore.line);
  assert.equal(recordedBefore.records.length, names.length);

  const first = machine(home, { readPostgresMigrations });
  assert.equal(await runDeploy({ homeRoot: home, deps: first.deps }), 0, first.text());
  assert.match(first.text(), new RegExp(`✓ the installation's database has all ${names.length} of its Postgres migrations applied \\(read-only check\\)`, 'u'));

  // One more migration than the database has.
  const next = `${String(names.length + 1).padStart(4, '0')}_later`;
  const pending = commit(home, { [`db/postgres/migrations/${next}.sql`]: 'CREATE TABLE noticeos.later (id bigint);\n' }, 'later');
  const refusedPending = machine(home, { readPostgresMigrations });
  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps: refusedPending.deps }), 1, refusedPending.text());
  assert.match(refusedPending.text(), new RegExp(`${s(pending)} carries 1 Postgres migration the installation's database has not applied: ${next}\\.`, 'u'));
  assertSequence(refusedPending.text(), POSTGRES_MIGRATION_SEQUENCE);
  git(home, 'revert', '--no-edit', 'HEAD');

  // The baseline edited after the database applied it.
  const baselineFile = `db/postgres/migrations/${names[0]}`;
  const edited = commit(home, { [baselineFile]: `${real[baselineFile]}\n-- edited after it was applied\n` }, 'edit');
  const refusedChanged = machine(home, { readPostgresMigrations });
  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps: refusedChanged.deps }), 1, refusedChanged.text());
  assert.match(refusedChanged.text(), new RegExp(`${s(edited)}'s ${names[0].replace(/\.sql$/u, '')} differs from what the installation's database applied`, 'u'));
  git(home, 'revert', '--no-edit', 'HEAD');

  // The database records one more than the commit carries, as after a rollback past a migration.
  await pg.asOwner(database, `INSERT INTO noticeos_migrations.applied (version, name, sha256) VALUES (${names.length + 1}, '${next}', '${'0'.repeat(64)}');`);
  const ahead = machine(home, { readPostgresMigrations });
  assert.equal(await runDeploy({ homeRoot: home, argv: ['--check'], deps: ahead.deps }), 0, ahead.text());
  assert.match(ahead.text(), new RegExp(`✓ the installation's database also has ${next}, which [0-9a-f]{8} does not carry \\(a rollback past a migration\\); allowed`, 'u'));
  assert.equal(git(runtimeLayout(home).current, 'rev-parse', 'HEAD'), onStore, 'every check changed nothing live');

  // Only read: the record holds what the runner and the owner wrote, and no
  // output repeats the address or its password.
  const recordedAfter = await readPostgresMigrations();
  assert.deepEqual(recordedAfter.records, [...recordedBefore.records, { version: names.length + 1, name: next, sha256: '0'.repeat(64) }]);
  const address = new URL(pg.url(database));
  for (const m of [first, refusedPending, refusedChanged, ahead]) {
    assert.equal(m.text().includes(address.password), false, 'the password was printed');
    assert.equal(m.text().includes(pg.url(database)), false, 'the address was printed');
  }
});

test('deploy arguments: one commit at most, known flags only', () => {
  assert.deepEqual(parseDeployArgs([]), { check: false, rollback: false, target: 'main' });
  assert.deepEqual(parseDeployArgs(['--', 'abc123']), { check: false, rollback: false, target: 'abc123' });
  assert.deepEqual(parseDeployArgs(['--rollback', '--check']), { check: true, rollback: true, target: 'main' });
  assert.throws(() => parseDeployArgs(['--force']), /does not know --force/u);
  assert.throws(() => parseDeployArgs(['a', 'b']), /at most one commit/u);
  assert.throws(() => parseDeployArgs(['--rollback', 'abc']), /takes no commit/u);
});

test('deploy refuses D1-only, mixed, missing and malformed Worker configs before any store read', async () => {
  const postgres = { hyperdrive: [{ binding: 'POSTGRES', id: 'fixture' }] };
  const d1 = { d1_databases: [{ binding: 'DB', database_id: 'fixture' }] };
  for (const config of [d1, { ...postgres, ...d1 }, {}, null, 'not json']) {
    for (const file of ['workers/ingest/wrangler.jsonc', 'apps/tower/wrangler.jsonc']) {
      const { home } = await deployedHome();
      const before = liveSlot(home);
      commit(home, { [file]: typeof config === 'string' ? config : JSON.stringify(config) }, 'unsupported backend');
      const read = async () => assert.fail('unsupported candidate contacted Postgres');
      const { calls, deps, text } = machine(home, { readPostgresMigrations: read });
      assert.equal(await runDeploy({ homeRoot: home, deps }), 1, text());
      assert.match(text(), /Postgres runtime/);
      assert.equal(liveSlot(home), before);
      assert.deepEqual([calls.install, calls.restart], [[], []]);
    }
  }
});

test('explicit and automatic rollback refuse an old D1 copy before database access or restart', async () => {
  for (const automatic of [false, true]) {
    const { home } = makeHome();
    const legacy = commit(home, {
      'workers/ingest/wrangler.jsonc': JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: 'legacy' }] }),
      'apps/tower/wrangler.jsonc': JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: 'legacy' }] }),
    }, 'old D1 release');
    // Establish a retained legacy slot without invoking any legacy runtime.
    const layout = runtimeLayout(home);
    mkdirSync(layout.dir, { recursive: true });
    git(home, 'worktree', 'add', '--detach', slotRoot(home, RUNTIME_SLOTS[0]), legacy);
    symlinkSync(RUNTIME_SLOTS[0], layout.current);
    const modern = commit(home, onPostgres(), 'Postgres release');
    const move = machine(home);
    assert.equal(await runDeploy({ homeRoot: home, deps: move.deps }), 0, move.text());
    assert.equal(git(layout.current, 'rev-parse', 'HEAD'), modern);
    const read = async () => assert.fail('D1 rollback contacted Postgres');
    if (!automatic) {
      const back = machine(home, { readPostgresMigrations: read });
      assert.equal(await runDeploy({ homeRoot: home, argv: ['--rollback'], deps: back.deps }), 1);
      assert.match(back.text(), /declares D1/);
      assert.deepEqual([back.calls.install, back.calls.restart], [[], []]);
    } else {
      // A failed forward deploy would otherwise try the previous D1 slot.
      // Start from that slot as the recorded predecessor, and let the one
      // Postgres forward restart fail; rollback must refuse before restart.
      rmSync(layout.current);
      symlinkSync(RUNTIME_SLOTS[0], layout.current);
      const failed = failingMachine(home, 1);
      await assert.rejects(runDeploy({ homeRoot: home, deps: failed.deps }), /automatic rollback was refused:[\s\S]*declares D1/);
      assert.deepEqual(failed.calls.actions, ['deploy']);
    }
    assert.equal(git(layout.current, 'rev-parse', 'HEAD'), modern);
  }
});
