/** Bounded backup metadata shared by the worker, execution history and Tower. */
export const BACKUP_PARTS = ['postgres', 'r2', 'taskHub', 'assets', 'history', 'recovery'] as const;
export type BackupPart = typeof BACKUP_PARTS[number];
export type BackupStatus = 'completed' | 'failed' | 'blocked' | 'not_configured' | 'unrecorded';
export interface BackupLocation {
  path: string | null;
  context: 'host' | 'backup-worker' | 'recorded';
  status: BackupStatus;
}
export interface BackupRunEvidence {
  version: 1;
  startedAt: string;
  finishedAt: string;
  complete: boolean;
  local: BackupLocation;
  offsite: BackupLocation;
  parts: { id: BackupPart; status: BackupStatus; copied: number; expected: number | null; targets: string[]; totalTargets: number }[];
}
type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const only = (value: Row, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const status = (value: unknown): value is BackupStatus => ['completed', 'failed', 'blocked', 'not_configured', 'unrecorded'].includes(value as string);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1e12;
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const target = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value);
export function backupFolder(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 2048 && /^(?:\/|[A-Za-z]:[\\/])/.test(value)
    && !/[\u0000-\u001f\u007f?#]/.test(value) ? value : null;
}
function location(value: unknown): value is BackupLocation {
  const r = row(value);
  return Boolean(r && only(r, ['path', 'context', 'status']) && (r.path === null || backupFolder(r.path))
    && ['host', 'backup-worker', 'recorded'].includes(r.context as string) && status(r.status));
}
export function isBackupRunEvidence(value: unknown): value is BackupRunEvidence {
  const r = row(value);
  if (!r || !only(r, ['version', 'startedAt', 'finishedAt', 'complete', 'local', 'offsite', 'parts']) || r.version !== 1
    || !date(r.startedAt) || !date(r.finishedAt) || r.finishedAt < r.startedAt || typeof r.complete !== 'boolean'
    || !location(r.local) || !location(r.offsite) || !Array.isArray(r.parts) || r.parts.length !== BACKUP_PARTS.length) return false;
  return r.parts.every((value, index) => {
    const p = row(value);
    return p && only(p, ['id', 'status', 'copied', 'expected', 'targets', 'totalTargets']) && p.id === BACKUP_PARTS[index]
      && status(p.status) && count(p.copied) && (p.expected === null || count(p.expected) && p.copied <= p.expected)
      && (p.status !== 'completed' || p.expected === null || p.copied === p.expected)
      && (!r.complete || p.status === 'completed' || p.status === 'not_configured' || p.id === 'recovery' && p.status === 'unrecorded')
      && Array.isArray(p.targets) && p.targets.length <= 32 && p.targets.every(target) && count(p.totalTargets) && p.totalTargets >= p.targets.length;
  }) && (!r.complete || r.local.status === 'completed');
}

/** Project only known fields; error text, SQL and credential custody stay private. */
export function backupEvidenceFromReport(value: unknown): BackupRunEvidence | null {
  const r = row(value), stages = row(r?.stages), set = row(r?.backupSet);
  if (!r || !stages || !set || !date(r.startedAt) || !date(r.finishedAt)) return null;
  const paths = row(r.locations);
  const context = r.context === 'backup-worker' ? 'backup-worker' : r.context === 'host' ? 'host' : 'recorded';
  const localStatus = row(stages.publication)?.status;
  const offsiteStatus = row(stages.offsite)?.status;
  if (!status(localStatus) || !status(offsiteStatus)) return null;
  const parts = BACKUP_PARTS.map(id => {
    const p = row(stages[id]);
    const names = Array.isArray(p?.targets) ? p.targets.filter(target) : [];
    return { id, status: status(p?.status) ? p.status : 'unrecorded' as const,
      copied: count(p?.copied) ? p.copied : 0, expected: count(p?.expected) ? p.expected : null,
      targets: names.slice(0, 32), totalTargets: names.length };
  });
  const evidence: BackupRunEvidence = { version: 1, startedAt: r.startedAt, finishedAt: r.finishedAt,
    complete: set.complete === true,
    local: { path: backupFolder(row(paths?.local)?.path) ?? backupFolder(set.path),
      context: row(paths?.local)?.context === 'host' ? 'host' : context, status: localStatus },
    offsite: { path: backupFolder(row(paths?.offsite)?.path),
      context: row(paths?.offsite)?.context === 'host' ? 'host' : context, status: offsiteStatus }, parts };
  return isBackupRunEvidence(evidence) ? evidence : null;
}
