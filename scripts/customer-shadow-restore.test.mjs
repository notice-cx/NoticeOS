import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { openPlatformProvisioning } from '../packages/postgres/src/platform-provisioning.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace } from './postgres-migrate.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';

test('a populated standalone backup preserves the workspace and does not grant customer access', { timeout: 60_000 }, async t => {
  const root = testFixtureRoot('n-shadow-restore-');
  const tools = findPostgres();
  let fixture, source, restored, provisioning, cleanProvisioning;
  try {
    fixture = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools));
    if (!fixture) return;
    applyMigrations(fixture);
    const { workspaceId } = bootstrapWorkspace(fixture, { slug: 'shadow-fixture', displayName: 'Shadow fixture' });
    fixture.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)
      VALUES (:'workspace'::uuid,'canopy.example','canopy.example','Canopy','live',1);
      INSERT INTO noticeos.config_documents(workspace_id,document_key,version,body,updated_at,updated_by)
      VALUES (:'workspace'::uuid,'tower',2,'{"countdown":{"label":"Launch"}}',now(),'fixture')`, { vars: { workspace: workspaceId } });
    const maintenance = fixture.onDatabase('postgres');
    maintenance.run('CREATE DATABASE noticeos_shadow_dev');
    maintenance.run('CREATE DATABASE noticeos_owner_flow_dev');
    applyMigrations(fixture.onDatabase('noticeos_owner_flow_dev'));
    const dump = path.join(root, 'synthetic.dump');
    const binaries = path.dirname(tools.psql);
    const socket = [`--host=${fixture.socketDir}`, `--port=${fixture.loopbackPort}`, '--username=postgres', '--no-password'];
    execFileSync(path.join(binaries, 'pg_dump'), [...socket, '--format=custom', `--file=${dump}`, 'noticeos_dev']);
    execFileSync(path.join(binaries, 'pg_restore'), [...socket, '--exit-on-error', '--dbname=noticeos_shadow_dev', dump]);

    const login = fixture.applicationLogin();
    source = openWorkspaceStore(login.url(), { workspaceId });
    restored = openWorkspaceStore(login.url('noticeos_shadow_dev'), { workspaceId });
    const portfolio = store => store.read(async tx => ({ assets: await tx.query('SELECT workspace_id,asset_id FROM noticeos.assets'),
      config: await tx.query(`SELECT workspace_id,version,body::text FROM noticeos.config_documents WHERE document_key='tower'`) }));
    const original = await portfolio(source);
    assert.deepEqual(await portfolio(restored), original);
    assert.equal(original.assets[0].workspace_id, workspaceId);
    assert.equal(original.config[0].version, 2);
    assert.deepEqual(fixture.onDatabase('noticeos_shadow_dev').sql('SELECT id FROM noticeos_identity.auth_member'), []);

    const runtime = role => {
      const secret = randomBytes(32).toString('hex');
      maintenance.run(`ALTER ROLE ${role} LOGIN PASSWORD '${secret}'`);
      appendFileSync(path.join(fixture.root, LOOPBACK_HBA), `host all ${role} 127.0.0.1/32 scram-sha-256\n`);
      return database => {
        const url = new URL(login.url(database)); url.username = role; url.password = secret;
        return url.href;
      };
    };
    const platform = runtime('noticeos_platform'), identity = runtime('noticeos_identity');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(fixture.root, 'data')], { stdio: 'pipe' });
    const open = database => openPlatformProvisioning({ platformConnectionString: platform(database), identityConnectionString: identity(database),
      trustedOrigin: 'https://shadow.example.test', sessionSecret: randomBytes(48).toString('base64url'),
      verifyProject: async () => assert.fail('Preparation cannot initialize a task project') });
    provisioning = open('noticeos_shadow_dev');
    cleanProvisioning = open('noticeos_owner_flow_dev');
    const owner = { workspaceId, slug: 'shadow-fixture', displayName: 'Shadow fixture', intendedEmail: 'owner@example.test',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    await assert.rejects(provisioning.prepare(owner), { name: 'PlatformProvisioningRefused' });
    const prepared = await cleanProvisioning.prepare(owner);
    assert.equal(prepared.workspaceId, workspaceId);
    assert.deepEqual(fixture.onDatabase('noticeos_owner_flow_dev').sql('SELECT status FROM noticeos.workspaces'), [{ status: 'provisioning' }]);

    // Changes in the isolated copy leave every observed source field intact.
    fixture.onDatabase('noticeos_shadow_dev').run("UPDATE noticeos.assets SET display_name='Changed on the copy'");
    await restored.close(); restored = undefined;
    assert.deepEqual(await portfolio(source), original);
    assert.deepEqual(fixture.sql('SELECT display_name FROM noticeos.assets'), [{ display_name: 'Canopy' }]);
  } finally {
    await Promise.allSettled([cleanProvisioning?.close(), provisioning?.close(), restored?.close(), source?.close()]);
    fixture?.close();
    if (!existsSync(path.join(root, 'pg/data/postmaster.pid'))) rmSync(root, { recursive: true, force: true });
  }
});
