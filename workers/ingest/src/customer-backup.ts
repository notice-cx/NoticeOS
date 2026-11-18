import { WorkerEntrypoint } from 'cloudflare:workers';
import { openWorkspaceStore } from '@noticeos/postgres';
import { openWorkspaceServiceGrant } from '@noticeos/postgres/service-grant';
import { CLOUDFLARE_D1_BACKUP_PATH, CLOUDFLARE_D1_PATH } from '@noticeos/contract/cloudflare-d1';
import { workspaceProfile } from '../../../scripts/product-env.mjs';
import { createWorkspaceAdmission } from '../../../scripts/workspace-admission.mjs';
import { cloudflareD1Request } from '../../../scripts/workspace-operations.mjs';
import { handleD1Request } from './cloudflare-d1.js';

interface BackupEnv extends IngestEnv {
  NOTICEOS_WORKSPACE_DATABASE_URL?: string;
  NOTICEOS_BACKUP_WORKSPACE?: string;
  NOTICEOS_BACKUP_SERVICE?: string;
  NOTICEOS_SCHEDULE_GRANT_DB?: { connectionString: string };
}

/** An entrypoint bound only by the local gateway for the active sidecar request. */
export class CustomerBackup extends WorkerEntrypoint<BackupEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { NOTICEOS_BACKUP_WORKSPACE: workspaceId, NOTICEOS_BACKUP_SERVICE: principalId,
      NOTICEOS_WORKSPACE_DATABASE_URL: connectionString, NOTICEOS_SCHEDULE_GRANT_DB: grantDatabase } = this.env;
    if (workspaceProfile(this.env) !== 'hosted' || url.origin !== 'https://backup.internal' || url.pathname !== CLOUDFLARE_D1_BACKUP_PATH
      || request.headers.has('origin') || !workspaceId || !principalId || !connectionString || !grantDatabase || !this.env.RAW_SIGNALS) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    url.pathname = CLOUDFLARE_D1_PATH;
    let operation;
    try { operation = await cloudflareD1Request(new Request(url, request.clone())); }
    catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
    if (operation.kind === 'select' || operation.kind === 'databases') return Response.json({ error: 'forbidden' }, { status: 403 });
    const grant = openWorkspaceServiceGrant({ connectionString: grantDatabase.connectionString, workspaceId, principalId });
    try {
      const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol('customer backup'), authority: () => grant.facts() });
      return await admission.withAdmission('workflows.run', { requestedWorkspaceId: workspaceId, correlationId: crypto.randomUUID() }, request, async () => {
        const store = openWorkspaceStore(connectionString, { workspaceId, maxConnections: 1 });
        try { return await handleD1Request({ ...this.env, STORE: store }, operation, request.signal); }
        finally { await store.close(); }
      });
    } catch { return Response.json({ error: 'forbidden' }, { status: 403 }); }
    finally { await grant.close(); }
  }
}
