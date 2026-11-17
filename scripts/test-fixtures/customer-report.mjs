import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { openWorkspaceStore } from '../../packages/postgres/src/store.mjs';

const asset = 'fixture-app';
const reportMs = 60_000 * Math.floor(Date.now() / 60_000);

function archives(workspaceId, count, revision = false) {
  return Array.from({ length: count }, (_, offset) => {
    const integration = offset % 2 ? 'ga4' : 'gsc';
    const report = integration === 'ga4' ? 'pages-screens' : 'query';
    const found = revision ? 31 : (offset % 15) + 1;
    const reportDate = new Date(reportMs - (Math.floor(offset / 2) + 1) * 86400_000).toISOString().slice(0, 10);
    const collectedAt = `${reportDate}T12:00:00.000Z`;
    const rows = Array.from({ length: 40 }, (_, index) => integration === 'ga4'
      ? { dimensionValues: [{ value: `/topic-${index}` }], metricValues: [{ value: String(found + index) }] }
      : { keys: [`vegetable soup ${index}`], impressions: 400 + index, clicks: found + index, ctr: 0.05, position: 3.7 });
    const response = integration === 'ga4' ? { dimensionHeaders: [{ name: 'unifiedPagePathScreen' }],
      metricHeaders: [{ name: 'screenPageViews' }], rows } : { rows };
    const body = JSON.stringify({ schemaVersion: 1, asset, integration, report, reportDate, collectedAt,
      dataState: 'provider-final', providerRows: rows.length, providerTruncated: false,
      pages: [{ request: { dimensions: ['query'] }, response }] });
    const compressed = gzipSync(body), hash = createHash('sha256').update(body).digest('hex');
    const key = `workspaces/${workspaceId}/raw/${asset}/${integration}/${report}/${reportDate}-${hash}.json.gz`;
    return { key, hash, bytes: compressed.byteLength, compressed, report, integration, date: reportDate };
  });
}

function storeArchiveManifest(db, workspaceId, rows) {
  db.cluster.run(`INSERT INTO noticeos.archive_objects(workspace_id,object_key,content_sha256,object_bytes,first_stored_at)
      SELECT :'workspace'::uuid,key,hash,bytes,now() FROM jsonb_to_recordset(:'rows'::jsonb)
      AS x(key text,hash text,bytes integer);
    INSERT INTO noticeos.archive_runs(workspace_id,run_id,asset_id,integration,report,credential_ref,property_ref,report_date,
      requested_at,finished_at,status,data_state,schema_version,provider_rows,request_count,provider_truncated,object_seq,cost_state)
      SELECT :'workspace'::uuid,x.hash,:'asset',x.integration,x.report,'fixture','fixture',x.date,now(),now(),
      'success','provider-final',1,40,1,false,obj.object_seq,'unknown' FROM jsonb_to_recordset(:'rows'::jsonb)
      AS x(key text,hash text,integration text,report text,date date) JOIN noticeos.archive_objects obj
      ON obj.workspace_id=:'workspace'::uuid AND obj.object_key=x.key;`,
  { vars: { workspace: workspaceId, asset, rows: JSON.stringify(rows.map(({ compressed, ...row }) => row)) } });
}

export function prepareCustomerReports({ db, app }) {
  const [east, west] = app.workspaces;
  for (const binding of [east, west]) {
    db.cluster.run(`UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{assets}',
       jsonb_build_object(:'asset',jsonb_build_object('enabled',true)))::json
       WHERE workspace_id=:'workspace'::uuid AND document_key='signal-panels';
       UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{schedules,panel-refresh}',
       jsonb_build_object('enabled',:'enabled'::boolean,'cron','* * * * *'))::json
       WHERE workspace_id=:'workspace'::uuid AND document_key='constants';`,
    { vars: { asset, workspace: binding.workspaceId, enabled: String(binding === east) } });
  }
  const source = archives(east.workspaceId, 56);
  storeArchiveManifest(db, east.workspaceId, source);
  return source;
}

export async function prepareReportObjects(bucket, input) {
  for (const row of input) await bucket.put(row.key, row.compressed);
}

export async function verifyCustomerReports({ db, app, resources, cold, t }) {
  const [east, west] = app.workspaces;
  const read = () => db.cluster.sql(`SELECT workspace_id, payload::text FROM noticeos.asset_insight_snapshots ORDER BY generated_at`);
  const first = read();
  assert.equal(first.length, 1);
  assert.equal(first[0].workspace_id, east.workspaceId);
  assert.equal(JSON.parse(first[0].payload).sourceArchiveCount, 56);
  const good = JSON.parse(first[0].payload);
  const { reports, connectionString, bucket } = resources;
  const eastStore = openWorkspaceStore(connectionString, { workspaceId: east.workspaceId });
  const westStore = openWorkspaceStore(connectionString, { workspaceId: west.workspaceId });
  try {
    const input = { workspaceId: east.workspaceId, store: eastStore, asset, scheduledAt: good.generatedAt };
    const warm = await reports.run(input);
    assert.equal(warm.objectReads, 0);
    assert.equal(warm.publication.created, false);
    assert.deepEqual(read(), first);
    await assert.rejects(reports.run({ ...input, store: westStore }), /workspace unavailable/u);

    const revised = archives(east.workspaceId, 1, true);
    storeArchiveManifest(db, east.workspaceId, revised);
    const revisionInput = { ...input, scheduledAt: new Date(Date.parse(good.generatedAt) + 1000).toISOString() };
    await assert.rejects(reports.run(revisionInput), /HTTP 404/u);
    assert.deepEqual(read(), first);
    await prepareReportObjects(bucket, revised);
    const recovered = await reports.run(revisionInput);
    assert.equal(recovered.objectReads, 1);
    assert.equal(recovered.publication.created, true);
    assert.equal(read().length, 2);
    const journal = db.cluster.sql(`SELECT workspace_id,state FROM noticeos.hosted_job_occurrences WHERE lane='panel-refresh'`);
    assert.deepEqual(journal, [{ workspace_id: east.workspaceId, state: 'succeeded' }]);
    const root = path.join(db.customer, 'reports', east.workspaceId, 'reports', `${asset}.reports`);
    assert.ok(!readdirSync(root).some(name => name.startsWith('.staging')));
    assert.ok(!readdirSync(path.join(db.customer, 'reports', east.workspaceId, 'history', asset)).some(name => name.startsWith('.spill')));
    const costs = ({ elapsedMs, objectReads, objectBytes, cost }) => ({ elapsedMs, objectReads, objectBytes, ...cost });
    t.diagnostic(`Report cold ${JSON.stringify(costs(cold))}. Warm ${JSON.stringify(costs(warm))}.`);
  } finally { await Promise.all([eastStore.close(), westStore.close()]); }
}
