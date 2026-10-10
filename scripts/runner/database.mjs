// runner/database.mjs — the database address the runner hands its Tower
// child. DATABASE_URL, the fourth bootstrap secret, is read
// from home's secrets file (runner/config.mjs SECRET_FILES) the way the
// operator bearer is (runner/operator-token.mjs), and checked as the
// application login by scripts/database-address.mts: the same read and check
// `pnpm start` runs on its own folder. Never logged; nothing here applies a
// migration.
//
// `pnpm os:deploy` reads the database's migration record through this same
// address, so a deploy asks the database the runner
// will start on, and never names or opens the secrets file itself.

import { recordedMigrations, towerDatabase } from '../database-address.mjs';
import { readDevSecretBindings } from '../dev-secrets.mjs';
import { SECRET_FILES } from './config.mjs';

/** The address's source, as every reader here names and reads it. */
const addressSource = (secretFiles) => ({
  where: secretFiles.secretsFile,
  readBindings: () => readDevSecretBindings(secretFiles),
});

/**
 * The Tower child's database environment, or the one sentence that stops the
 * runner. `secretFiles` and the check's `open`/`migrationsDir` are parameters
 * so a test runs it against a home and a database of its own.
 */
export function runnerDatabase({ secretFiles = SECRET_FILES, ...check } = {}) {
  return towerDatabase({ ...check, ...addressSource(secretFiles) });
}

/**
 * Which migrations the runner's database records (version, name, SHA-256),
 * read as the application login in a READ ONLY transaction, or the one
 * sentence saying why they could not be read. `secretFiles` and `open` are
 * parameters for the same reason.
 */
export function runnerRecordedMigrations({ secretFiles = SECRET_FILES, open } = {}) {
  return recordedMigrations({ open, ...addressSource(secretFiles) });
}
