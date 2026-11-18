import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { importShadowEvidence } from './customer-shadow-import.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { findPostgres } from './postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace } from './postgres-migrate.mjs';
import { POSTGRES_DUMP_FILE } from './postgres-backup.mjs';
import { releasedDefaultDocuments } from './released-defaults.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { prepareShadowDisplay } from './test-fixtures/customer-shadow-display.mjs';
import { parseWallConfig } from './wall-layout.mjs';

const executable = path.join(import.meta.dirname, 'customer-shadow-export.mjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const cli = (...args) => spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', timeout: 30_000 });
const noSecrets = /fixture-source-secret|fixture-unlisted-setting|fixture-unlisted-audit|foreign\.example|fixture-unlisted-field|fixture-provider-key|fixture-task-id/u;

test('offline transfer preserves workspace evidence through export, restore, import and replay', {
  timeout: 120_000,
}, async t => {
  const root = testFixtureRoot('n-shadow-export-');
  const tools = findPostgres();
  let pg, target;
  try {
    pg = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools));
    if (!pg) return;
    applyMigrations(pg);
    const { workspaceId } = bootstrapWorkspace(pg, { slug: 'shadow-source', displayName: 'Shadow source' });
    const foreign = randomUUID(), connection = randomUUID();
    const report = '{"generatedAt": "2026-10-02T23:30:00.000Z", "items": [{"title": "Retained report \\n with spacing"}]  }';
    const at = '2026-10-02T23:30:00.000Z', date = '2026-10-02', asset = 'canopy.example';
    const reason = "Owner's report clock \n $shadow$";
    pg.run(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status)
      VALUES (:'foreign'::uuid,'foreign','Foreign fixture','active');
      INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)
      VALUES (:'workspace'::uuid,:'asset',:'asset','Canopy','live',1),
        (:'foreign'::uuid,'foreign.example','foreign.example','Foreign','live',1);
      INSERT INTO noticeos.pulses(workspace_id,pulse_number,asset_id,pulse_date,generated_at,received_at,envelope)
      VALUES (:'workspace'::uuid,1,:'asset',:'date'::date,:'at'::timestamptz,:'at'::timestamptz,:'envelope'::json);
      INSERT INTO noticeos.asset_insight_snapshots(workspace_id,snapshot_id,asset_id,generated_at,window_start,window_end,source_archive_count,content_sha256,payload,created_at)
      VALUES (:'workspace'::uuid,'fixture-insight',:'asset',:'at'::timestamptz,:'date'::date,:'date'::date,1,:'hash',:'report'::json,:'at'::timestamptz);
      INSERT INTO noticeos.counter_readings(workspace_id,asset_id,metric,value,observed_at)
      VALUES (:'workspace'::uuid,:'asset','signups',9007199254740993,:'at'::timestamptz);
      WITH series AS (
        INSERT INTO noticeos.measurement_series(workspace_id,asset_id,integration,property_ref,metric)
        VALUES (:'workspace'::uuid,:'asset','gsc','site-fixture','clicks') RETURNING series_id
      ), run AS (
        INSERT INTO noticeos.signal_runs(workspace_id,run_id,asset_id,integration,credential_ref,property_ref,
          started_at,finished_at,status,window_start,window_end,data_state,provider_rows,observation_count)
        VALUES (:'workspace'::uuid,'run-fixture',:'asset','gsc','fixture-provider-key','site-fixture',
          :'at'::timestamptz,:'at'::timestamptz,'success',:'date'::date,:'date'::date,'final',1,1) RETURNING run_seq
      )
      INSERT INTO noticeos.signal_observations(workspace_id,run_seq,series_id,observed_date,value)
      SELECT :'workspace'::uuid,run_seq,series_id,:'date'::date,86 FROM run CROSS JOIN series;
      INSERT INTO noticeos.signal_runs(workspace_id,run_id,asset_id,integration,credential_ref,property_ref,
        started_at,finished_at,status,window_start,window_end,data_state,provider_rows,observation_count,error_message)
      VALUES (:'workspace'::uuid,'error-fixture',:'asset','gsc','fixture-provider-key','site-fixture',
        :'at'::timestamptz,:'at'::timestamptz,'error',:'date'::date,:'date'::date,'final',0,0,'fixture-provider-key');
      WITH prior AS (
        INSERT INTO noticeos.ledger_entries(workspace_id,kind,asset_id,period_month,family,amount_minor,currency,booking_state,recorded_at)
        VALUES (:'workspace'::uuid,'revenue',:'asset','2026-10-01','subs',12500,'USD','estimated',:'at'::timestamptz)
        RETURNING entry_id
      )
      INSERT INTO noticeos.ledger_entries(workspace_id,kind,asset_id,period_month,family,amount_minor,currency,booking_state,recorded_at,supersedes_id)
      SELECT :'workspace'::uuid,'revenue',:'asset','2026-10-01','subs',12000,'USD','reconciled',:'at'::timestamptz,entry_id FROM prior;
      INSERT INTO noticeos.task_daily_counts(workspace_id,project,day,captured_at,open,in_progress,blocked,closed_ids)
      VALUES (:'workspace'::uuid,'Historical fixture',:'date'::date,:'at'::timestamptz,3,2,1,'["fixture-task-id"]');
      INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by)
      VALUES (:'workspace'::uuid,'constants','{"os_time_zone":"Europe/Paris","monthly_caps":{"data_usd":81,"other":"fixture-unlisted-setting"},"fixture_unlisted":"fixture-unlisted-setting"}',3,:'at'::timestamptz,'fixture');
      INSERT INTO noticeos.config_changes(workspace_id,document_key,ops,reason,actor,version_before,version_after,changed_at)
      VALUES (:'workspace'::uuid,'constants',
        '[{"kind":"file-json-set","file":"config/constants.json","pointer":"/os_time_zone","value":"Europe/Paris"}]',:'reason','fixture',1,2,:'at'::timestamptz),
        (:'workspace'::uuid,'constants',
        '[{"kind":"file-json-set","file":"config/constants.json","pointer":"/fixture_unlisted","value":"fixture-unlisted-field"}]','fixture-unlisted-audit','fixture',2,3,:'at'::timestamptz);
      INSERT INTO noticeos.archive_objects(workspace_id,object_key,content_sha256,object_bytes,first_stored_at)
      VALUES (:'workspace'::uuid,'workspaces/' || :'workspace' || '/raw/canopy.example/gsc/query/file.json.gz',repeat('a',64),34,:'at'::timestamptz),
        (:'workspace'::uuid,'raw/canopy.example/gsc/query/legacy.json.gz',repeat('b',64),45,:'at'::timestamptz);
      INSERT INTO noticeos.integration_connections(workspace_id,connection_id,provider,scope,updated_at,created_at)
      VALUES (:'workspace'::uuid,:'connection'::uuid,'ntasks','shared',:'at'::timestamptz,:'at'::timestamptz);
      INSERT INTO noticeos.connection_secrets(workspace_id,connection_id,secret_version,ciphertext,iv,key_version,field_names,created_at)
      VALUES (:'workspace'::uuid,:'connection'::uuid,1,convert_to('fixture-source-secret','UTF8'),decode(repeat('00',12),'hex'),1,'[]',:'at'::timestamptz);`,
    { vars: { workspace: workspaceId, foreign, connection, date, at, asset, report, reason, hash: digest(report),
      envelope: JSON.stringify({ asset, generatedAt: at, capabilities: ['signups'], metrics: { signups: { last24h: 15, avg7d: 6, total: 45 } } }) } });
    const display = prepareShadowDisplay(pg, workspaceId, asset, at);
    const backupDir = path.join(root, 'backup');
    const first = path.join(backupDir, POSTGRES_DUMP_FILE);
    mkdirSync(path.dirname(first), { recursive: true, mode: 0o700 });
    const bin = path.dirname(tools.psql);
    const socket = [`--host=${pg.socketDir}`, `--port=${pg.loopbackPort}`, '--username=postgres', '--no-password'];
    const dump = (database, file) => {
      execFileSync(path.join(bin, 'pg_dump'), [...socket, '--format=custom', `--file=${file}`, database],
        { env: { ...process.env, TZ: 'Pacific/Honolulu' } });
      chmodSync(file, 0o600);
    };
    const started = new Date();
    dump('noticeos_dev', first);
    const ended = new Date();
    const prior = readdirSync(root);
    assert.equal(cli('--dump', first, '--only-workspace').status, 1);
    const preview = cli('--backup-dir', backupDir, '--workspace', workspaceId);
    assert.equal(preview.status, 0, preview.stderr);
    assert.doesNotMatch(preview.stdout, noSecrets);
    assert.deepEqual(readdirSync(root), prior);
    const manifest = JSON.parse(preview.stdout);
    assert.equal(manifest.workspaceId, workspaceId);
    const utc = Date.parse(manifest.snapshotAt + '-10:00');
    assert.ok(utc >= started.getTime() - 999 && utc <= ended.getTime());
    assert.equal(manifest.snapshotTimeZone, null);
    assert.deepEqual(manifest.refusals, []);
    assert.equal(manifest.omitted.rawArchiveObjects, 2);
    assert.equal(manifest.omitted.legacyArchiveObjects, 1);
    assert.equal(manifest.omitted.credentialAndIdentityState, true);
    assert.equal(manifest.omitted.unlistedSettings, 1);
    assert.equal(manifest.omitted.unlistedAudit, 1);
    const out = path.join(root, 'bundle');
    const exported = cli('--dump', first, '--workspace', workspaceId, '--out', out);
    assert.equal(exported.status, 0, exported.stderr);
    assert.deepEqual(JSON.parse(exported.stdout), manifest);
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(out, 'tables')).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(out, 'manifest.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')), manifest);
    for (const entry of manifest.files) {
      const file = path.join(out, entry.path), bytes = readFileSync(file);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(bytes.length, entry.bytes);
      assert.equal(digest(bytes), entry.sha256);
      assert.doesNotMatch(bytes.toString('utf8'), noSecrets);
    }
    const single = table => JSON.parse(readFileSync(path.join(out, 'tables', table + '.jsonl'), 'utf8'));
    assert.equal(single('pulses').generated_at, '2026-10-02 23:30:00+00');
    assert.equal(single('asset_insight_snapshots').payload, report);
    assert.equal(single('asset_insight_snapshots').content_sha256, digest(report));
    assert.equal(single('counter_readings').value, '9007199254740993');
    const settings = JSON.parse(readFileSync(path.join(out, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.values, { os_time_zone: 'Europe/Paris', monthly_caps: { data_usd: 81 } });
    assert.equal(settings.audit[0].changedAt, single('pulses').generated_at);
    assert.equal(settings.audit[0].reason, reason);
    assert.deepEqual(settings.display.tower.body.wall, parseWallConfig(display.wall));
    assert.deepEqual(settings.display['recurring-costs'].body.costs, display.costs);
    assert.deepEqual(settings.display['domain-costs'].body.domains, display.domains);
    const spend = [{ day: date, asset, usd: '3.500000', unknown: 1 }, { day: date, asset: null, usd: '4.250000', unknown: 0 }];
    assert.deepEqual(settings.metered, spend);

    pg.onDatabase('postgres').run('CREATE DATABASE noticeos_shadow_export_dev');
    execFileSync(path.join(bin, 'pg_restore'), [...socket, '--exit-on-error', '--dbname=noticeos_shadow_export_dev', first]);
    const second = path.join(root, 'restored.dump');
    dump('noticeos_shadow_export_dev', second);
    const restored = cli('--dump', second, '--workspace', workspaceId);
    assert.equal(restored.status, 0, restored.stderr);
    assert.deepEqual(JSON.parse(restored.stdout).files, manifest.files);
    assert.equal(cli('--dump', second, '--workspace', randomUUID(), '--out', path.join(root, 'refused')).status, 1);
    assert.equal(existsSync(path.join(root, 'refused')), false);
    writeFileSync(path.join(out, 'keep'), 'untouched');
    assert.equal(cli('--dump', second, '--workspace', workspaceId, '--out', out).status, 1);
    assert.equal(readFileSync(path.join(out, 'keep'), 'utf8'), 'untouched');
    pg.onDatabase('noticeos_shadow_export_dev').run(`DELETE FROM noticeos.assets WHERE workspace_id=:'foreign'::uuid;
      DELETE FROM noticeos.workspace_counters WHERE workspace_id=:'foreign'::uuid;
      DELETE FROM noticeos.workspaces WHERE workspace_id=:'foreign'::uuid;`, { vars: { foreign } });
    const sole = path.join(root, 'one-workspace.dump');
    dump('noticeos_shadow_export_dev', sole);
    const discovered = cli('--dump', sole, '--only-workspace');
    assert.equal(discovered.status, 0, discovered.stderr);
    assert.equal(JSON.parse(discovered.stdout).workspaceId, workspaceId);
    const invalid = path.join(root, 'invalid-wall.dump');
    pg.onDatabase('noticeos_shadow_export_dev').run(`UPDATE noticeos.config_documents
      SET body='{"wall":{"layout":{"version":0}}}'::json WHERE document_key='tower'`);
    dump('noticeos_shadow_export_dev', invalid);
    const refused = cli('--dump', invalid, '--workspace', workspaceId, '--out', path.join(root, 'refused-wall'));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /invalid saved Wall layout/u);
    assert.equal(existsSync(path.join(root, 'refused-wall')), false);

    const targetRoot = path.join(root, 'target'), dataDir = path.join(targetRoot, 'postgres/data');
    mkdirSync(targetRoot, { mode: 0o700 });
    mkdirSync(path.dirname(dataDir), { mode: 0o700 });
    target = await openOnLoopbackPort(path.dirname(dataDir), tools);
    applyMigrations(target);
    const ownerEmail = 'shadow-owner@example.test';
    // The positive CLI lifecycle test enrolls through email. This focused
    // import test seeds its independently verified person and task mapping.
    target.run(`BEGIN;
      SELECT noticeos_platform.prepare_workspace(:'workspace'::uuid,'shadow','Fixture target',:'email',
        now()+interval '1 day',:'defaults'::jsonb) AS enrollment \\gset
      INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified)
        VALUES (:'person'::uuid,'Fixture owner',:'email',true);
      UPDATE noticeos_identity.platform_enrollment SET verified_person_id=:'person'::uuid,verified_at=now()
        WHERE id=:'enrollment'::uuid;
      INSERT INTO noticeos_identity.auth_member(organization_id,user_id,role,created_at)
        VALUES (:'workspace'::uuid,:'person'::uuid,'owner',now());
      INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key)
        VALUES (:'workspace'::uuid,:'project'::uuid,gen_random_uuid(),gen_random_uuid(),'n_' || repeat('0',32));
      SELECT noticeos_platform.complete_workspace_activation(:'workspace'::uuid,:'enrollment'::uuid,
        :'project'::uuid,:'defaults'::jsonb);
      COMMIT;`, { vars: { workspace: workspaceId, email: ownerEmail, defaults: JSON.stringify(releasedDefaultDocuments()),
        person: randomUUID(), project: randomUUID() } });
    const [{ id: postgresSystemId }] = target.sql('SELECT system_identifier::text AS id FROM pg_control_system()');
    writeFileSync(path.join(targetRoot, 'shadow-target.json'), JSON.stringify({ format: 'noticeos-shadow-target-v1', workspaceId,
      ownerEmail, postgresSystemId, dataDir, socketDir: realpathSync(target.socketDir), port: target.loopbackPort, database: 'noticeos_dev' }),
    { mode: 0o600 });
    const lock = path.join(targetRoot, '.shadow-running');
    writeFileSync(lock, 'fixture reader', { mode: 0o600 });
    const importBundle = () => importShadowEvidence({ bundle: out, target: targetRoot });
    await assert.rejects(importBundle, /Stop the shadow before importing/u);
    assert.equal(readFileSync(lock, 'utf8'), 'fixture reader');
    rmSync(lock);
    const reportFile = path.join(out, 'tables/asset_insight_snapshots.jsonl'), pristine = readFileSync(reportFile);
    writeFileSync(reportFile, Buffer.concat([pristine, Buffer.from('x')]));
    await assert.rejects(importBundle, /bundle file changed after export/u);
    assert.equal(target.sql('SELECT count(*)::text AS count FROM noticeos.assets')[0].count, '0');
    writeFileSync(reportFile, pristine);
    assert.equal((await importBundle()).imported, true);
    assert.deepEqual(JSON.parse(target.sql(`SELECT (body::jsonb->'wall')::text AS wall FROM noticeos.config_documents
      WHERE document_key='tower'`)[0].wall), parseWallConfig(display.wall));
    assert.deepEqual(target.sql(`SELECT day::text,asset_id AS asset,spent_usd::text AS usd,unknown_prices::text AS unknown
      FROM noticeos_shadow.metered_spend ORDER BY day,asset_id NULLS LAST`),
      spend.map(row => ({ ...row, unknown: String(row.unknown) })));
    assert.deepEqual(target.sql('SELECT run_id FROM noticeos.archive_runs'), []);
    assert.deepEqual(target.sql(`SELECT payload::text,content_sha256,created_at::text
      FROM noticeos.asset_insight_snapshots`), [{ payload: report, content_sha256: digest(report), created_at: '2026-10-02 23:30:00+00' }]);
    assert.equal(target.sql('SELECT value::text FROM noticeos.counter_readings')[0].value, '9007199254740993');
    assert.deepEqual(target.sql('SELECT observed_date::text AS day,value::text FROM noticeos.signal_observations'),
      [{ day: date, value: '86' }]);
    assert.deepEqual(target.sql('SELECT amount_minor::text,currency FROM noticeos.financial_ledger'),
      [{ amount_minor: '12000', currency: 'USD' }]);
    assert.deepEqual(target.sql('SELECT day::text,open::text,closed_ids::text FROM noticeos.task_daily_counts'),
      [{ day: date, open: '3', closed_ids: null }]);
    assert.deepEqual(target.sql(`SELECT reason,changed_at::text FROM noticeos.config_changes
      WHERE document_key='constants' AND version_after=2`), [{ reason, changed_at: '2026-10-02 23:30:00+00' }]);
    assert.equal(target.sql(`SELECT body->>'os_time_zone' AS zone FROM noticeos.config_documents
      WHERE document_key='constants'`)[0].zone, 'Europe/Paris');
    assert.equal(target.sql('SELECT count(*)::text AS count FROM noticeos.connection_secrets')[0].count, '0');
    assert.equal((await importBundle()).imported, false);
    target.run("UPDATE noticeos.assets SET display_name='Altered target'");
    await assert.rejects(importBundle, /target did not confirm the import/u);
    assert.equal(target.sql('SELECT display_name FROM noticeos.assets')[0].display_name, 'Altered target');
    assert.equal(pg.sql('SELECT count(*)::text AS count FROM noticeos.connection_secrets')[0].count, '1');
  } finally {
    try { target?.close(); }
    finally { pg?.close(); }
    if (!existsSync(path.join(root, 'pg/data/postmaster.pid')) && !existsSync(path.join(root, 'target/postgres/data/postmaster.pid'))) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
