import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { REPO_ROOT } from '../test-config-isolation.mjs';
import { openWorkspaceStore } from '../../packages/postgres/src/store.mjs';

const zone = 'Europe/Paris';
const reason = 'Set the reporting time zone';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const audit = [{ kind: 'file-json-set', file: 'config/constants.json', pointer: '/os_time_zone', expect: 'UTC', value: zone }];
const archiveRowsSql = `SELECT o.object_key,o.content_sha256,o.object_bytes,o.first_stored_at,
    r.run_id,r.asset_id,r.integration,r.report,r.report_date,r.requested_at,r.finished_at,r.credential_ref,r.property_ref
  FROM noticeos.archive_runs r JOIN noticeos.archive_objects o USING (workspace_id,object_seq) ORDER BY o.object_key`;

function addArchive(database, workspace, row) {
  database.run(`WITH object AS (
      INSERT INTO noticeos.archive_objects(workspace_id,object_key,content_sha256,object_bytes,first_stored_at)
      VALUES (:'workspace'::uuid,:'object_key',:'content_sha256',:'object_bytes'::bigint,:'first_stored_at'::timestamptz)
      RETURNING object_seq
    )
    INSERT INTO noticeos.archive_runs(workspace_id,run_id,asset_id,integration,report,report_date,requested_at,finished_at,
      credential_ref,property_ref,status,data_state,schema_version,provider_rows,request_count,provider_truncated,object_seq,cost_state)
    SELECT :'workspace'::uuid,:'run_id',:'asset_id',:'integration',:'report',:'report_date'::date,
      :'requested_at'::timestamptz,:'finished_at'::timestamptz,:'credential_ref',:'property_ref','success',
      'provider-final',1,1,1,false,object_seq,'unknown' FROM object;`, { vars: { workspace, ...row } });
}

function settings(database) {
  return database.sql(`SELECT version, updated_by, updated_at, body->>'os_time_zone' AS zone
    FROM noticeos.config_documents WHERE document_key='constants'`);
}
function settingAudit(database) {
  return database.sql(`SELECT document_key, version_before, version_after, actor, reason, changed_at, ops::text
    FROM noticeos.config_changes WHERE document_key='constants' AND version_after=2`);
}
function counts(database) {
  const [row] = database.sql(`SELECT
    (SELECT count(*) FROM noticeos.assets) AS assets, (SELECT count(*) FROM noticeos.pulses) AS reports,
    (SELECT count(*) FROM noticeos.config_documents) AS settings, (SELECT count(*) FROM noticeos.config_changes) AS audits,
    (SELECT count(*) FROM noticeos.archive_runs) AS runs, (SELECT count(*) FROM noticeos.archive_objects) AS objects,
    (SELECT count(*) FROM noticeos.integration_connections) AS connections, (SELECT count(*) FROM noticeos.connection_secrets) AS secrets,
    (SELECT count(*) FROM noticeos.hosted_job_occurrences) AS jobs`);
  return Object.fromEntries(Object.entries(row).map(([key, count]) => [key, Number(count)]));
}
function credentialProof(database) {
  return database.sql(`SELECT c.provider,c.connection_id,c.updated_at,s.secret_version,s.created_at,
      encode(sha256(s.ciphertext),'hex') AS fingerprint
    FROM noticeos.integration_connections c JOIN noticeos.connection_secrets s USING (workspace_id,connection_id)`);
}

async function loadArchiveReaders(root) {
  const require = createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json'));
  const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
  const outfile = path.join(root, 'shadow-archive-readers.mjs');
  await build({ outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    stdin: { contents: "export { readPanelManifest, readPanelObject } from './panel-source.ts';", loader: 'ts',
      resolveDir: path.join(REPO_ROOT, 'workers/ingest/src') },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  return import(pathToFileURL(outfile));
}

/** Fixture-only helpers for one disposable source and its already authorized shadow. */
export async function shadowEvidence({ root, source, target, asset, date, at, workspaceId, taskConnection }) {
  // Keep the source event outside the feed's group of new-workspace defaults.
  const changedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const sourceKey = randomBytes(32).toString('base64');
  const connection = randomUUID();
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey('raw', Buffer.from(sourceKey, 'base64'), 'AES-GCM', false, ['encrypt']);
  const token = randomBytes(32).toString('base64url');
  const fields = taskConnection ?? { NTASKS_URL: 'https://offline.example.test', NTASKS_TOKEN: token };
  const plaintext = JSON.stringify(fields);
  const ciphertext = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  source.run(`INSERT INTO noticeos.config_documents(workspace_id,document_key,version,body,updated_at,updated_by)
    VALUES (:'workspace'::uuid,'constants',2,:'constants'::json,:'at'::timestamptz,'fixture-owner'),
           (:'workspace'::uuid,'tower',1,'{"fixture_source_only":true}',:'at'::timestamptz,'fixture-owner');
    INSERT INTO noticeos.config_changes(workspace_id,document_key,ops,reason,actor,version_before,version_after,changed_at)
    VALUES (:'workspace'::uuid,'constants',:'audit'::jsonb,:'reason','fixture-owner',1,2,:'at'::timestamptz);
    INSERT INTO noticeos.integration_connections(workspace_id,connection_id,provider,scope,created_at,updated_at)
    VALUES (:'workspace'::uuid,:'connection'::uuid,'ntasks','shared',:'at'::timestamptz,:'at'::timestamptz);
    INSERT INTO noticeos.connection_secrets(workspace_id,connection_id,secret_version,ciphertext,iv,key_version,field_names,created_at)
    VALUES (:'workspace'::uuid,:'connection'::uuid,1,decode(:'ciphertext','hex'),decode(:'iv','hex'),1,
      :'fields'::jsonb,:'at'::timestamptz);`, { vars: { workspace: workspaceId, at: changedAt,
    audit: JSON.stringify(audit), reason, constants: JSON.stringify({ os_time_zone: zone, fixture_source_only: true }),
    connection, ciphertext: ciphertext.toString('hex'), iv: iv.toString('hex'), fields: JSON.stringify(Object.keys(fields)) } });
  const ownKey = `workspaces/${workspaceId}/raw/${asset}/gsc/query/fixture.json.gz`;
  const legacyKey = `raw/${asset}/gsc/page/fixture.json.gz`;
  const archives = new Map();
  for (const [objectKey, report] of [[ownKey, 'query'], [legacyKey, 'page']]) {
    const canonical = { schemaVersion: 1, provider: 'google', integration: 'gsc', report, asset, credentialRef: 'fixture-history',
      propertyRef: 'sc-domain:canopy.example', reportDate: date, dataState: 'provider-final', providerRows: 1, providerTruncated: false,
      pages: [{ rows: [{ keys: ['test report'], clicks: 7, impressions: 70 }] }] };
    const body = JSON.stringify({ ...canonical, collectedAt: at });
    const bytes = gzipSync(body);
    archives.set(objectKey, bytes);
    addArchive(source, workspaceId, { object_key: objectKey, content_sha256: sha256(JSON.stringify(canonical)), object_bytes: String(bytes.byteLength),
      first_stored_at: at, run_id: `fixture-${report}`, asset_id: asset, integration: 'gsc', report,
      report_date: date, requested_at: at, finished_at: at, credential_ref: 'fixture-history', property_ref: 'sc-domain:canopy.example' });
  }
  const before = counts(source), originalRows = source.sql(archiveRowsSql), originalSettings = settings(source);
  const originalAudit = settingAudit(source), originalCredential = credentialProof(source);
  async function readableArchive(bucket, body, key) {
    const object = await bucket.get(key);
    assert.ok(object);
    assert.deepEqual(Buffer.from(await object.arrayBuffer()), body);
  }
  function verifyArchiveBody(body, expectedHash) {
    const { collectedAt, ...canonical } = JSON.parse(body);
    assert.equal(collectedAt, at);
    assert.equal(sha256(JSON.stringify(canonical)), expectedHash);
  }
  return {
    sourceKey, zone, reason, changedAt, ownKey, legacyKey, before,
    initializeSourceBucket: async bucket => {
      for (const [key, bytes] of archives) await bucket.put(key, bytes, { httpMetadata: { contentEncoding: 'gzip', contentType: 'application/json' } });
    },
    async readSourceArchives({ bucket, databaseUrl, profile }) {
      const { readPanelManifest, readPanelObject } = await loadArchiveReaders(root);
      const store = openWorkspaceStore(databaseUrl, { workspaceId });
      try {
        const env = { NOTICEOS_WORKSPACE_PROFILE: profile, STORE: store, RAW_SIGNALS: bucket };
        const keys = (await readPanelManifest(env, asset)).map(row => row.objectKey).sort();
        for (const key of keys) {
          verifyArchiveBody(await readPanelObject(env, key), originalRows.find(row => row.object_key === key).content_sha256);
        }
        assert.equal(await readPanelObject(env, `workspaces/${randomUUID()}/raw/elsewhere.json.gz`), null);
        return keys;
      } finally { await store.close(); }
    },
    verifyPreservedStorage: async bucket => {
      assert.deepEqual(source.sql(archiveRowsSql), originalRows);
      const existing = new Set(originalCredential.map(row => row.connection_id));
      assert.deepEqual(credentialProof(source).filter(row => existing.has(row.connection_id)), originalCredential);
      for (const [archive, bytes] of archives) await readableArchive(bucket, bytes, archive);
    },
    async copy({ sourceBucket, shadowBucket, sourceUrl, shadowUrl }) {
      const { readPanelManifest, readPanelObject } = await loadArchiveReaders(root);
      const sourceStore = openWorkspaceStore(sourceUrl, { workspaceId });
      const shadowStore = openWorkspaceStore(shadowUrl, { workspaceId });
      try {
        assert.deepEqual((await shadowBucket.list()).objects, []);
        const sourceEnv = { NOTICEOS_WORKSPACE_PROFILE: 'standalone', STORE: sourceStore, RAW_SIGNALS: sourceBucket };
        const unscoped = await readPanelManifest(sourceEnv, asset);
        assert.deepEqual(new Set(unscoped.map(row => row.objectKey)), new Set(archives.keys()));
        assert.ok(await readPanelObject(sourceEnv, legacyKey));
        const scopedSource = { ...sourceEnv, NOTICEOS_WORKSPACE_PROFILE: 'hosted' };
        const allowed = await readPanelManifest(scopedSource, asset);
        assert.deepEqual(allowed.map(row => row.objectKey), [ownKey]);
        assert.equal(await readPanelObject({ ...scopedSource, RAW_SIGNALS: {
          get: () => assert.fail('A hosted reader cannot reach ambiguous legacy bytes'),
        } }, legacyKey), null);
        const opened = await sourceBucket.get(ownKey);
        const bytes = Buffer.from(await opened.arrayBuffer());
        assert.deepEqual(bytes, archives.get(ownKey));
        verifyArchiveBody(await readPanelObject(scopedSource, ownKey), allowed[0].contentSha256);
        await shadowBucket.put(ownKey, bytes, { httpMetadata: opened.httpMetadata });
        addArchive(target, workspaceId, originalRows.find(row => row.object_key === ownKey));
        const saved = originalSettings[0], change = originalAudit[0];
        target.run(`BEGIN;
          UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{os_time_zone}',to_jsonb(:'zone'::text))::json,
            version=:'version'::int,updated_by=:'actor',updated_at=:'changedAt'::timestamptz
            WHERE workspace_id=:'workspace'::uuid AND document_key='constants' AND version=1;
          INSERT INTO noticeos.config_changes(workspace_id,document_key,ops,reason,actor,version_before,version_after,changed_at)
          VALUES (:'workspace'::uuid,'constants',:'ops'::jsonb,:'reason',:'actor',1,2,:'changedAt'::timestamptz);
          COMMIT;`, { vars: { workspace: workspaceId, zone: saved.zone, version: saved.version, actor: change.actor,
          changedAt: change.changed_at, ops: change.ops, reason: change.reason } });
        assert.deepEqual(settings(target), originalSettings);
        assert.deepEqual(settingAudit(target), originalAudit);
        assert.deepEqual(target.sql("SELECT document_key FROM noticeos.config_documents WHERE body::jsonb ? 'fixture_source_only'"), []);
        const env = { NOTICEOS_WORKSPACE_PROFILE: 'hosted', STORE: shadowStore, RAW_SIGNALS: shadowBucket };
        assert.deepEqual(await readPanelManifest(env, asset), allowed);
        verifyArchiveBody(await readPanelObject(env, ownKey), allowed[0].contentSha256);
        assert.equal(await readPanelObject(env, legacyKey), null);
        assert.equal(await shadowBucket.head(legacyKey), null);
        assert.deepEqual((await shadowBucket.list()).objects.map(object => object.key), [ownKey]);
        await readableArchive(shadowBucket, bytes, ownKey);
        assert.deepEqual(target.sql(archiveRowsSql), originalRows.filter(row => row.object_key === ownKey));
        return counts(target);
      } finally { await Promise.all([sourceStore.close(), shadowStore.close()]); }
    },
    targetCounts: () => counts(target),
    verifyReconnection: () => {
      const [current] = credentialProof(target);
      assert.equal(current?.provider, 'ntasks');
      assert.equal(current?.secret_version, '1');
      assert.notEqual(current?.connection_id, originalCredential[0].connection_id);
      assert.notEqual(current?.fingerprint, originalCredential[0].fingerprint);
    },
    verifyRollback: async bucket => {
      assert.deepEqual(counts(source), before);
      assert.deepEqual(settings(source), originalSettings);
      assert.deepEqual(settingAudit(source), originalAudit);
      assert.deepEqual(source.sql(archiveRowsSql), originalRows);
      assert.deepEqual(credentialProof(source), originalCredential);
      assert.deepEqual(new Set((await bucket.list()).objects.map(object => object.key)), new Set(archives.keys()));
      for (const [archive, bytes] of archives) await readableArchive(bucket, bytes, archive);
    },
  };
}
