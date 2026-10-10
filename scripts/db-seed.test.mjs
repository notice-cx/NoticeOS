import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { javascriptInstant, openStore } from '../packages/postgres/src/store.mjs';
import { FIXTURE_FILE, HISTORY_TABLES, readFixture, seedLocal } from './db-seed.mjs';
import { LOCAL_CONNECTION_VARIABLE } from './database-address.mjs';
import { ADDRESS_FILE, SECRETS_DIR_VARIABLE } from './postgres-secrets.mjs';
import { TEST_PORTS, parsePortRange, postgresRequired, startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';
import { FOLDER_MARK, MANAGED_PORTS, startPlan } from './start.mjs';

// `pnpm seed:local` on the Postgres build: the invented rows of
// db/fixtures/dev-seed.json go into the Postgres tables the Tower reads, of a
// throwaway installation `pnpm start` made, in one transaction as the
// application login; the store must be empty of them first and say it is for
// development; nothing reaches D1. The last test starts a real `pnpm start`,
// seeds it and reads the totals, one report and the money back through its
// Tower.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(REPO_ROOT, 'scripts', 'db-seed.mjs');
const FIXTURE = readFixture();

let cluster = null;
let unavailable = null;

before(async () => {
  try {
    cluster = await startTestCluster();
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason === null || postgresRequired()) throw error;
    unavailable = reason;
  }
});
after(() => cluster?.close());

const undoing = new WeakMap();

/** Undo `step` after test `t`: a test's steps run last first, and every one
 * runs even when another throws. node:test runs `t.after` hooks first
 * registered first and skips the rest after one throws, so a folder that
 * could not be removed while a started Tower still wrote into it skipped
 * stopping that Tower, whose open pipes then held the test process forever. */
function defer(t, step) {
  let steps = undoing.get(t);
  if (!steps) {
    steps = [];
    undoing.set(t, steps);
    t.after(async () => {
      const failures = [];
      for (const undo of steps.reverse()) {
        try {
          await undo();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    });
  }
  steps.push(step);
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  defer(t, () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A folder as `pnpm start` leaves one: its mark, and its secrets file holding
 * `bindings` (the address `pnpm start` would have taken). */
function startFolder(t, bindings) {
  const home = path.join(tempDir(t, 'seed-home-'), 'installation');
  const plan = startPlan({ root: REPO_ROOT, dir: home });
  mkdirSync(path.dirname(plan.secrets), { recursive: true });
  writeFileSync(plan.mark, 'One NoticeOS installation, made by `pnpm start`.\n');
  writeFileSync(plan.secrets, `${JSON.stringify(bindings)}\n`, { mode: 0o600 });
  return home;
}

/** A new copy of the run's store, marked for development as the cluster marks
 * every copy, given back after the test; `url` is its application login. */
async function copy(t) {
  const database = await cluster.createDatabase();
  defer(t, () => cluster.releaseDatabase(database));
  return { database, url: cluster.url(database) };
}

/** Everything the seed prints, while `work` runs. */
async function printed(t, work) {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  const code = await work();
  t.mock.restoreAll();
  return { code, lines };
}

/** One read of the copy at `url`, as the application login. */
async function read(url, sql, params = []) {
  const store = openStore(url, { maxConnections: 1 });
  try {
    const workspace = await store.onlyWorkspace();
    return await store.inWorkspace(workspace, (tx) => tx.query(sql, params), { readOnly: true });
  } finally {
    await store.close();
  }
}

/** One write to the copy at `url`, as the application login. */
async function write(url, statements) {
  const store = openStore(url, { maxConnections: 1 });
  try {
    const workspace = await store.onlyWorkspace();
    await store.inWorkspace(workspace, async (tx) => {
      for (const [sql, params] of statements) await tx.execute(sql, params.map((p) => (p === '$ws' ? tx.workspaceId : p)));
    });
  } finally {
    await store.close();
  }
}

/** How many rows each table the seed fills holds, sites included. */
async function counts(url) {
  const [row] = await read(url, `SELECT ${['assets', ...HISTORY_TABLES].map((table) => `(SELECT count(*) FROM noticeos.${table})::int AS ${table}`).join(', ')}`);
  return row;
}

const EMPTY = Object.fromEntries(['assets', ...HISTORY_TABLES].map((table) => [table, 0]));
const SEEDED = Object.fromEntries(['assets', ...HISTORY_TABLES].map((table) => [table, FIXTURE[table].length]));

// ─── Refusals that need no database ─────────────────────────────────────────

test('a folder pnpm start did not make is refused, naming the command that makes one', async (t) => {
  const home = tempDir(t, 'seed-not-start-');
  const { code, lines } = await printed(t, () => seedLocal({ dir: home }));
  assert.equal(code, 1);
  assert.deepEqual(lines, [`[seed] refusing to seed: ${home} is not an installation pnpm start made; make one first: pnpm start -- --dir ${home}`]);
});

test('the checkout itself is refused: the managed service’s installation is never seeded', async (t) => {
  const { code, lines } = await printed(t, () => seedLocal({ dir: REPO_ROOT }));
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /holds this checkout/u);
});

test('a folder whose secrets file names no database is refused in one sentence', async (t) => {
  const home = startFolder(t, { CREDENTIALS_KEY: 'k', OPERATOR_TOKEN: 't' });
  const { code, lines } = await printed(t, () => seedLocal({ dir: home }));
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[seed\] refusing to seed: DATABASE_URL is not set in .*workers\/ingest\/\.dev\.secrets\.json/u);
});

test('the fixture names only tables and columns the seed writes, and only invented sites', () => {
  assert.deepEqual(Object.keys(FIXTURE).filter((key) => key !== 'about').sort(), ['assets', ...HISTORY_TABLES].sort());
  for (const site of FIXTURE.assets) assert.match(site.asset_id, /\.example$/u);
  const bad = path.join(os.tmpdir(), `dev-seed-bad-${process.pid}.json`);
  writeFileSync(bad, JSON.stringify({ ...FIXTURE, annotations: [{ ...FIXTURE.annotations[0], annotation_number: 7 }] }));
  try {
    assert.throws(() => readFixture(bad), /annotations row 1 names annotation_number, which the seed does not write/u);
  } finally {
    rmSync(bad, { force: true });
  }
});

test('no statement reaches D1: the seed names no wrangler, no local store and no D1 binding', () => {
  const code = readFileSync(SEED, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
    .join('\n');
  assert.doesNotMatch(code, /wrangler|--persist-to|\.wrangler|d1 execute|env\.DB\b|run-command|ingest-door/u);
});

// ─── On a throwaway cluster ─────────────────────────────────────────────────

test('an empty store marked for development takes every invented row, in the Postgres model', async (t) => {
  if (unavailable) return t.skip(`no Postgres here: ${unavailable}`);
  const { url } = await copy(t);
  assert.deepEqual(await counts(url), EMPTY);
  const home = startFolder(t, { DATABASE_URL: url });
  const { code, lines } = await printed(t, () => seedLocal({ dir: home }));
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(lines, [`[seed] seeded the store of ${home}: 2 sites, 28 reports, 5 alerts, 9 ledger entries, 2 counter readings, 6 change notes.`]);
  assert.deepEqual(await counts(url), SEEDED);

  // Two invented sites, in the fixture's order: the store handed out their places.
  const sites = await read(url, 'SELECT asset_id, list_position::int AS place, is_os, sense_only, created_at FROM noticeos.assets ORDER BY list_position');
  assert.deepEqual(sites.map((s) => [s.asset_id, s.place, s.is_os, s.sense_only, javascriptInstant(s.created_at)]), [
    ['meadow.example', 1, false, false, '2026-07-05T00:00:00.000Z'],
    ['northwind.example', 2, false, false, '2026-07-05T00:00:00.000Z'],
  ]);

  // Reports: each night's number is the store's, in the fixture's order; the
  // report is the fixture's, byte for byte, and its instants are instants.
  const reports = await read(url, `SELECT asset_id, pulse_date, day_number::int AS n, generated_at, received_at, envelope::text AS envelope
                                      FROM noticeos.current_pulses ORDER BY day_number`);
  assert.deepEqual(reports.map((r) => [r.asset_id, r.pulse_date, r.n]), FIXTURE.pulses.map((p, i) => [p.asset_id, p.pulse_date, i + 1]));
  const lastNight = reports.find((r) => r.asset_id === 'meadow.example' && r.pulse_date === '2026-07-05');
  const fixtureNight = FIXTURE.pulses.find((p) => p.asset_id === 'meadow.example' && p.pulse_date === '2026-07-05');
  assert.equal(lastNight.envelope, JSON.stringify(fixtureNight.envelope));
  assert.equal(javascriptInstant(lastNight.received_at), '2026-07-05T02:06:00.000Z');

  // Alerts: each names its own report, by that night's number, and keeps its
  // triage; the acknowledged weekend dip is settled.
  const alerts = await read(url, `SELECT flag_number::int AS n, asset_id, pulse_day_number::int AS report, severity, kind, rule_id,
                                         rule_inputs::text AS inputs, disposition, resolved_at FROM noticeos.current_flags ORDER BY flag_number`);
  const dayNumber = (asset, day) => reports.find((r) => r.asset_id === asset && r.pulse_date === day).n;
  assert.deepEqual(alerts.map((a) => [a.n, a.asset_id, a.report, a.severity, a.kind, a.rule_id]),
    FIXTURE.flags.map((f, i) => [i + 1, f.asset_id, dayNumber(f.asset_id, f.pulse_date), f.severity, f.kind, f.rule_id]));
  assert.deepEqual(JSON.parse(alerts[0].inputs), FIXTURE.flags[0].rule_inputs);
  assert.deepEqual([alerts[4].disposition, javascriptInstant(alerts[4].resolved_at)], ['ack', '2026-06-29T03:04:00.000Z']);

  // The ledger: the reconciled May ads replace their estimate, the change the
  // build cost was spent on carries the prediction it shipped with and no
  // money, and the financial view counts money only.
  const entries = await read(url, `SELECT entry_number::int AS n, entry_id, kind, ref, amount_minor, booking_state, supersedes_id,
                                          predicted_monthly_value_minor AS value, predicted_success_chance AS chance,
                                          predicted_cost_minor AS cost, predicted_days_to_signal AS days
                                     FROM noticeos.ledger_entries ORDER BY entry_number`);
  assert.deepEqual(entries.map((e) => e.n), FIXTURE.ledger_entries.map((_, i) => i + 1));
  const correction = entries.find((e) => e.supersedes_id !== null);
  assert.equal(correction.supersedes_id, entries[0].entry_id);
  assert.equal(correction.amount_minor, 49810n);
  const change = entries.find((e) => e.kind === 'change');
  assert.deepEqual([change.ref, change.amount_minor, change.booking_state, change.value, change.chance, change.cost, change.days],
    ['chg-0421', null, null, 4000n, '0.35', 2500n, 28]);
  const [money] = await read(url, `SELECT sum(amount_minor) FILTER (WHERE kind = 'revenue')::text AS revenue,
                                          sum(amount_minor) FILTER (WHERE kind = 'cost')::text AS cost, count(*)::int AS n
                                     FROM noticeos.financial_ledger`);
  assert.deepEqual(money, { revenue: String(14375 + 16820 + 4200 + 5550 + 56000 + 49810), cost: '2210', n: 7 });

  // The fast lane's current readings, and the change notes by their numbers.
  const readings = await read(url, 'SELECT asset_id, metric, value, observed_at FROM noticeos.counter_readings ORDER BY metric COLLATE "C"');
  assert.deepEqual(readings.map((r) => [r.asset_id, r.metric, r.value, javascriptInstant(r.observed_at)]), [
    ['meadow.example', 'leads', 257n, '2026-07-05T09:15:00.000Z'],
    ['meadow.example', 'signups', 4239n, '2026-07-05T09:15:00.000Z'],
  ]);
  const notes = await read(url, 'SELECT annotation_number::int AS n, asset_id, kind, note FROM noticeos.annotations ORDER BY annotation_number');
  assert.deepEqual(notes.map((a) => [a.n, a.asset_id, a.kind, a.note]), FIXTURE.annotations.map((a, i) => [i + 1, a.asset_id, a.kind, a.note]));
});

test('a second run is refused, naming what the store holds, and writes nothing', async (t) => {
  if (unavailable) return t.skip(`no Postgres here: ${unavailable}`);
  const { url } = await copy(t);
  const home = startFolder(t, { DATABASE_URL: url });
  assert.equal((await printed(t, () => seedLocal({ dir: home }))).code, 0);
  const { code, lines } = await printed(t, () => seedLocal({ dir: home }));
  assert.equal(code, 1);
  assert.deepEqual(lines, [
    '[seed] refusing to seed: this store already holds data.',
    ...HISTORY_TABLES.map((table) => `[seed]   noticeos.${table}: ${FIXTURE[table].length} row(s)`),
    '[seed]   noticeos.assets: the site meadow.example, on an id or domain the fixture uses',
    '[seed]   noticeos.assets: the site northwind.example, on an id or domain the fixture uses',
    '[seed] These rows are invented; once mixed in with real ones, nothing in the store can tell them apart.',
    '[seed] Seed only a new installation: pnpm start -- --dir <an empty folder>, on a new database marked for development.',
    '[seed] Nothing was written.',
  ]);
  assert.deepEqual(await counts(url), SEEDED);
});

// One row of another site in one table the fixture fills: each is enough.
const ONE_ROW = {
  pulses: ["INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, envelope) VALUES ($1::uuid, 'other.example', '2026-07-01', '{}')", ['$ws']],
  flags: ["INSERT INTO noticeos.flags (workspace_id, asset_id, fired_at, severity, kind, rule_id) VALUES ($1::uuid, 'other.example', now(), 'warn', 'anomaly', 'egress-down')", ['$ws']],
  ledger_entries: ["INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state) VALUES ($1::uuid, 'revenue', 'other.example', '2026-07-01', 'ads', 100, 'USD', 'estimated')", ['$ws']],
  counter_readings: ["INSERT INTO noticeos.counter_readings (workspace_id, asset_id, metric, value, observed_at) VALUES ($1::uuid, 'other.example', 'signups', 1, now())", ['$ws']],
  annotations: ["INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind) VALUES ($1::uuid, 'other.example', now(), 'deploy')", ['$ws']],
};

test('the empty-store refusal counts each Postgres table the fixture fills', async (t) => {
  if (unavailable) return t.skip(`no Postgres here: ${unavailable}`);
  assert.deepEqual(Object.keys(ONE_ROW), [...HISTORY_TABLES]);
  for (const table of HISTORY_TABLES) {
    const { url } = await copy(t);
    await write(url, [
      ["INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status) VALUES ($1::uuid, 'other.example', 'other.example', 'Other', 'live')", ['$ws']],
      ONE_ROW[table],
    ]);
    const home = startFolder(t, { DATABASE_URL: url });
    const { code, lines } = await printed(t, () => seedLocal({ dir: home }));
    assert.equal(code, 1, table);
    assert.deepEqual(lines.slice(0, 2), ['[seed] refusing to seed: this store already holds data.', `[seed]   noticeos.${table}: 1 row(s)`], table);
    assert.equal(lines.at(-1), '[seed] Nothing was written.', table);
    assert.deepEqual(await counts(url), { ...EMPTY, assets: 1, [table]: 1 }, `${table}: nothing was written`);
  }
});

test('a store that already holds a site on one of the fixture’s ids or domains is refused', async (t) => {
  if (unavailable) return t.skip(`no Postgres here: ${unavailable}`);
  const { url } = await copy(t);
  await write(url, [["INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status) VALUES ($1::uuid, 'my-meadow', 'meadow.example', 'Mine', 'live')", ['$ws']]]);
  const home = startFolder(t, { DATABASE_URL: url });
  const { code, lines } = await printed(t, () => seedLocal({ dir: home }));
  assert.equal(code, 1);
  assert.deepEqual(lines.slice(0, 2), ['[seed] refusing to seed: this store already holds data.', '[seed]   noticeos.assets: the site my-meadow, on an id or domain the fixture uses']);
  assert.deepEqual(await counts(url), { ...EMPTY, assets: 1 });
});

test('a database that does not say it is for development is refused: invented rows never go into an installation’s own', async (t) => {
  if (unavailable) return t.skip(`no Postgres here: ${unavailable}`);
  const { database, url } = await copy(t);
  await cluster.asOwner(database, `ALTER DATABASE ${database} RESET noticeos.profile;`);
  const home = startFolder(t, { DATABASE_URL: url });
  let code;
  let lines;
  try {
    ({ code, lines } = await printed(t, () => seedLocal({ dir: home })));
  } finally {
    // A copy is handed out again once given back: it goes back marked.
    await cluster.asOwner(database, `ALTER DATABASE ${database} SET noticeos.profile = 'development';`);
  }
  assert.equal(code, 1);
  assert.match(lines[0], /^\[seed\] refusing to seed: the database DATABASE_URL in .* names does not say it is for development/u);
  assert.equal(lines.at(-1), '[seed] Nothing was written.');
  assert.equal(lines.some((line) => line.includes(url) || line.includes(new URL(url).password)), false, 'no line repeats the address');
  assert.deepEqual(await counts(url), EMPTY);
});

test('one populated store or nothing: a row the store refuses rolls every other row back', async (t) => {
  if (unavailable) return t.skip(`no Postgres here: ${unavailable}`);
  const { url } = await copy(t);
  const home = startFolder(t, { DATABASE_URL: url });
  // The last note is of a kind the store refuses: everything before it is undone.
  const broken = { ...FIXTURE, annotations: [...FIXTURE.annotations, { ...FIXTURE.annotations[0], kind: 'rumour' }] };
  const { code, lines } = await printed(t, () => seedLocal({ dir: home, fixture: broken }));
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /^\[seed\] the seed failed, and the store kept none of it: .*annotations_kind_check.* \(23514\)$/mu);
  assert.deepEqual(await counts(url), EMPTY);
});

test('two seeds at once seed once: the second finds the first’s rows and is refused', async (t) => {
  if (unavailable) return t.skip(`no Postgres here: ${unavailable}`);
  const { url } = await copy(t);
  const home = startFolder(t, { DATABASE_URL: url });
  const { lines } = await printed(t, async () => {
    const codes = await Promise.all([seedLocal({ dir: home }), seedLocal({ dir: home })]);
    assert.deepEqual(codes.sort(), [0, 1]);
    return 0;
  });
  assert.equal(lines.filter((line) => line.startsWith('[seed] seeded the store')).length, 1);
  assert.equal(lines.filter((line) => line === '[seed] refusing to seed: this store already holds data.').length, 1);
  assert.deepEqual(await counts(url), SEEDED);
});

test('the command spawns nothing: with only failing stand-ins for pnpm, wrangler and npx on PATH it seeds, and makes no local store', async (t) => {
  if (unavailable) return t.skip(`no Postgres here: ${unavailable}`);
  const { url } = await copy(t);
  const home = startFolder(t, { DATABASE_URL: url });
  const bin = tempDir(t, 'seed-bin-');
  const called = path.join(bin, 'called');
  for (const name of ['pnpm', 'wrangler', 'npx']) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> ${JSON.stringify(called)}\nexit 1\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  const run = spawnSync(process.execPath, [SEED, '--dir', home], { cwd: REPO_ROOT, env: { PATH: bin, HOME: os.homedir() }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^\[seed\] seeded the store of /mu);
  assert.equal(existsSync(called), false, 'no stand-in ran');
  assert.equal(existsSync(path.join(home, '.wrangler')), false, 'no local store was made or opened');
  assert.deepEqual(await counts(url), SEEDED);
});

// ─── Through a real Tower ───────────────────────────────────────────────────

/** A server holding `port` on loopback, or null when something else has it. */
function hold(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** Two free neighbouring ports, the Tower's and its door's: from the top of
 * the port block a machine gives this run (NOTICEOS_TEST_POSTGRES_PORTS),
 * else from the range scripts/start.test.mjs uses. */
async function freePair() {
  const block = parsePortRange(process.env[TEST_PORTS]);
  const candidates = block
    ? Array.from({ length: block[1] - block[0] }, (_, i) => block[1] - 1 - i)
    : Array.from({ length: 50 }, () => 20_000 + Math.floor(Math.random() * 12_000));
  for (const port of candidates) {
    if (MANAGED_PORTS.includes(port) || MANAGED_PORTS.includes(port + 1)) continue;
    const held = await Promise.all([hold(port), hold(port + 1)]);
    await Promise.all(held.filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
    if (held.every(Boolean)) return port;
  }
  throw new Error('no free pair of ports for the Tower');
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  return { status: response.status, body: await response.json() };
}

test('after the seed, a real Tower shows the invented rows: the sites and their alerts, a report, the money', { timeout: 600_000 }, async (t) => {
  if (unavailable) return t.skip(`no Postgres here: ${unavailable}`);
  const { url } = await copy(t);
  const base = tempDir(t, 'seed-tower-');
  const home = path.join(base, 'installation');
  // The Compose profile's secrets folder, a throwaway beside the folder: the
  // start takes its address from here, never from the checkout's.
  const compose = path.join(base, 'compose-secrets');
  mkdirSync(compose, { mode: 0o700 });
  writeFileSync(path.join(compose, ADDRESS_FILE), `${url}\n`, { mode: 0o600 });
  const env = { ...process.env, [SECRETS_DIR_VARIABLE]: compose, CI: '1', WRANGLER_LOG_PATH: path.join(base, 'wrangler-logs') };
  delete env[LOCAL_CONNECTION_VARIABLE];
  const port = await freePair();
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'start.mjs'), '--dir', home, '--port', String(port), '--no-open'], {
    cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  // Undone first (the last step deferred): the start stops before its copy is
  // given back and before its folder, which its schedule writes into, goes.
  defer(t, async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const within = (ms) => Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(resolve, ms, false).unref())]);
    try {
      // On SIGTERM pnpm start stops its Tower's own process group, then exits.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      return; // gone
    }
    if (await within(30_000)) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // gone
    }
    await within(10_000);
    throw new Error(`pnpm start (pid ${child.pid}) did not stop on SIGTERM within 30 s; its Tower's processes may still run`);
  });
  const running = await Promise.race([
    new Promise((resolve) => {
      const timer = setInterval(() => {
        if (output.includes('NoticeOS is running')) (clearInterval(timer), resolve(true));
      }, 250);
      exited.then(() => (clearInterval(timer), resolve(false)));
    }),
    new Promise((resolve) => setTimeout(resolve, 420_000, false).unref()),
  ]);
  assert.ok(running, `pnpm start did not come up:\n${output}`);

  // The seed, as a developer runs it, beside the started Tower.
  const seeded = spawnSync(process.execPath, [SEED, '--dir', home], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);

  const tower = `http://127.0.0.1:${port}`;
  // The totals: both invented sites, in their places, each with its open
  // alerts. The started installation's own lanes may add theirs (its site
  // checks find no invented domain), so the seeded ones are counted at least.
  const wall = await getJson(`${tower}/api/wall`);
  assert.equal(wall.status, 200);
  assert.deepEqual(wall.body.assets.map((asset) => asset.id), ['meadow.example', 'northwind.example']);
  assert.ok(wall.body.assets[1].openError >= 1, 'northwind.example’s items drop');
  assert.ok(wall.body.assets[0].openWarn >= 1, 'meadow.example’s plansSaved alert');

  // One report: meadow.example's last night, its series and its alert.
  const site = await getJson(`${tower}/api/assets/meadow.example`);
  assert.equal(site.status, 200);
  assert.equal(site.body.asset.firstReportAt, '2026-06-22T02:06:00.000Z');
  const signups = site.body.metrics.find((metric) => metric.name === 'signups');
  assert.deepEqual([signups.last24h, signups.total, signups.series.length], [10, 4233, 14]);
  assert.ok(site.body.flags.open.some((flag) => flag.ruleId === 'flow-poisson-low' && flag.metric === 'plansSaved' && flag.firedAt === '2026-07-05T02:06:00.000Z'));
  assert.ok(site.body.annotations.items.some((note) => note.kind === 'deploy' && note.note === 'ship CJ Magnifique product cards'));

  // The money: May's reconciled ads replace their estimate, June carries the build cost.
  const may = await getJson(`${tower}/api/financials?period=2026-05`);
  assert.equal(may.status, 200);
  assert.deepEqual(may.body.periods, ['2026-05', '2026-06']);
  const months = Object.fromEntries(may.body.months.map((month) => [month.period, month.total]));
  assert.deepEqual(months, {
    '2026-05': { currency: 'USD', revenue: 683.85, cost: 0, net: 683.85 },
    '2026-06': { currency: 'USD', revenue: 783.7, cost: 22.1, net: 761.6 },
  });
  assert.deepEqual(may.body.properties.map((p) => [p.asset, p.figure.revenue]), [['meadow.example', 641.85], ['northwind.example', 42]]);
});
