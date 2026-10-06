import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MODEL_DIR, findPostgres, withDisposablePostgres, inWorkspace } from './postgres-dev.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { applyMigrations, bootstrapWorkspace } from './postgres-migrate.mjs';

test('canonical lifecycle backfills, defaults, narrow grants and standalone bootstrap preserve rollback', async t => {
  const tools = findPostgres();
  const baseline = mkdtempSync(path.join(os.tmpdir(), 'noticeos-lifecycle-baseline-'));
  try {
    copyFileSync(path.join(MODEL_DIR, 'migrations/0001_baseline.sql'), path.join(baseline, '0001_baseline.sql'));
    const started = await skipWithoutPostgres(t, () => withDisposablePostgres(async dev => {
      applyMigrations(dev, { dir: baseline });
      const original = bootstrapWorkspace(dev, { slug: 'original', dir: baseline });
      assert.equal(original.created, true, 'current bootstrap works against an old baseline-only database');
      applyMigrations(dev);
      assert.equal(dev.sql(`SELECT status FROM noticeos.workspaces WHERE workspace_id='${original.workspaceId}'`)[0].status, 'active');
      assert.deepEqual(applyMigrations(dev).applied, []);
      inWorkspace(dev, original.workspaceId, "UPDATE noticeos.workspaces SET status='suspended'", { role: 'owner' });
      assert.equal(bootstrapWorkspace(dev, { slug: 'ignored' }).created, false);
      assert.equal(dev.sql(`SELECT status FROM noticeos.workspaces WHERE workspace_id='${original.workspaceId}'`)[0].status, 'suspended', 'idempotent bootstrap never reactivates an existing workspace');
      assert.throws(() => bootstrapWorkspace(dev, { slug: 'ignored', dir: baseline }), /apply the migrations first/u,
        'an old migration inventory still refuses newer applied receipts');
      assert.equal(dev.text('SET ROLE noticeos_app; SELECT noticeos.only_workspace();').trim(), original.workspaceId,
        'the old standalone read seam remains usable; it does not enforce hosted suspension');
      const summary = JSON.parse(dev.text(`SET ROLE noticeos_identity;
        SELECT row_to_json(w) FROM noticeos_identity.workspace_summary('${original.workspaceId}') w;`).trim());
      assert.deepEqual(summary, { workspace_id: original.workspaceId, display_name: 'original', status: 'suspended' });
      for (const sql of [
        'SELECT * FROM noticeos.workspaces', 'SELECT * FROM noticeos.assets',
        'UPDATE noticeos.workspaces SET status=\'active\'',
      ]) assert.throws(() => dev.run(`SET ROLE noticeos_identity; ${sql};`), /permission denied/u);
      assert.throws(() => dev.run(`SET ROLE noticeos_app; SELECT * FROM noticeos_identity.workspace_summary('${original.workspaceId}');`), /permission denied/u);
      const fn = dev.sql(`SELECT p.prosecdef AS definer, p.proconfig::text AS config,
        EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) x
          WHERE x.grantee=0 AND x.privilege_type='EXECUTE') AS public_execute
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='noticeos_identity' AND p.proname='workspace_summary'`)[0];
      assert.equal(fn.definer, 't'); assert.match(fn.config, /search_path=pg_catalog, pg_temp/u); assert.equal(fn.public_execute, 'f');
    }, tools).then(() => true));
    if (!started) return;
    await withDisposablePostgres(async dev => {
      applyMigrations(dev);
      const standalone = bootstrapWorkspace(dev, { slug: 'standalone' });
      assert.equal(dev.sql(`SELECT status FROM noticeos.workspaces WHERE workspace_id='${standalone.workspaceId}'`)[0].status, 'active');
      const hosted = '0000000a-0000-4000-8000-00000000000a';
      inWorkspace(dev, hosted, `INSERT INTO noticeos.workspaces(workspace_id,slug,display_name) VALUES('${hosted}','hosted','Hosted')`, { role: 'owner' });
      assert.equal(dev.sql(`SELECT status FROM noticeos.workspaces WHERE workspace_id='${hosted}'`)[0].status, 'provisioning');
      assert.throws(() => inWorkspace(dev, hosted, "UPDATE noticeos.workspaces SET status='unknown'", { role: 'owner' }), /workspaces_status_check/u);
    }, tools);
  } finally { rmSync(baseline, { recursive: true, force: true }); }
});
