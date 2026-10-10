// The state of each Postgres migration: the migration files a piece of code
// carries, held against what a database's noticeos_migrations.applied records.
//
// One derivation, three readers: the development runner's and
// `pnpm os:migrate`'s status (what stops an apply), and `pnpm os:deploy`
// (what stops a deploy). So a migration the deploy calls changed is exactly
// the one `pnpm os:migrate` prints as changed.
//
// Pure: it reads no file and opens no connection. Each caller brings the files
// (from a folder, or from a commit through git) and the records (read in a READ
// ONLY transaction), so loading it can never reach a write.

export { MIGRATION_FILE } from './postgres-migration-files.mjs';

/** The states that stop an apply: a recorded migration whose file changed or is
 * gone, and a pending one older than the newest applied. */
export const PROBLEM_STATES = Object.freeze(['changed', 'missing', 'out-of-order']);

/**
 * Every migration, from `files` (`[{ version, name, sha256 }]`: what the code
 * carries) and `recorded` (`[{ version, name, sha256, applied_at? }]`: what the
 * database applied), each with its state:
 *
 *   applied       recorded with this file's name and SHA-256
 *   pending       not recorded, and newer than every recorded one
 *   changed       recorded under its version with another name or SHA-256
 *   missing       recorded, but the code carries no file for it
 *   out-of-order  not recorded, but older than the newest recorded one
 *
 * Returns `{ migrations, pending, problems }`, each sorted by version.
 */
export function migrationStates(files, recorded) {
  const byVersion = new Map(recorded.map((row) => [row.version, row]));
  const newestApplied = recorded.reduce((max, row) => Math.max(max, row.version), 0);
  const migrations = files.map((migration) => {
    const row = byVersion.get(migration.version);
    let state = 'pending';
    if (row) state = row.sha256 === migration.sha256 && row.name === migration.name ? 'applied' : 'changed';
    else if (migration.version < newestApplied) state = 'out-of-order';
    return { version: migration.version, name: migration.name, state, appliedAt: row?.applied_at ?? null };
  });
  for (const row of recorded) {
    if (!files.some((migration) => migration.version === row.version)) {
      migrations.push({ version: row.version, name: row.name, state: 'missing', appliedAt: row.applied_at ?? null });
    }
  }
  migrations.sort((a, b) => a.version - b.version);
  return {
    migrations,
    pending: migrations.filter((m) => m.state === 'pending'),
    problems: migrations.filter((m) => PROBLEM_STATES.includes(m.state)),
  };
}
