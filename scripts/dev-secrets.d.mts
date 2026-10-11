// Types for dev-secrets.mjs — hand-written, because the script is plain Node
// ESM (no build step, house style of scripts/) and the Tower's import lane is
// TypeScript. Only what the lane and scripts/database-address.mts import is
// declared; the CLI reaches the module untyped, as every script does. Keep in
// lockstep with the .mjs.

/** One provider that moved into the store, with the field NAMES it moved. */
export interface ImportedCredential {
  provider: string;
  names: string[];
}

/** One provider left alone, and what it was missing. Never a value. */
export interface SkippedCredential {
  provider: string;
  missing: string[];
}

/** One provider the store refused, with the route's own sentence. */
export interface FailedCredential {
  provider: string;
  detail: string;
}

export interface CredentialImportResult {
  imported: ImportedCredential[];
  skipped: SkippedCredential[];
  failed: FailedCredential[];
}

/** Where a local `pnpm os:up` serves the Tower. */
export const DEFAULT_TOWER_ORIGIN: string;

/** The fourth bootstrap secret's key in the secrets file: the database
 * address, never compiled into `.dev.vars` (scripts/database-address.mts
 * imports it). */
export const DATABASE_URL: 'DATABASE_URL';

/** `workers/ingest/.dev.secrets.json` as this module resolves it. NOT usable
 * from a bundled Vite config — see `importDevSecrets`. */
export const DEFAULT_DEV_SECRETS: string;

/**
 * The whole import, as the Tower's Import button runs it: read the readable
 * local secret source and PUT each complete provider through a running Tower.
 * Reports by NAME — no value is returned or logged.
 */
export function importDevSecrets(options?: {
  secretsFile?: string;
  origin?: string;
  fetchImpl?: typeof fetch;
}): Promise<CredentialImportResult>;
