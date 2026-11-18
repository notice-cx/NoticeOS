export const NTASKS_BACKUP_TOKEN = 'NTASKS_BACKUP_TOKEN';
export const NTASKS_BACKUP_SCOPE_QUERY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'list_workspaces', arguments: {} } });

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const serviceToken = /^ntasks_service\.[A-Za-z0-9._~-]{1,1024}$/u;
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

export function ntasksBackupCredential(fields: Record<string, string>) {
  const token = fields[NTASKS_BACKUP_TOKEN];
  const workspaceId = fields.NTASKS_WORKSPACE_ID;
  if (!token || !serviceToken.test(token) || token === fields.NTASKS_TOKEN || !workspaceId || !uuid.test(workspaceId)) return null;
  return { token, workspaceId };
}

/** The pinned Ntasks lists a service's granted workspaces and named scopes. */
export function ntasksBackupAccess(status: number, body: unknown, workspaceId: string): boolean {
  const result = record(record(body)?.result);
  const value = record(result?.structuredContent);
  if (status !== 200 || result?.isError === true || !Array.isArray(value?.workspaces) || value.workspaces.length !== 1) return false;
  const workspace = record(value.workspaces[0]);
  return workspace?.workspaceId === workspaceId && workspace.status === 'active'
    && Array.isArray(workspace.access) && workspace.access.length === 1 && workspace.access[0] === 'tasks:backup';
}
