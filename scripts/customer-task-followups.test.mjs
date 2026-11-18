import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DATAFORSEO_BASE_REPORTS } from '../packages/contract/src/signal-families.mjs';
import { verifyComposeCustomerFollowups } from '../deploy/compose/customer-entry.mjs';
import { localCustomerTaskFollowups } from './local-customer-task-followups.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { customerCollectionPolicy } from './customer-collection-policy.mjs';
import { demoNtasks } from './demo-ntasks.mjs';
import { panelVersionId } from './panel-versions.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { openBackupNtasks, sealedProviderSql } from './test-fixtures/customer-backup.mjs';

const pinned = process.env.NOTICEOS_NTASKS_ROOT;

test('automatic follow-ups use the granted external project, published evidence and stable replay keys', { skip: !pinned, timeout: 120000 }, async t => {
  const root = testFixtureRoot('n-customer-followups-');
  const workspaceId = randomUUID(), serviceId = randomUUID(), filingId = randomUUID(), key = randomBytes(32).toString('base64');
  const asset = 'example-site', windowId = randomUUID(), binding = { workspaceId, serviceId };
  let tasks, db, scheduler;
  try {
    const plan = startPlan({ dir: path.join(root, 'customer'), port: await availableCustomerPort() });
    fs.mkdirSync(plan.home, { recursive: true });
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(plan, { profile: 'hosted' }));
    if (!db) return;
    tasks = await openBackupNtasks(path.join(root, 'tasks'), pinned);
    const clock = new Date(); clock.setUTCMinutes(25, 0, 0);
    const at = clock.toISOString(), day = at.slice(0, 10);
    const time = () => clock.getTime();
    const config = { spokes: [{ asset, prefix: 'backup' }] };
    db.cluster.run(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES (:'ws'::uuid,'fixture','Fixture','active');
      INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
      VALUES (:'service'::uuid,:'ws'::uuid,ARRAY['workflows.run'],now()+interval '1 day'),
        (:'filing'::uuid,:'ws'::uuid,ARRAY['workflows.run','tasks.write'],now()+interval '1 day');
      INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position) VALUES(:'ws'::uuid,:'asset','Fixture','live',1);
      INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_by,updated_at) VALUES
        (:'ws'::uuid,'beads',:'cfg'::json,1,'fixture',now()),
        (:'ws'::uuid,'constants','{"schedules":{"panel-review":{"enabled":true,"cron":"* * * * *"},"watch-readbacks":{"enabled":true,"cron":"* * * * *"},"watch-windows":{"enabled":false,"cron":"30 3 * * *"}}}',1,'fixture',now());
      INSERT INTO noticeos.watch_windows(workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, registered_at,
        baseline_start,baseline_end,check_offsets,status,outcome,closed_at,readback_bead)
        VALUES(:'ws'::uuid,:'window',:'asset','manual','fixture','gsc','position',now()-interval '8 days',
        current_date-16,current_date-9,'{7}','closed','inconclusive',now()-interval '1 day',:'task');`,
      { vars: { ws: workspaceId, service: serviceId, filing: filingId, asset, cfg: JSON.stringify(config), window: windowId, task: tasks.task.id } });
    const fields = { NTASKS_URL: tasks.origin, NTASKS_WORKSPACE_ID: tasks.workspaceId, NTASKS_TOKEN: tasks.token };
    db.cluster.run(sealedProviderSql(workspaceId, key, 'ntasks', fields));
    for (const report of DATAFORSEO_BASE_REPORTS) {
      db.cluster.run(`WITH saved AS (INSERT INTO noticeos.archive_objects(workspace_id, object_key, content_sha256,object_bytes,first_stored_at)
         VALUES (:'ws'::uuid,:'report',repeat('a',64),100,now()) RETURNING object_seq)
         INSERT INTO noticeos.archive_runs(workspace_id,run_id,asset_id,integration,report,credential_ref,property_ref,report_date,
          requested_at,finished_at,status,data_state,schema_version,provider_rows,request_count,provider_truncated,object_seq,cost_state)
         SELECT :'ws'::uuid,:'report',:'asset','dataforseo',:'report','fixture',:'asset',:'day'::date,now(),now(),'success','provider-snapshot',1,1,1,false,object_seq,'unknown' FROM saved`,
      { vars: { ws: workspaceId, asset, report, day } });
    }
    const reports = path.join(root, 'reports'); fs.mkdirSync(reports, { mode: 0o700 });
    const requests = [];
    let interruptComment = true;
    const followups = localCustomerTaskFollowups({ sourceRoot: plan.root, root: reports, credentialsKey: key, ntasksOrigin: tasks.origin,
      async transport(url, options) {
        assert.equal(new URL(url).origin, tasks.origin);
        const method = options.method;
        if (method === 'POST') requests.push(new URL(url).pathname);
        const response = await fetch(url, options);
        if (interruptComment && new URL(url).pathname.endsWith('/comments') && response.ok) {
          interruptComment = false; await response.body.cancel(); throw new Error('Lost acknowledgement');
        }
        return response;
      } });
    const client = demoNtasks({ origin: tasks.origin, workspaceId: tasks.workspaceId, token: tasks.token });
    const reviews = async () => (await client.call('GET', '/api/tasks?project=' + tasks.projectId + '&label=panel-review')).body.tasks;
    const commentCount = async () => (await client.tool('get_task', { task: tasks.task.id })).comments.length;
    const stamped = () => db.cluster.sql(`SELECT (readback_posted_at IS NOT NULL)::text AS done FROM noticeos.watch_windows WHERE window_id='${windowId}'`)[0].done;
    const collection = customerCollectionPolicy({ taskFollowups: [{ workspaceId, serviceId: filingId }] });
    const preflight = () => verifyComposeCustomerFollowups({ ...collection, workspaces: [binding], grantAddress: db.grantConnectionString });
    await preflight();
    const next = async () => {
      if (scheduler) await scheduler.close();
      scheduler = await startLocalCustomerSchedules({ workspaces: [binding], connectionString: db.address,
        grantConnectionString: db.grantConnectionString, now: time, taskFollowups: followups, collection,
        worker: { fetch: () => { throw new Error('Unexpected provider job.'); } } });
      await scheduler.whenIdle();
    };
    await next();
    assert.equal((await reviews()).length, 0, 'search review waits for the published version');
    assert.equal(await commentCount(), 1);
    assert.equal(stamped(), 'false');
    const version = panelVersionId(3, at), panelRoot = path.join(reports, workspaceId, 'reports');
    const versionDir = path.join(panelRoot, asset + '.reports', version);
    fs.mkdirSync(versionDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(versionDir,'freshness.json'), JSON.stringify({ asset, sources: [{ key: 'dataforseo', newestReportDate: day,
      reports: DATAFORSEO_BASE_REPORTS.map(report => ({ report, newestReportDate: day })) }] }));
    fs.symlinkSync(path.relative(panelRoot,versionDir),path.join(panelRoot,asset));
    clock.setUTCMinutes(clock.getUTCMinutes() + 1);
    await next();
    const filed = await reviews();
    assert.equal(filed.length, 1);
    assert.match(filed[0].id, /^backup-/u);
    assert.equal(filed[0].metadata.noticeos_panel_version, version);
    assert.equal(await commentCount(), 1); assert.equal(stamped(), 'true');
    const writes = requests.length;
    await next(); assert.equal(requests.length, writes);
    db.cluster.run(`UPDATE noticeos_platform.workspace_service_grants SET actions=ARRAY['workflows.run'] WHERE service_id='${filingId}'`);
    await assert.rejects(preflight(), /task grant/u);
    clock.setUTCMinutes(clock.getUTCMinutes() + 1); await next(); assert.equal(requests.length, writes);
    assert.equal((await reviews()).length, 1);
    db.cluster.run(`UPDATE noticeos_platform.workspace_service_grants SET actions=ARRAY['workflows.run','tasks.write'] WHERE service_id=:'filing'::uuid;
      UPDATE noticeos.config_documents SET body=:'mapping'::json,version=version+1 WHERE workspace_id=:'ws'::uuid AND document_key='beads';
      INSERT INTO noticeos.watch_windows(workspace_id, window_id, asset_id, ref_kind, ref, metric_integration, metric, registered_at,
        baseline_start,baseline_end,check_offsets,status,outcome,closed_at,readback_bead)
      SELECT workspace_id,:'fresh',asset_id,ref_kind,'remapped',metric_integration,metric,registered_at,
        baseline_start,baseline_end,check_offsets,status,outcome,closed_at,readback_bead FROM noticeos.watch_windows WHERE window_id=:'previous';`,
      { vars: { ws: workspaceId, filing: filingId, mapping: JSON.stringify({ spokes: [{ asset, prefix: 'ungranted' }] }),
        fresh: randomUUID(), previous: windowId } });
    clock.setUTCMinutes(clock.getUTCMinutes() + 1);
    await next();
    assert.equal(requests.length, writes);
    assert.equal(await commentCount(), 1);
    assert.equal(db.cluster.sql("SELECT count(*) FROM noticeos.watch_windows WHERE ref='remapped' AND readback_posted_at IS NULL")[0].count, '1');
  } finally {
    try { await scheduler?.close(); } finally {
      try { await tasks?.close(); } finally { db?.close(); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
