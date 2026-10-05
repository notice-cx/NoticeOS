/** Public identities and receipts. Credentials and provider download URLs stay private. */
export const CLOUDFLARE_D1_PATH = '/api/integrations/cloudflare/d1';
export const CLOUDFLARE_D1_BACKUP_PATH = '/api/backup/cloudflare-d1';
export const CLOUDFLARE_D1_TARGETS = 'CLOUDFLARE_D1_TARGETS';
export const D1_MAX_TARGETS = 100;
export const D1_MAX_BYTES = 4 * 1024 ** 3;
export const cloudflareAccountId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
export const d1DatabaseId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export const d1Record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export interface D1Database { id: string; name: string }
export interface D1Target { databaseId: string; asset: string }
export interface D1Selection { version: 1; accountId: string; targets: D1Target[] }
export function d1Selection(value: unknown): D1Selection | null {
  const row = d1Record(value);
  if (!row || Object.keys(row).some(key => !['version', 'accountId', 'targets'].includes(key))
    || row.version !== 1 || !cloudflareAccountId(row.accountId) || !Array.isArray(row.targets) || row.targets.length > D1_MAX_TARGETS) return null;
  const targets: D1Target[] = []; const seen = new Set<string>();
  for (const item of row.targets) {
    const target = d1Record(item);
    if (!target || Object.keys(target).some(key => !['databaseId', 'asset'].includes(key)) || !d1DatabaseId(target.databaseId)
      || seen.has(target.databaseId) || typeof target.asset !== 'string' || !target.asset || target.asset.length > 255
      || /[\u0000-\u0020\u007f]/u.test(target.asset)) return null;
    seen.add(target.databaseId); targets.push({ databaseId: target.databaseId, asset: target.asset });
  }
  return { version: 1, accountId: row.accountId, targets };
}
export function storedD1Selection(fields: Record<string, string>): D1Selection | null {
  if (!fields[CLOUDFLARE_D1_TARGETS]) return null;
  try { return d1Selection(JSON.parse(fields[CLOUDFLARE_D1_TARGETS])); } catch { return null; }
}
export type D1Failure = 'not_connected' | 'unreadable_connection' | 'account_mismatch' | 'invalid_selection'
  | 'connection_changed' | 'already_running' | 'access_denied' | 'rate_limited' | 'provider_unavailable'
  | 'invalid_response' | 'timeout' | 'too_large' | 'unsafe_download' | 'artifact_unavailable';
export const D1_FAILURE_LABELS: Record<D1Failure, string> = {
  not_connected: 'Connect Cloudflare', unreadable_connection: 'Restore the credential key', account_mismatch: 'Choose databases for this account',
  invalid_selection: 'Review the database and asset selection', connection_changed: 'Connection changed · try again', already_running: 'Backup already running',
  access_denied: 'Review D1 export permission', rate_limited: 'Cloudflare rate limit · try later', provider_unavailable: 'Cloudflare unavailable · try again',
  invalid_response: 'Export incomplete · try again', timeout: 'Export timed out · try again', too_large: 'Export exceeds the backup limit',
  unsafe_download: 'Review the export download host', artifact_unavailable: 'Backup storage unavailable · try again',
};
export interface D1Receipt {
  version: 1; accountId: string; databaseId: string; asset: string; runId: string;
  startedAt: string; finishedAt: string | null; state: 'running' | 'complete' | 'failed';
  bytes: number | null; sha256: string | null; failure: D1Failure | null;
}
export function d1Receipt(value: unknown): D1Receipt | null {
  const row = d1Record(value);
  if (!row || Object.keys(row).some(key => !['version', 'accountId', 'databaseId', 'asset', 'runId', 'startedAt', 'finishedAt', 'state', 'bytes', 'sha256', 'failure'].includes(key))
    || row.version !== 1 || !cloudflareAccountId(row.accountId) || !d1DatabaseId(row.databaseId) || !d1DatabaseId(row.runId)
    || typeof row.asset !== 'string' || !row.asset || row.asset.length > 255 || /[\u0000-\u0020\u007f]/u.test(row.asset)
    || typeof row.startedAt !== 'string' || !Number.isFinite(Date.parse(row.startedAt))
    || !['running', 'complete', 'failed'].includes(String(row.state))) return null;
  if (row.state === 'running' ? row.finishedAt !== null : typeof row.finishedAt !== 'string' || !Number.isFinite(Date.parse(row.finishedAt)) || Date.parse(row.finishedAt) < Date.parse(row.startedAt)) return null;
  if (row.state === 'complete') {
    if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) <= 0 || Number(row.bytes) > D1_MAX_BYTES
      || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256) || row.failure !== null) return null;
  } else if (row.bytes !== null || row.sha256 !== null || (row.state === 'running' ? row.failure !== null
    : typeof row.failure !== 'string' || !Object.hasOwn(D1_FAILURE_LABELS, row.failure))) return null;
  return { version: 1, accountId: row.accountId, databaseId: row.databaseId, asset: row.asset, runId: row.runId,
    startedAt: row.startedAt, finishedAt: row.finishedAt as string | null, state: row.state as D1Receipt['state'],
    bytes: row.bytes as number | null, sha256: row.sha256 as string | null, failure: row.failure as D1Failure | null };
}
export interface D1Status {
  accountId: string; selection: D1Selection | null; accountMismatch: boolean;
  databases?: D1Database[];
  receipts: { databaseId: string; latest: D1Receipt | null; complete: D1Receipt | null }[];
}
export type D1Request = { kind: 'status' | 'databases' }
  | { kind: 'select'; selection: D1Selection }
  | { kind: 'export'; accountId: string; databaseId: string }
  | { kind: 'artifact'; accountId: string; databaseId: string; runId: string };
