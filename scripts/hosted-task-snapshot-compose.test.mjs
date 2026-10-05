import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { trackFixturePool } from './test-fixtures/postgres-pool.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { openTaskDirectory } from '../packages/postgres/src/task-directory.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskExecutor } from './hosted-task-executor.mjs';
import { createHostedTaskSnapshot } from './hosted-task-snapshot.mjs';
import { buildDemoWorkerHelpers } from './demo-evaluator.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const workspaces = [randomUUID(), randomUUID(), randomUUID()];
const projectId = randomUUID();
const allocations = workspaces.map(workspaceId => ({ workspaceId, projectId, databaseId: randomUUID() }));

test('ordinary hosted task snapshots retain current two-customer and demo summaries through scoped service reads', {
  skip: process.env.NOTICEOS_TEST_HOSTED_TASK_EXECUTOR !== '1', timeout: 240000,
}, async t => {
  const helpers = await buildDemoWorkerHelpers(REPO_ROOT, { configurationRoot: path.join(REPO_ROOT, 'workers/ingest/test/fixture-config') });
  await withOwnedTaskProjects(async (physical, controls) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'n-snapshot-pg-'));
    let owner, closeAdmin, directory;
    const stores = [], grants = [];
    try {
      const tools = findPostgres(); owner = await openOnLoopbackPort(path.join(root, 'pg'), tools);
      applyMigrations(owner);
      const admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
      closeAdmin = trackFixturePool(admin);
      const appUrl = owner.applicationLogin().url();
      async function connection(role) {
        const password = randomBytes(32).toString('base64url');
        await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
        appendFileSync(path.join(owner.root, LOOPBACK_HBA), `host all ${role} 127.0.0.1/32 scram-sha-256\n`);
        execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
        const url = new URL(appUrl); url.username = role; url.password = password; return url.href;
      }
      const grantUrl = await connection('noticeos_service_grant'), taskUrl = await connection('noticeos_task_directory');
      directory = openTaskDirectory({ connectionString: taskUrl });
      const principals = workspaces.map(() => randomUUID());
      for (const [index, workspaceId] of workspaces.entries()) {
        await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [workspaceId, 'generated-' + workspaceId]);
        await admin.query("INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [principals[index], workspaceId, ['tasks.read', 'tasks.write']]);
        await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES($1,'example','example.test','Generated asset','live',1)", [workspaceId]);
      }
      for (const mapping of physical.mappings) await admin.query('INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key) VALUES($1,$2,$3,$4,$5)', Object.values(mapping));
      const proof = new Request('https://noticeos.internal/task-photograph', { method: 'POST', headers: { 'x-workspace-id': workspaces[1] } });
      const executors = workspaces.map((workspaceId, index) => {
        const grant = openWorkspaceServiceGrant({ connectionString: grantUrl, principalId: principals[index], workspaceId }); grants.push(grant);
        const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol(), authority: () => grant.facts() });
        return createHostedTaskExecutor({ admission, directory, resolveTarget: physical.resolveTarget, binary: physical.pinnedBinary, doltBinary: physical.pinnedDoltBinary, scratchRoot: physical.scratchRoot });
      });
      const readers = workspaces.map((workspaceId, index) => createHostedTaskSnapshot({ workspaceId, projects: [{ projectId, asset: 'example', prefix: 'tt' }], executor: executors[index] }));
      const latest = async index => (await admin.query('SELECT payload FROM noticeos.task_snapshots WHERE workspace_id=$1 ORDER BY captured_at DESC,snapshot_id DESC LIMIT 1', [workspaces[index]])).rows[0]?.payload;
      async function capture(index) {
        const snapshot = await readers[index].snapshot(proof);
        assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.projects[0].ok, true);
        const store = openWorkspaceStore(appUrl, { workspaceId: workspaces[index] }); stores.push(store);
        const result = await helpers.writeBeadsSnapshot({ STORE: store }, snapshot);
        assert.equal(result.ok, true);
        return (await latest(index)).projects[0];
      }
      await t.test('all three colliding fixture projects retain known zero optional counts without physical mutation', async () => {
        for (let index = 0; index < 3; index++) {
          const summary = await capture(index); assert.equal(summary.counts.open, 1); assert.equal(summary.counts.inProgress, 0);
          assert.equal(summary.counts.deferred, 0); assert.equal(summary.counts.waiting, 0);
          assert.equal(summary.ready[0].id, 'tt-collision');
          assert.equal(summary.ready[0].title, 'Private task' + index);
        }
        await controls.assertUnchangedPhysicalRoots();
      });
      const ids = [];
      await t.test('ordinary create then claim refreshes each colliding asset independently', async () => {
        for (let index = 0; index < 3; index++) {
          const created = await executors[index].execute(proof, workspaces[index], { projectId, operation: { kind: 'create', title: 'Generated task ' + index } });
          const row = Array.isArray(created) ? created[0] : created; ids.push(row.id);
          const summary = await capture(index); assert.equal(summary.counts.open, 2); assert.ok(summary.ready.some(task => task.id === row.id));
          await executors[index].execute(proof, workspaces[index], { projectId, operation: { kind: 'update', taskId: row.id, claim: true } });
          const claimed = await capture(index); assert.equal(claimed.counts.inProgress, 1); assert.equal(claimed.inProgress[0].assignee, principals[index]);
        }
      });
      await t.test('ordinary closure refreshes retained summary while foreign summaries remain unchanged', async () => {
        const held = await Promise.all([latest(1), latest(2)]);
        await executors[0].execute(proof, workspaces[0], { projectId, operation: { kind: 'close', taskId: ids[0], reason: 'Synthetic fixture finished' } });
        const summary = await capture(0); assert.equal(summary.counts.open, 1); assert.equal(summary.counts.inProgress, 0); assert.equal(summary.counts.closedRecent, 1);
        assert.ok(summary.recentlyClosed.some(task => task.id === ids[0]));
        assert.deepEqual(await Promise.all([latest(1), latest(2)]), held);
      });
      await t.test('current revoke, lifecycle and absent mapping refuse without replacing retained snapshots', async () => {
        const held = await latest(0);
        await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=now() WHERE service_id=$1', [principals[0]]);
        await assert.rejects(capture(0)); assert.deepEqual(await latest(0), held);
        await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=NULL WHERE service_id=$1', [principals[0]]);
        await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [workspaces[0]]);
        await assert.rejects(capture(0)); assert.deepEqual(await latest(0), held);
        await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [workspaces[0]]);
        const foreign = createHostedTaskSnapshot({ workspaceId: workspaces[0], projects: [{ projectId: randomUUID(), asset: 'example', prefix: 'tt' }], executor: executors[0] });
        await assert.rejects(foreign.snapshot(proof)); assert.deepEqual(await latest(0), held);
        await assert.rejects(executors[0].execute(proof, workspaces[1], { projectId, operation: { kind: 'snapshot', closedSince: new Date(Date.now()-7*86400000).toISOString().slice(0,10) } }));
        assert.deepEqual(await latest(0), held);
      });
    } finally {
      await Promise.allSettled([...stores.map(store => store.close()), ...grants.map(grant => grant.close())]);
      if (directory) await directory.close();
      if (closeAdmin) await closeAdmin();
      owner?.close();
      assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    }
  }, { projects: allocations });
});
