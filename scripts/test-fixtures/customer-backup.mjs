import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { applyDemoNtasksProvision, demoNtasks, demoNtasksWorker } from '../demo-ntasks.mjs';
import { v4Miniflare } from '../miniflare-v4.mjs';

const source = new URL('../../deploy/demo/ntasks.json', import.meta.url);
export const CONTAINER_BACKUP_NTASKS_ORIGIN = 'http://127.0.0.1:17971';

export function privateJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

export async function openBackupNtasks(root, pinned, { restore } = {}) {
  assert.ok(path.isAbsolute(pinned), 'Supply the explicit pinned checkout in NOTICEOS_NTASKS_ROOT');
  const { commit } = JSON.parse(fs.readFileSync(source));
  assert.equal(execFileSync('git', ['-C', pinned, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commit);
  fs.mkdirSync(root, { mode: 0o700 });
  const settings = { workspaceId: randomUUID(), authSecret: randomBytes(48).toString('base64url') };
  const projectId = restore ? JSON.parse(fs.readFileSync(restore)).tables.projects[0].id : randomUUID();
  const cli = (...args) => execFileSync(process.execPath, [path.join(pinned, 'tools/migrate/src/cli.ts'), ...args], { encoding: 'utf8' });
  const file = name => path.join(root, name);
  privateJson(file('settings.json'), settings);
  fs.cpSync(path.join(pinned, 'dist'), file('bundle'), { recursive: true });
  privateJson(file('provision-request.json'), { format: 'ntasks-provision-request-v1',
    workspace: { id: settings.workspaceId, name: 'Backup fixture workspace' }, owner: { name: 'Fixture owner' },
    credentials: [{ name: 'loader', backup: true, restore: true }, { name: 'backup', backup: true },
      { name: 'tower', grants: [{ projectId, access: 'write' }] }] });
  cli('provision', '--from', file('provision-request.json'), '--out', file('provision.json'));
  const provision = JSON.parse(fs.readFileSync(file('provision.json')));
  const require = createRequire(new URL('../../workers/ingest/package.json', import.meta.url));
  const { Miniflare } = v4Miniflare(createRequire(require.resolve('wrangler/package.json')));
  const worker = demoNtasksWorker({ bundleRoot: file('bundle'), ...settings });
  const { PUBLIC_WORKSPACE_ID: _public, ...bindings } = worker.bindings;
  const runtime = new Miniflare({ ...worker, bindings, host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
    resourcePersistencePath: file('state') });
  try {
    const origin = (await runtime.ready).origin;
    await applyDemoNtasksProvision(await runtime.getD1Database('DB'), provision);
    let input = restore;
    if (!input) {
      privateJson(file('seed-source.json'), { format: 'ntasks-seed-v1', projects: [{ id: projectId, prefix: 'backup', key: 'backup',
        name: 'Fixture project', createdAt: new Date().toISOString() }], tasks: [] });
      cli('seed', '--from', file('seed-source.json'), '--out', file('seed.json'));
      input = file('seed.json');
    }
    fs.writeFileSync(file('restore-token'), `${provision.tokens.loader}\n`, { mode: 0o600 });
    const restored = cli('load', '--api', origin, '--token-file', file('restore-token'), '--from', input);
    assert.match(restored, /0 differences/u);
    const tower = demoNtasks({ origin, workspaceId: settings.workspaceId, token: provision.tokens.tower });
    const title = 'Retained customer task';
    const task = restore ? null : await tower.call('POST', '/api/tasks', { body: { projectId, title },
      idempotencyKey: 'container-customer-backup-task' });
    if (task) assert.equal(typeof task.body?.id, 'string', `Task route status ${task.status}`);
    return { origin, workspaceId: settings.workspaceId, projectId, token: provision.tokens.tower,
      backupToken: provision.tokens.backup, overScopedToken: provision.tokens.loader,
      task: task && { id: task.body.id, title }, close: () => runtime.dispose(),
      async revokeBackup() {
        const db = await runtime.getD1Database('DB');
        await db.prepare('UPDATE access_service_credentials SET revoked_at=? WHERE id=?')
          .bind(new Date().toISOString(), provision.tokens.backup.split('.')[1]).run();
      },
    };
  } catch (error) { await runtime.dispose(); throw error; }
}

export function sealedProviderSql(workspaceId, key, provider, fields, connectionId = randomUUID(), version = 1) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(fields)), cipher.final(), cipher.getAuthTag()]);
  return `INSERT INTO noticeos.integration_connections(workspace_id,connection_id,provider,scope,created_at,updated_at)
    VALUES ('${workspaceId}','${connectionId}','${provider}','shared',now(),now()) ON CONFLICT (workspace_id,provider) DO NOTHING;
    INSERT INTO noticeos.connection_secrets(workspace_id,connection_id,secret_version,ciphertext,iv,key_version,field_names,created_at)
    VALUES ('${workspaceId}','${connectionId}',${version},decode('${sealed.toString('hex')}','hex'),decode('${iv.toString('hex')}','hex'),1,'${JSON.stringify(Object.keys(fields))}',now());`;
}
