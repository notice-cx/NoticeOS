import type { ReleaseRecord } from './codebase-history.js';

const PREFIX = 'noticeos-release-v1:';
export const releaseAnnotationNote = (release: ReleaseRecord): string => PREFIX + JSON.stringify(release);

/** Imported records use a reserved note prefix in the append-only annotation
 * store. Ordinary operator notes retain their original text. */
export function releaseFromNote(note: string | null): ReleaseRecord | null {
  if (!note?.startsWith(PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(note.slice(PREFIX.length));
    if (!value || typeof value !== 'object') return null;
    const record = value as ReleaseRecord;
    return typeof record.source === 'string' && Number.isSafeInteger(record.sequence) && record.sequence >= 0 && /^[a-f0-9]{64}$/u.test(record.id)
      && /^[a-f0-9]{40}$/u.test(record.commit) && Number.isFinite(Date.parse(record.recordedAt))
      && (record.deployedAt === undefined || (typeof record.deployedAt === 'string' && Number.isFinite(Date.parse(record.deployedAt))))
      && (record.branch === undefined || typeof record.branch === 'string')
      && (record.counts === undefined || (record.counts !== null && ['added', 'changed', 'removed', 'total'].every(key => {
        const count = record.counts![key as keyof NonNullable<ReleaseRecord['counts']>];
        return Number.isSafeInteger(count) && count >= 0;
      })))
      && Array.isArray(record.supersedes) && record.supersedes.length <= 100
      && record.supersedes.every(commit => typeof commit === 'string' && /^[a-f0-9]{40}$/u.test(commit)) ? record : null;
  } catch { return null; }
}

export function releaseDetail(release: ReleaseRecord): string {
  const counts = release.counts;
  return [release.deployedAt ? `Deployment confirmed ${release.deployedAt}` : `Release recorded ${release.recordedAt}; deployment time unconfirmed`,
    `Commit ${release.commit}`, release.branch ? `Branch ${release.branch}` : null,
    counts ? `Pages: ${counts.added} added, ${counts.changed} changed, ${counts.removed} removed (${counts.total} total)` : null,
    `Source ${release.source}`, release.deployedAt ? `Release recorded ${release.recordedAt}` : null].filter(Boolean).join(' · ');
}

export function effectiveReleaseAnnotations<T extends { at: string; kind: string; ref: string | null; note: string | null }>(items: readonly T[]): T[] {
  const releases = items.flatMap(item => {
    const release = releaseFromNote(item.note);
    return release ? [{ item, release }] : [];
  });
  const releaseItems = new Set(releases.map(row => row.item));
  const deployed = new Set(items.filter(item => !releaseItems.has(item) && item.kind === 'deploy').map(item => item.ref));
  const superseded = new Map<string, number>();
  for (const { release } of releases) for (const commit of release.supersedes) {
    const key = JSON.stringify([release.source, commit]);
    superseded.set(key, Math.max(release.sequence, superseded.get(key) ?? -1));
  }
  const preferred = new Map<string, (typeof releases)[number]>();
  for (const row of releases) {
    const { release } = row;
    if ((superseded.get(JSON.stringify([release.source, release.commit])) ?? -1) > release.sequence || deployed.has(release.commit)) continue;
    const previous = preferred.get(release.commit)?.release;
    if (!previous || Number(Boolean(release.deployedAt)) > Number(Boolean(previous.deployedAt))
      || (Boolean(release.deployedAt) === Boolean(previous.deployedAt) && (release.recordedAt > previous.recordedAt
        || (release.recordedAt === previous.recordedAt && release.id > previous.id)))) preferred.set(release.commit, row);
  }
  const kept = new Set([...preferred.values()].map(row => row.item));
  return items.filter(item => !releaseItems.has(item) || kept.has(item));
}
