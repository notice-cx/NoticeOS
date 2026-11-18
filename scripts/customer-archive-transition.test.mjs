import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { archiveTransitionArgs, transitionCustomerArchive } from './customer-archive-transition.mjs';
import { localCustomerReports } from './local-customer-reports.mjs';
import { findPostgres } from './postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace } from './postgres-migrate.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { Miniflare, bundleWorkerFixture } from './worker-entry-test-fixture.mjs';

const asset = 'historical-site';
const archiveRoute = '/api/legacy-archives';
const manifestRoute = `/api/signal-archives?asset=${asset}`;
const checksum = value => createHash('sha256').update(value).digest('hex');

function sample(workspace, offset, prefix) {
  const date = new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10);
  const at = `${date}T01:00:00.000Z`;
  const pages = [{ request: { dimensions: ['query'] }, response: { rows: [
    { keys: [`stored search ${offset}`], clicks: offset + 2, impressions: 40, ctr: 0.05, position: 3 },
  ] } }];
  const canonical = { schemaVersion: 1, provider: 'google', integration: 'gsc', report: 'query', asset,
    credentialRef: 'fixture', propertyRef: 'fixture', reportDate: date, dataState: 'provider-final',
    providerRows: 1, providerTruncated: false, pages };
  const body = JSON.stringify({ ...canonical, collectedAt: at });
  const hash = checksum(JSON.stringify(canonical)), bytes = gzipSync(body);
  return { workspace, key: `${prefix}/${asset}/${date}-${hash}.json.gz`, date, at, hash, body, bytes };
}

function storeArchive(db, archive) {
  const { workspace, key, date, at, hash, bytes } = archive;
  db.run(`WITH obj AS (
      INSERT INTO noticeos.archive_objects(workspace_id,object_key,content_sha256,object_bytes,first_stored_at)
      VALUES (:'workspace'::uuid,:'key',:'hash',:'size'::bigint,:'at'::timestamptz) RETURNING object_seq
    )
    INSERT INTO noticeos.archive_runs(workspace_id,run_id,asset_id,integration,report,credential_ref,property_ref,report_date,
      requested_at,finished_at,status,data_state,schema_version,provider_rows,request_count,provider_truncated,object_seq,cost_state)
    SELECT :'workspace'::uuid,:'hash',:'asset','gsc','query','fixture','fixture',:'date'::date,:'at'::timestamptz,:'at'::timestamptz,
      'success','provider-final',1,1,1,false,object_seq,'unknown' FROM obj`,
  { vars: { workspace, asset, key, date, at, hash, size: String(bytes.byteLength) } });
}

function installAsset(db, workspace) {
  db.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position)
      VALUES (:'workspace'::uuid,:'asset','Historical site','live',1);
    INSERT INTO noticeos.config_documents(workspace_id,document_key,version,body,updated_at,updated_by)
      VALUES (:'workspace'::uuid,'constants',1,'{}',now(),'fixture'),
      (:'workspace'::uuid,'signal-panels',1,json_build_object('assets',json_build_object(:'asset',json_build_object('enabled',true))),now(),'fixture'),
      (:'workspace'::uuid,'value-events',1,'{"assets":{}}',now(),'fixture'),
      (:'workspace'::uuid,'integrations',1,'{"assets":{}}',now(),'fixture');`, { vars: { workspace, asset } });
}

test('same-store preparation survives restart and enables only the selected workspace to use original history', { timeout: 90_000 }, async t => {
  const root = testFixtureRoot('n-archive-transition-');
  let db, app, selected, other;
  try {
    db = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), findPostgres()));
    if (!db) return;
    applyMigrations(db);
    const { workspaceId } = bootstrapWorkspace(db, { slug: 'source' });
    installAsset(db, workspaceId);
    const foreign = randomUUID();
    const originals = Array.from({ length: 6 }, (_, index) => sample(workspaceId, index + 2, index % 2 ? 'signals' : 'raw'));
    const modern = sample(workspaceId, 1, `workspaces/${workspaceId}/raw`);
    for (const archive of [...originals, modern]) storeArchive(db, archive);
    const rows = () => db.sql('SELECT * FROM noticeos.archive_objects ORDER BY object_seq');
    const runs = () => db.sql('SELECT * FROM noticeos.archive_runs ORDER BY run_seq');
    const originalRows = rows(), originalRuns = runs();
    const login = db.applicationLogin();
    const operator = randomBytes(32).toString('hex');
    const runtime = await bundleWorkerFixture(root, 'legacy-archive-ingest', path.join(REPO_ROOT, 'workers/ingest/src/index.ts'));
    const start = () => new Miniflare({ ...runtime, host: '127.0.0.1', port: 0,
      bindings: { NOTICEOS_WORKSPACE_PROFILE: 'standalone', OPERATOR_TOKEN: operator },
      hyperdrives: { POSTGRES: login.url() }, r2Buckets: { RAW_SIGNALS: 'legacy-archive' },
      resourcePersistencePath: path.join(root, 'archive'), telemetry: { enabled: false },
      outboundService: () => assert.fail('Preparation cannot reach a provider'),
    });
    app = start();
    let door = (await app.ready).origin;
    let bucket = await app.getR2Bucket('RAW_SIGNALS');
    const call = (route, options = {}) => fetch(door + route, {
      ...options, headers: { authorization: `Bearer ${operator}`, ...options.headers }, signal: AbortSignal.timeout(30_000),
    });
    const object = key => call(`/api/panel-object?key=${encodeURIComponent(key)}`);
    const fixtureOptions = () => ({ door, token: () => operator, availableBytes: () => 50_000_000n });
    const list = async () => (await bucket.list()).objects.map(({ key, etag, size }) => ({ key, etag, size }));
    const archiveAlias = key => `workspaces/${workspaceId}/raw/legacy/${key}`;
    const bad = originals.at(-1);
    for (const entry of [...originals, modern]) await bucket.put(entry.key, entry.bytes);
    await bucket.put(bad.key, bad.bytes, { customMetadata: { workspaceId: foreign } });
    const unrelated = `workspaces/${foreign}/raw/unrelated.json.gz`;
    await bucket.put(unrelated, modern.bytes);
    const savedPayload = JSON.stringify({ schemaVersion: 1, asset, generatedAt: originals[0].at, sourceArchiveCount: 6, items: [] }, null, 1);
    const saved = await call('/api/insight-snapshot', { method: 'POST', body: savedPayload });
    assert.equal(saved.status, 201, await saved.clone().text());
    const { id } = await saved.json();
    const first = await list();
    assert.equal((await call(archiveRoute, { headers: { origin: 'https://fixture.example.test' } })).status, 403);
    assert.equal((await call(archiveRoute, { headers: { authorization: '' } })).status, 403);
    const plan = await transitionCustomerArchive(archiveTransitionArgs(['--plan']), fixtureOptions());
    const oldBytes = originals.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
    assert.equal(plan.workspaceId, workspaceId);
    assert.equal(plan.objects, originals.length);
    assert.equal(plan.bytes, oldBytes);
    assert.equal(plan.estimatedAdditionalNextBackupBytes, String(oldBytes + originals.length * 8192));
    assert.equal(plan.complete, false);
    assert.equal(plan.otherObjects, 0);
    assert.deepEqual(await list(), first);
    const preparation = workspace => archiveTransitionArgs(['--prepare', workspace, '--backup-bytes', '1000']);
    await assert.rejects(transitionCustomerArchive(preparation(foreign), fixtureOptions()), /different workspace/u);
    await assert.rejects(transitionCustomerArchive(preparation(workspaceId), { ...fixtureOptions(), availableBytes: () => 1000n }), /Allow at least/u);
    assert.deepEqual(await list(), first);
    const before = await (await call(manifestRoute)).json();
    assert.equal(before.manifest.length, originals.length + 1);
    assert.equal(await (await object(originals[0].key)).text(), originals[0].body);

    const batches = [];
    await assert.rejects(transitionCustomerArchive(preparation(workspaceId),
      { ...fixtureOptions(), onProgress: page => batches.push(page.verified) }), /differs from its manifest/u);
    assert.deepEqual(batches, [4]);
    const copied = (await list()).filter(item => item.key.startsWith(archiveAlias('')));
    assert.equal(copied.length, 5);
    assert.equal((await transitionCustomerArchive(archiveTransitionArgs(['--plan']), fixtureOptions())).verified, 4);
    await bucket.put(bad.key, bad.bytes);
    await app.dispose(); app = undefined;
    app = start();
    door = (await app.ready).origin;
    bucket = await app.getR2Bucket('RAW_SIGNALS');
    const complete = await transitionCustomerArchive(preparation(workspaceId), fixtureOptions());
    assert.equal(complete.complete, true);
    assert.equal(complete.verified, originals.length);
    const finished = await list();
    for (const copy of copied) assert.deepEqual(finished.find(item => item.key === copy.key), copy);
    for (const entry of originals) {
      const copy = await bucket.get(archiveAlias(entry.key));
      assert.ok(copy);
      assert.deepEqual(Buffer.from(await copy.arrayBuffer()), entry.bytes);
    }
    assert.deepEqual(rows(), originalRows);
    assert.deepEqual(runs(), originalRuns);
    assert.deepEqual(await (await call(manifestRoute)).json(), before);
    assert.equal(await (await object(originals[0].key)).text(), originals[0].body);
    assert.equal((await object(archiveAlias(originals[0].key))).status, 404);
    await transitionCustomerArchive(preparation(workspaceId), fixtureOptions());
    assert.deepEqual(await list(), finished);
    await app.dispose(); app = undefined;

    db.run(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status)
      VALUES (:'workspace'::uuid,'other','Other workspace','active')`, { vars: { workspace: foreign } });
    installAsset(db, foreign);
    // Even a same-key SQL row in another scope cannot make it use these bytes.
    storeArchive(db, { ...originals[0], workspace: foreign });
    app = start();
    door = (await app.ready).origin;
    bucket = await app.getR2Bucket('RAW_SIGNALS');
    assert.equal((await call(archiveRoute)).status, 503);
    selected = openWorkspaceStore(login.url(), { workspaceId });
    other = openWorkspaceStore(login.url(), { workspaceId: foreign });
    const stored = store => store.read(tx => tx.query('SELECT snapshot_id,payload::text FROM noticeos.asset_insight_snapshots ORDER BY generated_at'));
    assert.deepEqual(await stored(selected), [{ snapshot_id: id, payload: savedPayload }]);
    assert.deepEqual(await stored(other), []);
    const gets = [];
    const reportRoot = path.join(root, 'reports');
    mkdirSync(reportRoot, { mode: 0o700 });
    const reports = localCustomerReports({ sourceRoot: REPO_ROOT, root: reportRoot, bucket: {
      get(key) { gets.push(key); return bucket.get(key); }, head(key) { return bucket.head(key); },
    } });
    const time = new Date().toISOString();
    assert.equal(await reports.run({ store: other, workspaceId: foreign, asset, scheduledAt: time }), null);
    assert.ok(gets.every(key => key.startsWith(`workspaces/${foreign}/`)));
    gets.length = 0;
    const report = await reports.run({ store: selected, workspaceId, asset, scheduledAt: time });
    assert.equal(report.publication.created, true);
    assert.equal(report.objectReads, originals.length + 2);
    assert.equal(JSON.parse((await stored(selected)).at(-1).payload).sourceArchiveCount, originals.length + 1);
    assert.deepEqual((await stored(selected))[0], { snapshot_id: id, payload: savedPayload });
    assert.deepEqual(new Set(gets.filter(key => key.includes('/raw/'))), new Set([...originals.map(row => archiveAlias(row.key)), modern.key]));
    assert.ok(gets.every(key => key.startsWith(`workspaces/${workspaceId}/`)));
    assert.deepEqual(await list(), finished);
    t.diagnostic(`Original scoped bytes ${oldBytes}, expected added storage ${plan.estimatedAdditionalArchiveBytes}, hosted archive/receipt reads ${report.objectReads}.`);
  } finally {
    try { await Promise.all([selected?.close(), other?.close()]); }
    finally {
      try { await app?.dispose(); }
      finally { db?.close(); }
    }
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true });
  }
});
