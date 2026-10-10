import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { DevelopmentProfileRefused, LOOPBACK_ROLE, PostgresUnavailable, loopbackHba, openThrowaway, processAlive } from './postgres-dev.mjs';
import { TEMPLATE_DATABASE, parsePortRange, postgresRequired, startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';
import { attachTestCluster } from './postgres-test-copies.mjs';

// The way a Worker reaches a throwaway Postgres, and a test run's stores.
//
//   - STATIC, always: the loopback mode lets in over TCP only noticeos_app,
//     only from 127.0.0.1, only by password, and refuses a port it may not
//     take before touching anything; a run's port range reads as a range or
//     not at all; a test store is never the template.
//   - LIVE, on a test run's cluster (skipped with the reason where no Postgres
//     15+ can start; NOTICEOS_REQUIRE_POSTGRES=1 makes it required): over TCP
//     the owner, the maintenance role, the superuser and a wrong password are
//     refused and noticeos_app gets in with the password the start made; the
//     server listens on 127.0.0.1 alone; the password is in no file of the
//     cluster's folder; the template takes no connection; each copy starts as
//     a new installation's store, a copy made again forgets what was written
//     to it, and one copy never sees another's rows; a test process gets its
//     copies from the starting process's copy service, which refuses anything
//     but a copy's name; the owner's operations never block the process that
//     holds them; a copy given back is handed out again under a new name, as
//     empty as a new one; closing stops the service and the server and removes the
//     cluster's folder.

// ─── Static ─────────────────────────────────────────────────────────────────

test('the loopback mode lets in over TCP only the application role, only from 127.0.0.1, only by password', () => {
  const lines = loopbackHba().split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
  assert.deepEqual(lines, ['local all all trust', `host all ${LOOPBACK_ROLE} 127.0.0.1/32 scram-sha-256`]);
  assert.equal(LOOPBACK_ROLE, 'noticeos_app');
});

test('a loopback port it may not take is refused before anything is touched', () => {
  const fakeTools = { initdb: '/nonexistent/initdb', pgCtl: '/nonexistent/pg_ctl', psql: '/nonexistent/psql', version: 'psql (PostgreSQL) 16.0', major: 16 };
  const dir = path.join(os.tmpdir(), `nos-never-made-${process.pid}`);
  for (const port of [0, 80, 1023, 65536, 5432.5, '5410', Number.NaN]) {
    assert.throws(() => openThrowaway(dir, fakeTools, { loopbackPort: port }), DevelopmentProfileRefused, String(port));
  }
  assert.equal(existsSync(dir), false, 'nothing was made');
});

test("a run's port range reads as a range or not at all, and a test store is never the template", () => {
  assert.deepEqual(parsePortRange('5400-5449'), [5400, 5449]);
  assert.equal(parsePortRange(undefined), null);
  assert.equal(parsePortRange(''), null);
  for (const bad of ['5449-5400', '80-90', '5400', '5400-70000', 'a-b']) assert.throws(() => parsePortRange(bad), TypeError, bad);
  assert.equal(postgresRequired({ NOTICEOS_REQUIRE_POSTGRES: '1' }), true);
  assert.equal(postgresRequired({}), false);
  const handle = { copyService: '/nonexistent/copies.sock', workspaceId: '0', appUrl: 'postgresql://noticeos_app:x@127.0.0.1:5410/noticeos_dev?sslmode=disable' };
  const cluster = attachTestCluster(handle);
  for (const name of [TEMPLATE_DATABASE, 'postgres', 'noticeos_x', 'noticeos_x_dev; DROP DATABASE y', 'Noticeos_X_dev']) {
    assert.throws(() => cluster.url(name), TypeError, name);
  }
  assert.equal(cluster.url('noticeos_x_dev'), 'postgresql://noticeos_app:x@127.0.0.1:5410/noticeos_x_dev?sslmode=disable');
  assert.throws(() => attachTestCluster({}), TypeError);
  assert.equal(unavailableReason(new PostgresUnavailable('no server here')), 'no server here');
  assert.equal(unavailableReason(new Error('a real failure')), null, 'any other error is reported, never skipped');
});

// ─── Live ───────────────────────────────────────────────────────────────────

const { Client } = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'))('pg');

let started = null;
const parent = mkdtempSync(path.join(os.tmpdir(), 'nos-cluster-proof-'));
after(async () => {
  const cluster = await started?.catch(() => null);
  const servers = readdirSync(parent)
    .map((root) => path.join(parent, root, 'cluster', 'data', 'postmaster.pid'))
    .filter((file) => existsSync(file))
    .map((file) => Number(readFileSync(file, 'utf8').split('\n')[0]));
  cluster?.close();
  for (const pid of servers) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(processAlive(pid), false, 'the owned server stops before its parent is removed');
  }
  rmSync(parent, { recursive: true, force: true });
});

/** Run `fn` on one cluster for this file, or skip with the reason where none can start. */
async function live(t, fn) {
  started ??= startTestCluster({ parent });
  try {
    await fn(await started);
  } catch (error) {
    if (error instanceof PostgresUnavailable && !postgresRequired()) {
      t.skip(error.message);
      return;
    }
    throw error;
  }
}

/** Whether a TCP login with `url` succeeds; the refusal's words otherwise. */
async function login(url) {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT session_user::text AS who');
    return { ok: true, who: rows[0].who };
  } catch (error) {
    return { ok: false, why: error.message };
  } finally {
    await client.end().catch(() => undefined);
  }
}

test('over TCP only noticeos_app gets in, by the password its start made; the server listens on 127.0.0.1 alone', async (t) => {
  await live(t, async (cluster) => {
    const database = await cluster.createDatabase('noticeos_logins_dev');
    const url = new URL(cluster.url(database));
    assert.deepEqual(await login(url.toString()), { ok: true, who: 'noticeos_app' });
    for (const role of ['postgres', 'noticeos_owner', 'noticeos_maint']) {
      const other = new URL(url);
      other.username = role;
      const answer = await login(other.toString());
      assert.equal(answer.ok, false, role);
      assert.match(answer.why, /no pg_hba\.conf entry/u, role);
    }
    const wrong = new URL(url);
    wrong.password = 'not-the-password';
    const refused = await login(wrong.toString());
    assert.equal(refused.ok, false);
    assert.match(refused.why, /password authentication failed/u);

    const listening = new Client({ connectionString: url.toString() });
    await listening.connect();
    const { rows } = await listening.query('SHOW listen_addresses');
    await listening.end();
    assert.deepEqual(rows, [{ listen_addresses: '127.0.0.1' }]);
    await cluster.dropDatabase(database);
  });
});

test('the password is in no file of the cluster folder, and the template takes no connection', async (t) => {
  await live(t, async (cluster) => {
    const password = decodeURIComponent(new URL(cluster.handle.appUrl).password);
    assert.ok(password.length >= 24);
    const holders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && statSync(full).size < 64 * 1024 * 1024 && readFileSync(full, 'latin1').includes(password)) holders.push(full);
      }
    };
    walk(parent);
    assert.deepEqual(holders, []);

    const answer = await login(cluster.url('noticeos_never_made_dev').replace('noticeos_never_made_dev', TEMPLATE_DATABASE));
    assert.equal(answer.ok, false);
    assert.match(answer.why, /not currently accepting connections/u);
  });
});

test('each copy starts as a new installation\'s store; a copy made again forgets what was written; one copy never sees another\'s rows', async (t) => {
  await live(t, async (cluster) => {
    // As a test process sees it: through the copy service.
    const copies = attachTestCluster(cluster.handle);
    const first = await copies.createDatabase();
    const second = await copies.createDatabase();
    assert.notEqual(first, second);
    const sites = async (database) => {
      const store = openStore(cluster.url(database));
      try {
        const workspaceId = await store.onlyWorkspace();
        assert.equal(workspaceId, cluster.workspaceId);
        return (await store.inWorkspace(workspaceId, (tx) => tx.query('SELECT asset_id FROM noticeos.assets ORDER BY asset_id'), { readOnly: true })).map((row) => row.asset_id);
      } finally {
        await store.close();
      }
    };
    const add = async (database, site) => {
      const store = openStore(cluster.url(database));
      try {
        await store.inWorkspace(cluster.workspaceId, (tx) =>
          tx.execute("INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status) VALUES ($1, $2, 'Site', 'live')", [tx.workspaceId, site]),
        );
      } finally {
        await store.close();
      }
    };
    assert.deepEqual(await sites(first), []);
    await add(first, 'one.example.com');
    assert.deepEqual(await sites(first), ['one.example.com']);
    assert.deepEqual(await sites(second), []);

    // The starting process may clear a copy as the owner, which the
    // application role may not (a test emptying a table between cases); never
    // the template.
    await add(second, 'two.example.com');
    await cluster.asOwner(second, 'TRUNCATE noticeos.assets CASCADE;');
    assert.deepEqual(await sites(second), []);
    await assert.rejects(cluster.asOwner(TEMPLATE_DATABASE, 'SELECT 1;'), TypeError);

    // A connection still open when the copy is made again is ended, not waited for.
    const held = new Client({ connectionString: cluster.url(first) });
    await held.connect();
    held.on('error', () => undefined);
    await copies.resetDatabase(first);
    assert.deepEqual(await sites(first), []);
    await assert.rejects(held.query('SELECT 1'));
    await held.end().catch(() => undefined);

    // The service takes only a copy's name, and says why it refused.
    for (const name of [TEMPLATE_DATABASE, 'postgres', 'noticeos_x_dev; DROP DATABASE postgres']) {
      await assert.rejects(copies.dropDatabase(name), TypeError, name);
      await assert.rejects(
        cluster.dropDatabase(name),
        (error) => error instanceof TypeError && /noticeos_<label>_dev/u.test(error.message),
        name,
      );
    }
    await copies.dropDatabase(first);
    await copies.dropDatabase(second);
    await assert.rejects(login(cluster.url(first)).then((answer) => (answer.ok ? null : Promise.reject(new Error(answer.why)))), /does not exist/u);
  });
});

test('a test can analyze only a copy, without owner credentials or statistics leaking into later fixtures', async (t) => {
  await live(t, async (cluster) => {
    const copies = attachTestCluster(cluster.handle);
    const first = await copies.createDatabase();
    const second = await copies.createDatabase();
    const estimate = async (name) => (await cluster.asOwner(name,
      "SELECT reltuples::integer AS rows FROM pg_class WHERE oid = 'noticeos.assets'::regclass"))[0].rows;
    const oid = async (name) => (await cluster.asOwner(name,
      'SELECT oid::text AS oid FROM pg_database WHERE datname = current_database()'))[0].oid;
    try {
      const originalEstimate = await estimate(second);
      const firstOid = await oid(first);
      const store = openStore(copies.url(first));
      try {
        await store.inWorkspace(cluster.workspaceId, tx => tx.execute(
          "INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status) SELECT $1, 'site-' || n || '.example', 'Site', 'live' FROM generate_series(1, 200) n",
          [tx.workspaceId],
        ));
      } finally { await store.close(); }
      await copies.analyzeDatabase(first);
      assert.equal(await estimate(first), 200);
      assert.equal(await estimate(second), originalEstimate, 'another copy is not analyzed');
      assert.deepEqual(Object.keys(cluster.handle).sort(), ['appUrl', 'copyService', 'workspaceId']);
      for (const name of [TEMPLATE_DATABASE, 'postgres', 'noticeos_x_dev; ANALYZE']) {
        await assert.rejects(copies.analyzeDatabase(name), TypeError);
        await assert.rejects(cluster.analyzeDatabase(name), TypeError);
      }
      await copies.releaseDatabase(first);
      const replacement = await copies.createDatabase();
      try {
        assert.notEqual(await oid(replacement), firstOid, 'column statistics cannot survive through copy reuse');
        assert.equal(await estimate(replacement), originalEstimate);
      } finally { await copies.dropDatabase(replacement); }
    } finally {
      await copies.dropDatabase(first);
      await copies.dropDatabase(second);
    }
  });
});

// The process that holds the cluster is Vitest's or Playwright's own: a copy
// made there must never stop it answering its test processes. A blocking call
// would finish the copy before the immediate below could run; and each request
// to the copy service is answered on a connection of its own, which the
// service then closes.
test("the owner's operations never block the process that holds them, and the copy service keeps no connection open", async (t) => {
  await live(t, async (cluster) => {
    let turned = 0;
    // Named, so each is made now rather than taken from the spares.
    const made = Promise.all(['noticeos_turn_a_dev', 'noticeos_turn_b_dev', 'noticeos_turn_c_dev'].map((name) => cluster.createDatabase(name)));
    const turns = setInterval(() => {
      turned += 1;
    }, 0);
    const names = await made;
    clearInterval(turns);
    assert.ok(turned > 0, 'the event loop turned while the copies were made');
    assert.equal(new Set(names).size, 3);
    // File setup resets a copy, and test cleanup runs owner statements. A
    // queued immediate must run before either operation answers; a blocking
    // implementation resolves before it can run, failing this proof directly.
    for (const [label, operation] of [
      ['reset', () => cluster.resetDatabase(names[0])],
      ['owner', () => cluster.asOwner(names[0], 'SELECT 1')],
      ['analyze', () => cluster.analyzeDatabase(names[0])],
    ]) {
      let responsive = false;
      const immediate = new Promise((resolve) => setImmediate(() => { responsive = true; resolve(); }));
      await operation();
      assert.equal(responsive, true, `the event loop turned during ${label}`);
      await immediate;
    }
    await Promise.all(names.map((name) => cluster.dropDatabase(name)));

    const answer = await new Promise((resolve, reject) => {
      const call = http.request({ socketPath: cluster.handle.copyService, path: '/copies', method: 'POST', agent: false }, (response) => {
        response.resume();
        response.on('end', () => resolve({ status: response.statusCode, connection: response.headers.connection }));
      });
      call.on('error', reject);
      call.end(JSON.stringify({ op: 'drop', name: 'noticeos_never_made_dev' }));
    });
    assert.deepEqual(answer, { status: 200, connection: 'close' });
  });
});

// A copy a test gives back is handed to the next test that asks: it must be as
// good as a new one (every table the template leaves empty empty, every
// sequence where the template leaves it) and nothing that held it before may
// reach it again.
test('a copy given back is handed out again under a new name, as empty as a new copy, and unreachable by its old name', async (t) => {
  await live(t, async (cluster) => {
    const copies = attachTestCluster(cluster.handle);
    // What a copy holds, read as the owner: each table's rows and each sequence's place.
    const contents = async (database) => {
      const tables = await cluster.asOwner(
        database,
        `SELECT format('%I.%I', schemaname, tablename) AS name,
                (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text AS n
           FROM pg_tables WHERE schemaname = 'noticeos' ORDER BY 1`,
      );
      const sequences = await cluster.asOwner(
        database,
        "SELECT sequencename AS name, last_value::text AS at FROM pg_sequences WHERE schemaname = 'noticeos' ORDER BY 1",
      );
      return { tables, sequences };
    };
    // A database keeps its identity through a rename; a new one gets another.
    const identity = async (database) => (await cluster.asOwner(database, 'SELECT oid::text AS oid FROM pg_database WHERE datname = current_database()'))[0].oid;

    const used = await copies.createDatabase();
    const store = openStore(cluster.url(used));
    await store.inWorkspace(cluster.workspaceId, (tx) =>
      tx.execute("INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status) VALUES ($1, 'used.example.com', 'Used', 'live')", [tx.workspaceId]),
    );
    const [sequence] = await cluster.asOwner(used, "SELECT format('%I.%I', schemaname, sequencename) AS name FROM pg_sequences WHERE schemaname = 'noticeos' ORDER BY 1 LIMIT 1");
    await cluster.asOwner(used, `SELECT nextval('${sequence.name}'), nextval('${sequence.name}')`);
    const held = new Client({ connectionString: cluster.url(used) });
    held.on('error', () => undefined);
    await held.connect();
    const before = await identity(used);

    await copies.releaseDatabase(used);
    await assert.rejects(held.query('SELECT 1'), 'a connection the test left open is ended');
    await held.end().catch(() => undefined);
    await store.close();
    await assert.rejects(login(cluster.url(used)).then((answer) => (answer.ok ? null : Promise.reject(new Error(answer.why)))), /does not exist/u);

    // Once it is emptied it waits among the spares; take them until it comes.
    await cluster.settled();
    const taken = [];
    let again = null;
    while (again === null && taken.length < 8) {
      const next = await copies.createDatabase();
      taken.push(next);
      if ((await identity(next)) === before) again = next;
    }
    assert.ok(again, 'the copy given back is handed out again, not only new ones');
    assert.notEqual(again, used);
    const fresh = await cluster.createDatabase('noticeos_fresh_dev');
    assert.deepEqual(await contents(again), await contents(fresh));
    await Promise.all([...taken.map((name) => copies.dropDatabase(name)), cluster.dropDatabase(fresh)]);
  });
});

// Once a run hands out unnamed copies, spares wait ready, so a test that asks
// takes one without waiting for a copy to be made.
test('spares wait ready once copies are handed out, each as new as a copy just made', async (t) => {
  await live(t, async (cluster) => {
    const copies = attachTestCluster(cluster.handle);
    await copies.releaseDatabase(await copies.createDatabase());
    await cluster.settled();
    const fresh = await cluster.createDatabase('noticeos_fresh_spare_dev');
    const existing = new Set((await cluster.asOwner(fresh, 'SELECT datname FROM pg_database')).map((row) => row.datname));
    const ready = await Promise.all([copies.createDatabase(), copies.createDatabase(), copies.createDatabase()]);
    // Three asked for at once, all three already made: none was made while the test waited.
    for (const name of ready) assert.equal(existing.has(name), true, `${name} was waiting ready`);
    const rows = async (database) =>
      cluster.asOwner(database, 'SELECT (SELECT count(*)::int FROM noticeos.assets) AS sites, (SELECT count(*)::int FROM noticeos.workspaces) AS workspaces');
    for (const name of ready) assert.deepEqual(await rows(name), await rows(fresh), name);
    await Promise.all([...ready.map((name) => copies.dropDatabase(name)), cluster.dropDatabase(fresh)]);
  });
});

// Proven by the cluster's own server process, which nothing else owns: its TCP
// port, freed, can be taken at once by another test file's cluster in the same
// port range.
test('closing stops the server and removes its folder', async (t) => {
  await live(t, async () => {
    const own = mkdtempSync(path.join(os.tmpdir(), 'nos-cluster-close-'));
    let server = null;
    try {
      const cluster = await startTestCluster({ parent: own });
      const [root] = readdirSync(own);
      assert.equal(readdirSync(own).length, 1);
      // The first line of postmaster.pid is the server's own process.
      server = Number(readFileSync(path.join(own, root, 'cluster', 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);
      assert.equal(processAlive(server), true, 'the server runs before close');
      cluster.close();
      assert.equal(processAlive(server), false, `the server (process ${server}) has stopped`);
      assert.deepEqual(readdirSync(own), []);
      assert.equal(existsSync(cluster.handle.copyService), false, 'the copy service is gone');
    } finally {
      // A server close() left running is stopped when this process exits
      // (scripts/postgres-dev.mjs), which needs its folder until then.
      if (server === null || !processAlive(server)) rmSync(own, { recursive: true, force: true });
    }
  });
});
