import assert from 'node:assert/strict';
import { lifecycleMoveRef } from './config-apply-core.mjs';
import test from 'node:test';
import {
  MISSING,
  parseArgs,
  resolve,
  storeLane,
  validateSchemaAndSafety,
} from './config-apply.mjs';
import { DEFAULT_DOOR } from './ingest-door.mjs';

// config:apply is the operator's changeset tool and it is a WRITER, run by hand
// beside a live `os:up`. These tests exercise both halves of its store lane —
// the expect guard's read and the apply's write — against a stubbed door, so the
// lane is proven without ever touching the machine's real store (bead ro-bko).

/**
 * The ingest's asset-state and annotation routes, as far as this script can
 * tell. `rows` is the store: absent keys are assets the store does not have,
 * and `annotations` is the timeline the move is recorded on.
 */
function stubDoor(rows = { 'meals.example': { status: 'onboarding', sense_only: 0, display_name: 'Meal Planner' } }, options = {}) {
  const calls = [];
  const annotations = [];
  const store = { ...rows };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const { pathname } = new URL(url);
    if ((init.method ?? 'GET') === 'GET') {
      const asset = new URL(url).searchParams.get('asset');
      const columns = store[asset] ?? null;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          asset,
          known: columns !== null,
          columns: structuredClone(columns),
          updatedAt: columns === null ? null : '2026-07-05T00:00:00.000Z',
        }),
      };
    }
    if (pathname === '/api/annotations') {
      if (options.refuseAnnotations) {
        return { ok: false, status: 422, text: async () => '{"error":"unknown_asset"}' };
      }
      const row = { id: annotations.length + 1, ...JSON.parse(init.body) };
      annotations.push(row);
      return { ok: true, status: 201, json: async () => ({ created: true, annotation: row }) };
    }
    const edit = JSON.parse(init.body);
    const { asset, column, value, expect: expected } = edit;
    if (Object.hasOwn(edit, 'expect') && store[asset]?.[column] !== expected) {
      return { ok: false, status: 409, text: async () => JSON.stringify({ error: 'expect_mismatch', column, current: store[asset]?.[column] }) };
    }
    store[asset] = { ...store[asset], [column]: value };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        updated: true,
        asset,
        column,
        value,
        updatedAt: '2026-08-03T12:00:00.000Z',
      }),
    };
  };
  return { fetchImpl, calls, store, annotations };
}

/** Only the calls that reached one route with one method, so a test about the
 * column write is not rewritten every time the read or the timeline lane grows a
 * request of its own. */
function callsTo(calls, pathname, method = 'POST') {
  return calls.filter(
    (call) => new URL(call.url).pathname === pathname && (call.init.method ?? 'GET') === method,
  );
}

function storeOp(overrides = {}) {
  return {
    kind: 'store-asset-set',
    asset: 'meals.example',
    column: 'status',
    expect: 'onboarding',
    value: 'baselining',
    ...overrides,
  };
}

function changeset(ops) {
  return { version: 1, slug: 'test-changeset', createdAt: '2026-08-03T00:00:00.000Z', ops };
}

test('parseArgs: local by default, aimed at the loopback door', () => {
  const opts = parseArgs(['changeset.json']);
  assert.equal(opts.remote, false);
  assert.equal(opts.door, DEFAULT_DOOR);
  assert.equal(opts.file, 'changeset.json');
});

test('parseArgs: the existing flags are unchanged', () => {
  const opts = parseArgs(['--stdin', '--dry-run', '--yes', '--remote']);
  assert.deepEqual(
    { stdin: opts.stdin, dryRun: opts.dryRun, yes: opts.yes, remote: opts.remote },
    { stdin: true, dryRun: true, yes: true, remote: true },
  );
  assert.equal(parseArgs(['--door', 'http://door.test']).door, 'http://door.test');
  assert.throws(() => parseArgs(['--door']), /--door needs a url/);
});

test('the expect guard reads the store through the operator-authed door', async () => {
  const { fetchImpl, calls } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });

  assert.equal(await store.column('meals.example', 'status'), 'onboarding');
  assert.equal(await store.column('meals.example', 'sense_only'), 0);

  // One asset, one read: the second column comes out of the row already fetched.
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, 'http://door.test/api/asset-state?asset=meals.example');
  assert.equal(init.headers.authorization, 'Bearer op');
});

test('an asset the store does not have reads as absent, not as a crash', async () => {
  const { fetchImpl } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });
  assert.equal(await store.column('not-a-property.test', 'status'), MISSING);
});

test('the apply writes one edit per op through the door', async () => {
  const { fetchImpl, calls, store: rows } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });

  await store.set('meals.example', 'status', 'baselining');
  await store.set('meals.example', 'sense_only', 1);

  const edits = callsTo(calls, '/api/asset-state');
  assert.equal(edits.length, 2);
  assert.deepEqual(
    edits.map(({ url, init }) => ({
      url,
      method: init.method,
      auth: init.headers.authorization,
      type: init.headers['content-type'],
      body: JSON.parse(init.body),
    })),
    [
      {
        url: 'http://door.test/api/asset-state',
        method: 'POST',
        auth: 'Bearer op',
        type: 'application/json',
        body: { asset: 'meals.example', column: 'status', value: 'baselining', expect: 'onboarding' },
      },
      {
        url: 'http://door.test/api/asset-state',
        method: 'POST',
        auth: 'Bearer op',
        type: 'application/json',
        body: { asset: 'meals.example', column: 'sense_only', value: 1, expect: 0 },
      },
    ],
  );
  assert.deepEqual(rows['meals.example'], { status: 'baselining', sense_only: 1, display_name: 'Meal Planner' });
  // The whole point: every call went through the door, the one runtime that
  // owns the store.
  assert.ok(calls.every(({ url }) => url.startsWith('http://door.test/')));
});

// ── the stage move is an EVENT, and the terminal records it (bead `ro-mz39`) ──
//
// `assets.status` says where an asset IS. Where it has BEEN lives on the
// annotation timeline, and Restore reads the most recent move into `retired` to
// decide which stage to bring an archived asset back to (bead `ro-3085`, commit
// f2ce513). The Tower wrote that row; this tool moved the column and wrote
// nothing, so an asset archived from the terminal came back to a labelled
// default instead of the stage it left.

test('a stage moved through the door is recorded on the timeline beside it', async () => {
  const { fetchImpl, calls, annotations } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });

  // The expect guard reads the row first, exactly as a real run does — which is
  // where `<from>` comes from.
  assert.equal(await store.column('meals.example', 'status'), 'onboarding');
  const recorded = await store.set('meals.example', 'status', 'retired');

  assert.deepEqual(
    annotations.map(({ asset, kind, ref }) => ({ asset, kind, ref })),
    [{ asset: 'meals.example', kind: 'config', ref: 'lifecycle:onboarding>retired' }],
  );
  assert.equal(recorded.ref, 'lifecycle:onboarding>retired');
  assert.equal(recorded.error, null);

  // Same lane, same operator bearer as the column write.
  const [post] = callsTo(calls, '/api/annotations');
  assert.equal(post.url, 'http://door.test/api/annotations');
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers.authorization, 'Bearer op');
  // `at` is an instant, not a placeholder: the row's identity is
  // (asset, at, kind, ref).
  assert.match(annotations[0].at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test('only the stage is an event — the other two columns record nothing', async () => {
  const { fetchImpl, annotations } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });

  assert.equal(await store.set('meals.example', 'sense_only', 1), null);
  assert.equal(await store.set('meals.example', 'display_name', 'Meal Planner'), null);
  assert.deepEqual(annotations, []);
});

test('the cached changeset guard reaches the writer and a concurrent edit records no lifecycle move', async () => {
  const { fetchImpl, store: rows, annotations } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });
  assert.equal(await store.column('meals.example', 'status'), 'onboarding');
  rows['meals.example'].status = 'retired';
  await assert.rejects(store.set('meals.example', 'status', 'live'), /HTTP 409.*expect_mismatch/);
  assert.equal(rows['meals.example'].status, 'retired');
  assert.deepEqual(annotations, []);
});

test('successive operations use the value returned by this runs previous write', async () => {
  const { fetchImpl, store: rows, annotations } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });
  await store.set('meals.example', 'status', 'baselining');
  await store.set('meals.example', 'status', 'live');
  assert.equal(rows['meals.example'].status, 'live');
  assert.equal(annotations.length, 2);
  assert.equal(annotations[1].ref, lifecycleMoveRef({ from: 'baselining', to: 'live' }));
});

test('a stage set to the stage it is already in is not a move', async () => {
  const { fetchImpl, annotations } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });

  assert.equal(await store.set('meals.example', 'status', 'onboarding'), null);
  assert.deepEqual(annotations, []);
});

test('a refused record does not undo the move it describes', async () => {
  const { fetchImpl, calls, store: rows } = stubDoor(undefined, { refuseAnnotations: true });
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });

  const recorded = await store.set('meals.example', 'status', 'retired');

  // The column moved; only the record of it did not — so the refusal comes back
  // to be printed rather than thrown, the same posture as the Tower's `record`
  // hook. Failing the run here would archive nothing and report a change that
  // happened as a change that did not.
  assert.equal(rows['meals.example'].status, 'retired');
  assert.equal(callsTo(calls, '/api/asset-state').length, 1);
  assert.equal(recorded.ref, 'lifecycle:onboarding>retired');
  assert.match(recorded.error, /\/api\/annotations answered HTTP 422/);
});

test('a rejected edit surfaces the ingest’s own words', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 422,
    text: async () => '{"error":"validation","issues":[{"path":"column"}]}',
  });
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });
  await assert.rejects(
    store.set('meals.example', 'display_name', 'nope'),
    /\/api\/asset-state answered HTTP 422 — .*validation/,
  );
});

test('a door that does not answer names the fix', async () => {
  const fetchImpl = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8791');
  };
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });
  await assert.rejects(store.column('meals.example', 'status'), /Is `pnpm os:up` running\?/);
});

test('resolve: a store op that still matches reality passes the guard', async () => {
  const { fetchImpl } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });
  const { resolved, mismatches } = await resolve(changeset([storeOp()]), store);

  assert.deepEqual(mismatches, []);
  assert.equal(resolved[0].current, 'onboarding');
});

test('resolve: a store op staged against a stale value is refused', async () => {
  const { fetchImpl } = stubDoor({ 'meals.example': { status: 'live', sense_only: 0 } });
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });
  const { mismatches } = await resolve(changeset([storeOp()]), store);

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].current, 'live');
  assert.equal(mismatches[0].expect, 'onboarding');
});

test('resolve: an op against an asset the store never had is a mismatch', async () => {
  const { fetchImpl } = stubDoor();
  const store = storeLane({ door: 'http://door.test', fetchImpl, token: 'op' });
  const { mismatches } = await resolve(
    changeset([storeOp({ asset: 'not-a-property.test' })]),
    store,
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].current, MISSING);
});

// The SAFETY allowlist is unchanged by the port — it is still the boundary that
// decides what a changeset may name, before anything reaches the store at all.
test('the safety allowlist still refuses an unsanctioned column', () => {
  assert.throws(
    () => validateSchemaAndSafety(changeset([storeOp({ column: 'domain', value: 'x.test' })])),
    /not store-editable/,
  );
  assert.throws(
    () => validateSchemaAndSafety(changeset([storeOp({ value: 'shipping' })])),
    /status must be one of/,
  );
  assert.throws(
    () =>
      validateSchemaAndSafety(
        changeset([storeOp({ column: 'sense_only', expect: 0, value: 2 })]),
      ),
    /sense_only must be 0 or 1/,
  );
});
