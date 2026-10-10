import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { REPO_ROOT } from './test-config-isolation.mjs';
import {
  APPLICATION_ROLE,
  NoSingleWorkspace,
  TransactionRefused,
  TransactionRolledBack,
  exactTypeParser,
  findOnlyWorkspace,
  javascriptInstant,
  openStore,
  openWorkspaceStore,
  runInWorkspace,
  withWorkspaceStore,
  withHostedWorkspaceStore,
  storeLocation,
} from '../packages/postgres/src/store.mjs';
import { PROOF_WORKSPACES, PostgresUnavailable, createWorkspace, openDevelopmentUrl, openThrowaway } from './postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace } from './postgres-migrate.mjs';

// The Workers and the scripts reach Postgres through one transaction helper,
// packages/postgres/src/store.mts, and the store names the workspace a
// self-hosted installation acts for: store.onlyWorkspace(), through
// noticeos.only_workspace().
//
//   - STATIC, always: what the helper refuses before sending (a transaction
//     without a workspace, a statement that would take the transaction or its
//     settings over, a value that is not exact), how each Postgres type is
//     read, a COMMIT that Postgres turned into ROLLBACK, that asking for the
//     only workspace is one statement and never a transaction, and that the
//     module reads nothing but its connection string.
//   - LIVE, on a throwaway cluster (skipped with the reason where no Postgres
//     15+ can start; NOTICEOS_REQUIRE_POSTGRES=1 makes it required): every
//     transaction runs as noticeos_app with its workspace set LOCAL, and the
//     same connection afterwards names none, reads nothing and writes nothing;
//     one workspace never sees another's rows; bigint past 2^53, numeric(14,6),
//     timestamptz microseconds, json text, bytes and NULL vs '' round-trip
//     exactly; any failure rolls the whole transaction back; a connection that
//     is not noticeos_app is refused before the work runs; a new
//     installation's store names its one workspace after the bootstrap, and
//     with none, two or a malformed id no transaction opens.

const [A, B] = PROOF_WORKSPACES.map((p) => p.ws);

// ─── Static ─────────────────────────────────────────────────────────────────

/** A stand-in connection that records what is sent and answers as Postgres would. */
function fakeClient({ role = APPLICATION_ROLE, commit = 'COMMIT', workspace = null, only = null } = {}) {
  const sent = [];
  return {
    sent,
    async query(query) {
      sent.push(query);
      if (query.text.includes('noticeos.only_workspace()')) {
        return { command: 'SELECT', rows: [{ workspace_id: only, session_role: role, acting_role: role, bypasses_row_security: false }], rowCount: 1 };
      }
      if (query.text.startsWith('BEGIN')) {
        const ws = workspace ?? /'noticeos\.workspace_id', '([^']+)'/u.exec(query.text)?.[1];
        return [
          { command: 'BEGIN', rows: [], rowCount: null },
          { command: 'SELECT', rows: [{ workspace_id: ws, session_role: role, acting_role: role, bypasses_row_security: false }], rowCount: 1 },
        ];
      }
      if (query.text === 'COMMIT') return { command: commit, rows: [], rowCount: null };
      if (query.text === 'ROLLBACK') return { command: 'ROLLBACK', rows: [], rowCount: null };
      return { command: 'SELECT', rows: [{ values: query.values }], rowCount: 1 };
    },
  };
}

test('a transaction without a lower-case UUID workspace is never opened', async () => {
  for (const workspace of [undefined, '', 'NOT-A-UUID', A.toUpperCase(), `${A}'; DROP TABLE x; --`]) {
    const client = fakeClient();
    await assert.rejects(runInWorkspace(client, workspace, async () => 'ran'), TransactionRefused, String(workspace));
    assert.deepEqual(client.sent, [], 'nothing was sent');
  }
  const store = openStore('postgresql:///noticeos_dev?host=/nonexistent&user=noticeos_app');
  await assert.rejects(store.inWorkspace('', async () => 'ran'), TransactionRefused);
  await store.close();
  await assert.rejects(store.inWorkspace(A, async () => 'ran'), /closed/u);
  assert.throws(() => openStore(''), TransactionRefused);
});

test('a statement that would take over the transaction, or an inexact value, is refused before it is sent and the transaction rolls back', async () => {
  const refused = [
    ['BEGIN', [], /BEGIN is the helper's/u],
    ['  -- a note\n  commit', [], /COMMIT is the helper's/u],
    ['/* why */ SET ROLE noticeos_owner', [], /SET is the helper's/u],
    ['set local noticeos.workspace_id = 1', [], /SET is the helper's/u],
    ['RESET ALL', [], /RESET/u],
    ['SAVEPOINT before', [], /SAVEPOINT/u],
    ['DISCARD ALL', [], /DISCARD/u],
    ["SELECT set_config('noticeos.workspace_id', '0000000b-0000-4000-8000-00000000000b', true)", [], /set once, by inWorkspace/u],
    ['   ', [], /empty statement/u],
    ['SELECT $1', [undefined], /\$1 is undefined; pass null for NULL/u],
    ['SELECT $1', [Number.NaN], /\$1: NaN is not a finite number/u],
    ['SELECT $1', [Number.POSITIVE_INFINITY], /not a finite number/u],
    ['SELECT $1, $2', ['ok', 2 ** 53 + 2], /\$2: 9007199254740994 is past 2\^53/u],
    ['SELECT $1', [{ a: 1 }], /JSON\.stringify it/u],
    ['SELECT $1', [[new Uint8Array(2)]], /bytes inside a list/u],
    ['SELECT $1', [new Date('not a date')], /invalid Date/u],
  ];
  for (const [sql, params, why] of refused) {
    const client = fakeClient();
    await assert.rejects(
      runInWorkspace(client, A, (tx) => tx.query(sql, params)),
      (error) => error instanceof TransactionRefused && why.test(error.message),
      sql,
    );
    assert.equal(client.sent.some((query) => query.text === sql), false, `${sql} was not sent`);
    assert.equal(client.sent.at(-1).text, 'ROLLBACK', `${sql}: the transaction rolled back`);
  }
});

test('values cross as exact text: bigints and decimals as strings, a Date as its instant, NULL apart from the empty string', async () => {
  const client = fakeClient();
  const at = Date.UTC(2026, 8, 5, 1, 2, 3, 456);
  const [row] = await runInWorkspace(client, A, (tx) =>
    tx.query('SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9', [9007199254740993n, 0.000625, 0.1 + 0.2, -0, true, null, '', new Date(at), ['a', 2n, null]]),
  );
  assert.deepEqual(row.values, ['9007199254740993', '0.000625', '0.30000000000000004', '0', true, null, '', '2026-09-05T01:02:03.456Z', ['a', '2', null]]);
  const bytes = new Uint8Array([0, 255]);
  const [raw] = await runInWorkspace(client, A, (tx) => tx.query('SELECT $1', [bytes]));
  assert.equal(raw.values[0], bytes, 'bytes go to the driver as bytes');
  // Every statement of the work goes by the extended protocol: one statement per call.
  const statements = client.sent.filter((query) => query.text.startsWith('SELECT $'));
  assert.ok(statements.every((query) => query.queryMode === 'extended'));
});

test('each Postgres type is read exactly: bigint, microsecond UTC instants, text decimals and JSON, bytes, one-dimensional arrays', () => {
  const read = (oid, text) => exactTypeParser(oid)(text);
  assert.equal(read(20, '9007199254740993'), 9007199254740993n);
  assert.equal(read(20, '-9223372036854775808'), -9223372036854775808n);
  assert.equal(read(23, '2147483647'), 2147483647);
  assert.equal(read(701, '0.30000000000000004'), 0.30000000000000004);
  assert.ok(Number.isNaN(read(701, 'NaN')));
  assert.equal(read(1700, '0.000625'), '0.000625');
  assert.equal(read(1700, '12345678.000000'), '12345678.000000');
  assert.equal(read(1184, '2026-09-05 01:02:03.456789+00'), '2026-09-05T01:02:03.456789Z');
  assert.equal(read(1184, '2026-09-05 01:02:03.4+00'), '2026-09-05T01:02:03.400000Z');
  assert.equal(read(1184, '2026-09-05 01:02:03+00'), '2026-09-05T01:02:03.000000Z');
  assert.equal(read(1184, '2026-09-05 06:32:03.5+05:30'), '2026-09-05T06:32:03.500000+05:30');
  assert.equal(read(1184, 'infinity'), 'infinity');
  assert.throws(() => read(1184, '0044-03-15 12:00:00+00 BC'), /ISO form/u);
  assert.equal(read(1082, '2026-09-05'), '2026-09-05');
  assert.equal(read(114, '{"b": 1,  "a": 9007199254740993}'), '{"b": 1,  "a": 9007199254740993}');
  assert.equal(read(3802, '{"a": 1}'), '{"a": 1}');
  assert.equal(read(16, 't'), true);
  assert.equal(read(16, 'f'), false);
  assert.deepEqual(read(17, '\\x00ff10'), new Uint8Array([0, 255, 16]));
  assert.equal(read(2950, '0000000a-0000-4000-8000-00000000000a'), '0000000a-0000-4000-8000-00000000000a');
  assert.equal(read(1186, '1 day 02:00:00'), '1 day 02:00:00');
  assert.deepEqual(read(1007, '{1,7,28}'), [1, 7, 28]);
  assert.deepEqual(read(1007, '{}'), []);
  assert.deepEqual(read(1016, '{9007199254740993,NULL}'), [9007199254740993n, null]);
  assert.deepEqual(read(1009, '{"a,b","NULL",NULL,"","say \\"hi\\"",plain}'), ['a,b', 'NULL', null, '', 'say "hi"', 'plain']);
  assert.deepEqual(read(1185, '{"2026-09-05 01:02:03.456789+00"}'), ['2026-09-05T01:02:03.456789Z']);
  assert.deepEqual(read(1231, '{0.000625,1.100000}'), ['0.000625', '1.100000']);
  assert.throws(() => read(1007, '{{1,2},{3,4}}'), /multi-dimensional/u);
  assert.throws(() => read(1007, '[0:1]={1,2}'), /default bounds/u);
  assert.throws(() => exactTypeParser(20, 'binary'), /read as text/u);
});

test('statements started together reach the connection one at a time, in order, and all finish before COMMIT', async () => {
  const inner = fakeClient();
  let inFlight = 0;
  let most = 0;
  const client = {
    sent: inner.sent,
    async query(query) {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return inner.query(query);
    },
  };
  const answers = await runInWorkspace(client, A, async (tx) => {
    tx.execute('SELECT 3').catch(() => undefined); // started, never awaited
    return Promise.all([tx.query('SELECT 1', [1]), tx.query('SELECT 2', [2])]);
  });
  assert.equal(most, 1, 'never two statements at once');
  assert.deepEqual(client.sent.map((query) => query.text).slice(1), ['SELECT 3', 'SELECT 1', 'SELECT 2', 'COMMIT']);
  assert.deepEqual(answers.map(([row]) => row.values), [['1'], ['2']]);
  // Once the work is over, its transaction takes no more statements.
  let late;
  await runInWorkspace(fakeClient(), A, async (tx) => {
    late = tx;
  });
  await assert.rejects(late.query('SELECT 1'), /this transaction has ended/u);
});

test('a COMMIT that Postgres answers with ROLLBACK is a rolled-back transaction, not a success', async () => {
  const client = fakeClient({ commit: 'ROLLBACK' });
  await assert.rejects(runInWorkspace(client, A, async () => 'looked fine'), TransactionRolledBack);
});

test('a connection that is not the application role is refused before the work runs', async () => {
  for (const role of ['postgres', 'noticeos_owner', 'noticeos_maint']) {
    const client = fakeClient({ role });
    let ran = false;
    await assert.rejects(
      runInWorkspace(client, A, async () => {
        ran = true;
      }),
      (error) => error instanceof TransactionRefused && error.message.includes(`connected as ${role}`),
    );
    assert.equal(ran, false);
    assert.equal(client.sent.at(-1).text, 'ROLLBACK');
  }
});

test("asking for the only workspace is one statement, never a transaction: the store's id, or a refusal when it names none", async () => {
  const found = fakeClient({ only: A });
  assert.equal(await findOnlyWorkspace(found), A);
  assert.equal(found.sent.length, 1, 'one statement');
  assert.match(found.sent[0].text, /^SELECT\n {2}noticeos\.only_workspace\(\)::text AS workspace_id,/u);

  // None or several: the store answers NULL, and nothing more is sent.
  const none = fakeClient({ only: null });
  await assert.rejects(findOnlyWorkspace(none), (error) => error instanceof NoSingleWorkspace && error instanceof TransactionRefused && /bootstrap/u.test(error.message));
  assert.equal(none.sent.length, 1);
  assert.equal(none.sent.some((query) => /^BEGIN/u.test(query.text)), false, 'no transaction opened');

  // An answer that is not a lower-case UUID is refused, not passed on.
  await assert.rejects(findOnlyWorkspace(fakeClient({ only: 'NOT-A-UUID' })), /lower-case UUID/u);

  // A connection that is not the application role is refused, as for a transaction.
  for (const role of ['postgres', 'noticeos_owner']) {
    await assert.rejects(findOnlyWorkspace(fakeClient({ role, only: A })), (error) => error instanceof TransactionRefused && error.message.includes(`connected as ${role}`));
  }
  const store = openStore('postgresql:///noticeos_dev?host=/nonexistent&user=noticeos_app');
  await store.close();
  await assert.rejects(store.onlyWorkspace(), /closed/u);
});

test('an instant leaves in the form JavaScript writes, so it compares as a string with one JavaScript made', () => {
  assert.equal(javascriptInstant('2026-09-05T09:00:00.000000Z'), new Date('2026-09-05T09:00:00Z').toISOString());
  assert.equal(javascriptInstant('2026-09-05T01:02:03.456789Z'), '2026-09-05T01:02:03.456Z');
  assert.equal(javascriptInstant('2026-09-05T06:32:03.500000+05:30'), '2026-09-05T01:02:03.500Z');
  for (const bad of ['', 'yesterday', null, 3]) assert.throws(() => javascriptInstant(bad), TypeError, String(bad));
});

test("a Worker call's store is opened for the call and handed to waitUntil to close, even when the work throws", async () => {
  const closing = [];
  const ctx = { waitUntil: (promise) => closing.push(promise) };
  const binding = { connectionString: 'postgresql://noticeos_app:unused@127.0.0.1:9/noticeos_unused_dev?sslmode=disable' };
  // Nothing connects until a unit of work: a call that never reads costs nothing.
  assert.equal(await withWorkspaceStore(binding, ctx, async (store) => store.where), '127.0.0.1:9/noticeos_unused_dev');
  assert.equal(closing.length, 1);
  await closing[0];
  await assert.rejects(withWorkspaceStore(binding, ctx, async () => { throw new Error('the work failed'); }), /the work failed/u);
  assert.equal(closing.length, 2);
  await closing[1];
});

test('a Worker with no POSTGRES binding still runs its call, and each unit of work refuses, naming why', async () => {
  const closing = [];
  const ctx = { waitUntil: (promise) => closing.push(promise) };
  const answer = await withWorkspaceStore(undefined, ctx, async (store) => {
    for (const unit of [store.workspaceId(), store.read(async () => 1), store.write(async () => 1)]) {
      await assert.rejects(unit, (error) => error instanceof TransactionRefused && /no POSTGRES binding/u.test(error.message));
    }
    return store.where;
  });
  assert.equal(answer, 'no store');
  assert.equal(closing.length, 1);
  await closing[0];
});

test('hosted calls refuse missing or malformed structural inputs before work or discovery, without echoing supplied values', async () => {
  const transport = { kind: 'direct', connectionString: 'postgresql://noticeos_app:fixture@127.0.0.1:9/noticeos_unused_dev' };
  const workspace = { workspaceId: A };
  const sensitive = 'never echo this supplied value';
  const getter = { get transport() { throw new Error(sensitive); } };
  const bad = [undefined, null, [], true, sensitive, 2, getter, {},
    { workspace }, { transport }, { transport, workspace: null }, { transport, workspace: sensitive },
    { transport, workspace: { workspaceId: sensitive } }, { transport, workspace: { workspaceId: A.toUpperCase() } },
    { transport: null, workspace }, { transport: sensitive, workspace },
    { transport: Object.assign([], transport), workspace }, { transport, workspace: Object.assign([], workspace) },
    { transport: { connectionString: transport.connectionString }, workspace },
    { transport: { kind: 'hyperdrive', connectionString: transport.connectionString }, workspace },
    ...[undefined, null, 2, '', ' ', sensitive, 'https://private.test/path', 'postgresql://', 'postgresql:///db', 'postgresql://127.0.0.1/'].map(connectionString => ({ transport: { kind: 'direct', connectionString }, workspace }))];
  let called = 0;
  for (const call of bad) {
    await assert.rejects(withHostedWorkspaceStore(call, { waitUntil: () => called++ }, async () => { called++; }), error =>
      error instanceof TransactionRefused && error.message === 'a hosted store needs an explicit direct PostgreSQL transport and workspace');
  }
  assert.equal(called, 0, 'neither the work nor a closing obligation starts for invalid input');
});

test('a valid hosted call names its explicit workspace without connecting and closes through waitUntil on success or error', async () => {
  const closing = [];
  const ctx = { waitUntil: promise => closing.push(promise) };
  const call = { transport: { kind: 'direct', connectionString: 'postgresql://noticeos_app:fixture@127.0.0.1:9/noticeos_unused_dev' }, workspace: { workspaceId: A } };
  assert.equal(await withHostedWorkspaceStore(call, ctx, store => store.workspaceId()), A);
  await assert.rejects(withHostedWorkspaceStore(call, ctx, async () => { throw new Error('work failed'); }), /work failed/);
  assert.equal(closing.length, 2);
  await Promise.all(closing);
});

test("a call's store names where it is, never how it logs in", () => {
  assert.equal(storeLocation('postgresql://noticeos_app:s3cret@127.0.0.1:5410/noticeos_x_dev?sslmode=disable'), '127.0.0.1:5410/noticeos_x_dev');
  assert.equal(storeLocation('postgresql://noticeos_app:s3cret@abc.hyperdrive.local/noticeos'), 'abc.hyperdrive.local:5432/noticeos');
  assert.equal(storeLocation('postgresql:///noticeos_dev?host=/tmp/nos-x&user=noticeos_app'), '/tmp/nos-x:5432/noticeos_dev');
  assert.doesNotMatch(storeLocation('not a url s3cret'), /s3cret/u);
  assert.throws(() => openWorkspaceStore('postgresql:///noticeos_dev?host=/nonexistent', { workspaceId: 'NOT-A-UUID' }), TransactionRefused);
});

test('the helper reads nothing but its connection string, and knows no migration runner', () => {
  const code = readFileSync(path.join(REPO_ROOT, 'packages/postgres/src/store.mts'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/u.test(line))
    .join('\n');
  assert.deepEqual([...code.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1]), ['pg']);
  for (const forbidden of ['process.env', 'node:', '.dev.vars', 'dev.secrets', 'CREDENTIALS_KEY', 'OPERATOR_TOKEN', 'migrat']) {
    assert.equal(code.includes(forbidden), false, `store.mts must not reference ${forbidden}`);
  }
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages/postgres/package.json'), 'utf8'));
  assert.match(manifest.dependencies.pg, /^\d+\.\d+\.\d+$/u, 'the driver is pinned to one exact version');
});

// ─── Live, on a throwaway cluster ───────────────────────────────────────────

/** Run `fn` against Postgres, or skip with the reason where none can start. */
async function live(t, fn) {
  try {
    await fn(await cluster());
  } catch (error) {
    if (error instanceof PostgresUnavailable && process.env.NOTICEOS_REQUIRE_POSTGRES !== '1') {
      t.skip(error.message);
      return;
    }
    throw error;
  }
}

/** node-postgres itself, from the helper's own package, for a connection a proof holds. */
const { Client } = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'))('pg');

let opened = null;
const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
});

/** One throwaway cluster for every live proof here: migrated, two workspaces,
 * each with one site, and noticeos_app given a login — the operator's step on
 * a real host. `url(user)` is a connection string on its private socket. */
function cluster() {
  opened ??= (async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nos-store-'));
    closers.push(() => rmSync(root, { recursive: true, force: true }));
    const dev = openThrowaway(path.join(root, 'cluster'));
    closers.push(() => dev.close());
    applyMigrations(dev);
    for (const { ws, slug } of PROOF_WORKSPACES) createWorkspace(dev, { slug, workspaceId: ws });
    dev.sql('ALTER ROLE noticeos_app LOGIN');
    const url = (user = APPLICATION_ROLE) => `postgresql:///noticeos_dev?host=${dev.socketDir}&user=${user}`;
    const store = openStore(url());
    closers.push(() => store.close());
    for (const { ws, site } of PROOF_WORKSPACES) {
      await store.inWorkspace(ws, (tx) =>
        tx.execute("INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status) VALUES ($1, $2, 'Site', 'live')", [ws, site]),
      );
    }
    return { dev, url, store };
  })();
  return opened;
}

/** A connection the proof holds itself, closed after the test. */
async function heldConnection(t, url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  t.after(() => client.end());
  return client;
}

test('every transaction runs as noticeos_app with its workspace set LOCAL; the same connection afterwards names none, reads nothing and writes nothing', async (t) => {
  await live(t, async ({ url }) => {
    const client = await heldConnection(t, url());
    const [inside] = await runInWorkspace(client, A, (tx) =>
      tx.query(
        `SELECT noticeos.current_workspace_id()::text AS workspace, session_user::text AS session_role, current_user::text AS acting_role,
                current_setting('TimeZone') AS time_zone, (SELECT count(*)::int FROM noticeos.assets) AS sites`,
      ),
    );
    assert.deepEqual(inside, { workspace: A, session_role: 'noticeos_app', acting_role: 'noticeos_app', time_zone: 'UTC', sites: 1 });

    // The same connection, outside any helper transaction: the setting ended with it.
    const { rows: [after] } = await client.query(
      "SELECT noticeos.current_workspace_id() AS workspace, current_setting('noticeos.workspace_id', true) AS setting, (SELECT count(*)::int FROM noticeos.assets) AS sites",
    );
    assert.deepEqual(after, { workspace: null, setting: '', sites: 0 }, 'no workspace, so no rows');
    const changed = await client.query("UPDATE noticeos.assets SET display_name = 'Renamed'");
    assert.equal(changed.rowCount, 0, 'no workspace, so nothing to change');
    await assert.rejects(
      client.query(`INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind) VALUES ('${A}', 'a.example', now(), 'deploy')`),
      (error) => error.code === '42501' && /row-level security/u.test(error.message),
      'no workspace, so no write',
    );
    const [check] = await runInWorkspace(client, A, (tx) =>
      tx.query("SELECT count(*)::int AS renamed FROM noticeos.assets WHERE display_name = 'Renamed'"),
    );
    assert.equal(check.renamed, 0);
  });
});

test('one pooled connection serves each workspace in turn, and each transaction sees only its own', async (t) => {
  await live(t, async ({ url }) => {
    const store = openStore(url(), { maxConnections: 1 });
    t.after(() => store.close());
    const seen = async (ws) =>
      store.inWorkspace(ws, async (tx) => (await tx.query('SELECT pg_backend_pid() AS pid, array_agg(asset_id)::text[] AS sites FROM noticeos.assets'))[0], {
        readOnly: true,
      });
    const first = await seen(A);
    const second = await seen(B);
    assert.equal(first.pid, second.pid, 'the same connection');
    assert.deepEqual([first.sites, second.sites], [['a.example'], ['b.example']]);
  });
});

test('hosted calls use explicit A/B ownership in a multi-workspace store, with identical queries and failed writes isolated', async (t) => {
  await live(t, async ({ url }) => {
    const closing = [];
    const stores = [];
    const ctx = { waitUntil: promise => closing.push(promise) };
    const call = workspaceId => ({ transport: { kind: 'direct', connectionString: url() }, workspace: { workspaceId } });
    const read = workspaceId => withHostedWorkspaceStore(call(workspaceId), ctx, async store => {
      stores.push(store);
      assert.equal(await store.workspaceId(), workspaceId);
      return store.read(async tx => (await tx.query('SELECT array_agg(asset_id ORDER BY asset_id)::text[] AS sites FROM noticeos.assets'))[0].sites);
    });
    assert.deepEqual(await Promise.all([read(A), read(B), read(A), read(B)]), [['a.example'], ['b.example'], ['a.example'], ['b.example']]);
    await assert.rejects(withHostedWorkspaceStore(call(A), ctx, async store => {
      await store.write(async tx => {
        await tx.execute("INSERT INTO noticeos.annotations(workspace_id,asset_id,at,kind,note) VALUES($1,'a.example',now(),'incident','hosted rollback')", [tx.workspaceId]);
        await tx.query('SELECT 1/0').catch(() => undefined);
      });
    }), TransactionRolledBack);
    assert.equal(await withHostedWorkspaceStore(call(A), ctx, store => store.read(async tx => (await tx.query("SELECT count(*)::int AS n FROM noticeos.annotations WHERE note='hosted rollback'"))[0].n)), 0);
    assert.deepEqual(await read(B), ['b.example']);
    await Promise.all(closing);
    assert.equal(closing.length, 7, 'every successful or failed call handed its close to waitUntil');
    for (const store of stores) await assert.rejects(store.read(tx => tx.query('SELECT 1')), /closed/);
  });
});

test('bigint past 2^53, numeric(14,6), microsecond times, doubles, json text, bytes, arrays and NULL vs empty text round-trip exactly', async (t) => {
  await live(t, async ({ store }) => {
    const envelope = '{"b": 1,  "a": 9007199254740993, "note": "kept as sent"}';
    const row = await store.inWorkspace(A, async (tx) => {
      await tx.execute(
        `INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state, recorded_at)
         VALUES ($1, 'revenue', 'a.example', '2026-08-01', 'ads', $2, 'USD', 'estimated', $3)`,
        [tx.workspaceId, 9007199254740993n, '2026-09-05T01:02:03.456789Z'],
      );
      await tx.execute(
        `INSERT INTO noticeos.research_log (workspace_id, asset_id, provider, endpoint, params_sha256, question, cost_usd, cost_state, actor, bought_at)
         VALUES ($1, 'a.example', 'dataforseo', 'x', repeat('a', 64), 'q', $2, 'reported', 'test', $3),
                ($1, 'a.example', 'dataforseo', 'y', repeat('b', 64), 'q', $4, 'reported', 'test', $3)`,
        [tx.workspaceId, '0.000625', '2026-09-05T01:02:03Z', 12.5],
      );
      await tx.execute(
        `INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num)
         VALUES ($1, 'a.example', 'html-depth', $2, '2026-09-05', 'ok', $3)`,
        [tx.workspaceId, '2026-09-05T04:00:00Z', 0.1 + 0.2],
      );
      await tx.execute(
        `INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note) VALUES ($1, 'a.example', now(), 'deploy', $2, $3)`,
        [tx.workspaceId, null, ''],
      );
      await tx.execute(
        `INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, generated_at, envelope) VALUES ($1, 'a.example', $2, $3, $4)`,
        [tx.workspaceId, '2026-09-05', new Date(Date.UTC(2026, 8, 5, 3)), envelope],
      );
      const [read] = await tx.query(
        `SELECT l.amount_minor, -l.amount_minor AS negative, l.recorded_at, l.period_month,
                (SELECT array_agg(cost_usd ORDER BY endpoint) FROM noticeos.research_log) AS costs,
                h.value_num, a.ref, a.note, p.envelope, p.pulse_date, p.generated_at, p.pulse_id,
                $1::bytea AS bytes, $2::int[] AS offsets, NULL::text AS missing, ''::text AS empty
           FROM noticeos.ledger_entries l, noticeos.hygiene_checks h, noticeos.annotations a, noticeos.pulses p`,
        [new Uint8Array([0, 1, 254, 255]), [1, 7, 28]],
      );
      return read;
    });
    assert.deepEqual(row, {
      amount_minor: 9007199254740993n,
      negative: -9007199254740993n,
      recorded_at: '2026-09-05T01:02:03.456789Z',
      period_month: '2026-08-01',
      costs: ['0.000625', '12.500000'],
      value_num: 0.30000000000000004,
      ref: null,
      note: '',
      envelope,
      pulse_date: '2026-09-05',
      generated_at: '2026-09-05T03:00:00.000000Z',
      pulse_id: row.pulse_id,
      bytes: new Uint8Array([0, 1, 254, 255]),
      offsets: [1, 7, 28],
      missing: null,
      empty: '',
    });
    assert.equal(typeof row.pulse_id, 'bigint', 'an identity is a bigint too');

    // The other workspace sees none of it.
    const [elsewhere] = await store.inWorkspace(B, (tx) =>
      tx.query('SELECT (SELECT count(*) FROM noticeos.ledger_entries) AS ledger, (SELECT count(*) FROM noticeos.pulses) AS pulses'),
    );
    assert.deepEqual(elsewhere, { ledger: 0n, pulses: 0n });
  });
});

test('a failure anywhere rolls the whole transaction back, even one the work caught or never awaited', async (t) => {
  await live(t, async ({ store }) => {
    const annotate = (tx, note) =>
      tx.execute("INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, note) VALUES ($1, 'a.example', now(), 'incident', $2)", [
        tx.workspaceId,
        note,
      ]);
    const kept = async () =>
      (await store.inWorkspace(A, (tx) => tx.query("SELECT count(*)::int AS n FROM noticeos.annotations WHERE kind = 'incident'")))[0].n;

    // A statement fails after a write.
    await assert.rejects(
      store.inWorkspace(A, async (tx) => {
        await annotate(tx, 'failed statement');
        await tx.query('SELECT 1 / 0');
      }),
      /division by zero/u,
    );
    // The work throws after a write.
    await assert.rejects(
      store.inWorkspace(A, async (tx) => {
        await annotate(tx, 'work threw');
        throw new Error('the work gave up');
      }),
      /the work gave up/u,
    );
    // The work catches a failed statement and returns as if all were well.
    await assert.rejects(
      store.inWorkspace(A, async (tx) => {
        await annotate(tx, 'swallowed');
        await tx.query('SELECT 1 / 0').catch(() => undefined);
        return 'looked fine';
      }),
      (error) => error instanceof TransactionRolledBack && /division by zero/u.test(String(error.cause?.message)),
    );
    // The work returns before its statements finish, and one of them fails.
    await assert.rejects(
      store.inWorkspace(A, async (tx) => {
        annotate(tx, 'not awaited').catch(() => undefined);
        tx.query('SELECT 1 / 0').catch(() => undefined);
        return 'returned early';
      }),
      TransactionRolledBack,
    );
    // The application role cannot rewrite booked money: refused, and rolled back with the rest.
    await assert.rejects(
      store.inWorkspace(A, async (tx) => {
        await annotate(tx, 'before a refused update');
        await tx.execute('UPDATE noticeos.ledger_entries SET amount_minor = 0');
      }),
      /permission denied/u,
    );
    assert.equal(await kept(), 0, 'nothing from any failed transaction was kept');

    // A read-only transaction cannot write.
    await assert.rejects(store.inWorkspace(A, (tx) => annotate(tx, 'read only'), { readOnly: true }), /read-only transaction/u);

    // And a transaction that succeeds keeps its writes.
    await store.inWorkspace(A, (tx) => annotate(tx, 'kept'));
    assert.equal(await kept(), 1);
  });
});

test('a connection that breaks while its transaction runs fails that work alone: the process carries on and the store opens a new one', async (t) => {
  await live(t, async ({ dev, url }) => {
    const store = openStore(url(), { maxConnections: 1 });
    t.after(() => store.close());
    // What Node would do with the connection's error event: crash the process.
    const uncaught = [];
    const onUncaught = (error) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    t.after(() => process.removeListener('uncaughtException', onUncaught));

    const marker = `broken-connection-${process.pid}`;
    const work = store.inWorkspace(A, (tx) => tx.query(`SELECT pg_sleep(30), '${marker}' AS marker`));
    const running = `SELECT pid FROM pg_stat_activity WHERE usename = 'noticeos_app' AND query LIKE '%${marker}%' AND query NOT LIKE '%pg_stat_activity%'`;
    let pid = '';
    for (let tries = 0; pid === '' && tries < 200; tries += 1) {
      pid = dev.text(running).trim();
      if (pid === '') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual(pid, '', 'the transaction is running');
    // The server ends it, as a restart, a failover or a copy taken back would.
    dev.sql(`SELECT pg_terminate_backend(${pid})`);

    await assert.rejects(work, /terminat/u, 'the work on that connection fails');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(uncaught.map((error) => error.message), [], 'nothing reached the process as a crash');
    const [after] = await store.inWorkspace(A, (tx) => tx.query('SELECT pg_backend_pid() AS pid'), { readOnly: true });
    assert.notEqual(String(after.pid), pid, 'the next transaction runs on a new connection');
  });
});

test("a call's store works in its one workspace: reads cannot write, a write commits whole, and another workspace sees none of it", async (t) => {
  await live(t, async ({ url }) => {
    const inA = openWorkspaceStore(url(), { workspaceId: A });
    const inB = openWorkspaceStore(url(), { workspaceId: B });
    t.after(() => Promise.all([inA.close(), inB.close()]));
    assert.equal(await inA.workspaceId(), A);
    const note = (tx, text) =>
      tx.execute("INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, note) VALUES ($1, 'a.example', now(), 'external', $2)", [tx.workspaceId, `call store: ${text}`]);
    await assert.rejects(inA.read((tx) => note(tx, 'from a read')), /read-only transaction/u);
    await assert.rejects(
      inA.write(async (tx) => {
        await note(tx, 'half of a failed write');
        throw new Error('the write gave up');
      }),
      /the write gave up/u,
    );
    await inA.write((tx) => note(tx, 'kept'));
    const notes = (store) => store.read((tx) => tx.query("SELECT note FROM noticeos.annotations WHERE note LIKE 'call store: %'"));
    assert.deepEqual(await notes(inA), [{ note: 'call store: kept' }]);
    assert.deepEqual(await notes(inB), []);
    // A store with two workspaces names no only one: the caller must name it.
    const unnamed = openWorkspaceStore(url());
    t.after(() => unnamed.close());
    await assert.rejects(unnamed.read(() => Promise.resolve(null)), NoSingleWorkspace);
    await inA.close();
    await assert.rejects(inA.read(() => Promise.resolve(null)), /closed/u);
  });
});

test('a connection string naming any role but noticeos_app is refused before the work runs', async (t) => {
  await live(t, async ({ dev, url }) => {
    dev.sql('ALTER ROLE noticeos_owner LOGIN');
    t.after(() => dev.sql('ALTER ROLE noticeos_owner NOLOGIN'));
    for (const user of ['postgres', 'noticeos_owner']) {
      const store = openStore(url(user));
      let ran = false;
      await assert.rejects(
        store.inWorkspace(A, async () => {
          ran = true;
        }),
        (error) => error instanceof TransactionRefused && error.message.includes(`connected as ${user}`),
        user,
      );
      await assert.rejects(
        store.onlyWorkspace(),
        (error) => error instanceof TransactionRefused && error.message.includes(`connected as ${user}`),
        `${user}: asking for the only workspace`,
      );
      await store.close();
      assert.equal(ran, false, `${user}: the work never ran`);
    }
  });
});

/** `client`, recording the text of every statement it is sent. */
function recording(client) {
  const sent = [];
  return {
    sent,
    query(query) {
      sent.push(query.text);
      return client.query(query);
    },
  };
}

/** A new installation before its bootstrap: a second development database on
 * the shared cluster (the first already holds two workspaces; a second
 * cluster would cost this machine another shared-memory segment), migrated
 * through the development profile's URL. */
function newInstallation({ dev }) {
  dev.sql('CREATE DATABASE noticeos_new_dev');
  dev.sql("ALTER DATABASE noticeos_new_dev SET noticeos.profile = 'development'");
  const fresh = openDevelopmentUrl(`postgresql:///noticeos_new_dev?host=${dev.socketDir}&user=postgres`);
  applyMigrations(fresh);
  return { fresh, url: `postgresql:///noticeos_new_dev?host=${dev.socketDir}&user=${APPLICATION_ROLE}` };
}

test("a new installation's store names its one workspace: none before the bootstrap, the bootstrap's after it, none once there are two; each refusal opens no transaction", async (t) => {
  await live(t, async (shared) => {
    const { fresh: dev, url } = newInstallation(shared);
    const store = openStore(url);
    t.after(() => store.close());
    const held = recording(await heldConnection(t, url));
    const openedTransaction = () => held.sent.some((text) => /^\s*(BEGIN|START)/iu.test(text));
    let ran = false;
    const work = async (tx) => {
      ran = true;
      return tx.query('SELECT asset_id FROM noticeos.assets');
    };

    // Migrated, not yet bootstrapped: no workspace, so no transaction.
    await assert.rejects(findOnlyWorkspace(held), NoSingleWorkspace);
    await assert.rejects(async () => store.inWorkspace(await store.onlyWorkspace(), work), NoSingleWorkspace);
    assert.equal(openedTransaction(), false, 'no workspace: no transaction opened');
    assert.equal(ran, false);
    // A call's store asks the same question on its first unit of work.
    const call = openWorkspaceStore(url);
    t.after(() => call.close());
    await assert.rejects(call.read(work), NoSingleWorkspace);
    assert.equal(ran, false);

    // The bootstrap creates the one workspace, and the store names it: no id is copied anywhere.
    const { workspaceId, created } = bootstrapWorkspace(dev, { slug: 'main', displayName: 'My sites' });
    assert.equal(created, true);
    assert.equal(await store.onlyWorkspace(), workspaceId);
    assert.equal(await findOnlyWorkspace(held), workspaceId);
    await store.inWorkspace(await store.onlyWorkspace(), (tx) =>
      tx.execute("INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status) VALUES ($1, 'first.example', 'First', 'live')", [
        tx.workspaceId,
      ]),
    );
    assert.deepEqual(await store.inWorkspace(await store.onlyWorkspace(), work, { readOnly: true }), [{ asset_id: 'first.example' }]);
    // The refusal was not remembered: the same call's store now finds the workspace.
    assert.deepEqual(await call.read(work), [{ asset_id: 'first.example' }]);
    assert.equal(await call.workspaceId(), workspaceId);

    // A second workspace: the store names neither, and no transaction opens.
    createWorkspace(dev, { slug: 'second' });
    held.sent.length = 0;
    ran = false;
    await assert.rejects(findOnlyWorkspace(held), NoSingleWorkspace);
    await assert.rejects(async () => store.inWorkspace(await store.onlyWorkspace(), work), NoSingleWorkspace);
    assert.equal(openedTransaction(), false, 'two workspaces: no transaction opened');

    // A malformed id is refused before anything is sent.
    for (const malformed of [undefined, '', 'not-a-uuid', workspaceId.toUpperCase(), `${workspaceId}'; --`]) {
      held.sent.length = 0;
      await assert.rejects(runInWorkspace(held, malformed, work), TransactionRefused, String(malformed));
      await assert.rejects(store.inWorkspace(malformed, work), TransactionRefused, String(malformed));
      assert.deepEqual(held.sent, [], `${malformed}: nothing was sent`);
    }
    assert.equal(ran, false, 'no refused transaction ran its work');
  });
});
