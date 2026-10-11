// The OS's own deploys, as events the store can hold.
//
// The Tower reads only the store, so a deploy reaches the Wall feed as an
// ordinary annotation of kind `deploy` on the OS asset (POST /api/annotations):
// its time, its commit as `ref`, and one fixed note that says which of three
// things happened. This module is that mapping and its reverse, shared by
// whatever posts a deploy and the Tower's feed that reads it, so the two can
// never disagree about what a note means. Nothing here names a path, a host or
// an installation.

/** One recorded move of the OS's code. */
export interface OsDeployRecord {
  at: string;
  action: 'deploy' | 'rollback';
  /** A rollback the deploy made by itself after a failed restart. */
  automatic?: boolean;
  from: string | null;
  to: string;
  slot?: string;
  result: 'prepared' | 'failed' | 'healthy';
}

export type OsDeployOutcome = 'deployed' | 'rolled-back' | 'failed';

/** The note each outcome is stored with — and the only notes the feed reads as
 * an OS deploy. Short sentences, no commit, host, path or folder in them. */
export const OS_DEPLOY_NOTES: Readonly<Record<OsDeployOutcome, string>> = {
  deployed: 'The OS moved to a newer version',
  'rolled-back': 'The OS went back to the previous version',
  failed: 'An OS update did not come back healthy',
};

/** The annotation one deploy becomes, in the ingest's own input shape. */
export interface OsDeployAnnotation {
  asset: string;
  at: string;
  kind: 'deploy';
  ref: string;
  note: string;
}

const COMMIT = /^[0-9a-f]{7,64}$/;

function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** What a record means, or null for one that moved nothing live (a prepared
 * copy the service does not run yet) or that cannot be read. */
export function osDeployOutcomeOf(record: unknown): OsDeployOutcome | null {
  if (record === null || typeof record !== 'object') return null;
  const row = record as Partial<OsDeployRecord>;
  if (row.result === 'failed') return 'failed';
  if (row.result !== 'healthy') return null;
  if (row.action === 'rollback') return 'rolled-back';
  return row.action === 'deploy' ? 'deployed' : null;
}

/**
 * The annotation for one recorded deploy, or null when it is not one to show.
 * Only the recorded time and the target commit leave the record: never the
 * runtime folder it moved into, which is a host path.
 */
export function osDeployAnnotation(record: unknown, osAsset: string): OsDeployAnnotation | null {
  const outcome = osDeployOutcomeOf(record);
  if (!outcome) return null;
  const row = record as OsDeployRecord;
  const at = instant(row.at);
  const ref = typeof row.to === 'string' && COMMIT.test(row.to) ? row.to : null;
  if (!at || !ref || !osAsset) return null;
  return { asset: osAsset, at, kind: 'deploy', ref, note: OS_DEPLOY_NOTES[outcome] };
}

/** The reverse, for a reader holding a stored annotation's note. */
export function osDeployOutcome(note: string | null | undefined): OsDeployOutcome | null {
  for (const [outcome, text] of Object.entries(OS_DEPLOY_NOTES) as [OsDeployOutcome, string][]) {
    if (note === text) return outcome;
  }
  return null;
}
