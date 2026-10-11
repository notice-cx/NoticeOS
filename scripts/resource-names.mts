// The names NoticeOS gives what it creates.
//
// A resource that does not exist yet is born with a NoticeOS name: the
// Workers, database and bucket the checked-in Worker configs name, and the
// Postgres database and role the Postgres profile creates. A resource that
// exists keeps the name it was created with, because renaming it means a data
// move that only the operator may do.
//
// An installation whose database and bucket were made under other names says
// so in its own folder's `resource-names.json` (`readResourceNames`), and the
// Tower's dev server applies them over the checked-in configs
// (`applyResourceNames`): miniflare keeps local R2
// objects under the bucket's name, so that is what keeps its archives in view.
//
// scripts/new-install-names.test.mjs proves no name below carries the old
// product name, and that a new installation is set up with them.
//
// Authored TypeScript: `pnpm generate` writes the `.mjs` the scripts
// import, and the `.d.mts` beside it. Node-only: it reads the installation's file.

import { readFileSync } from 'node:fs';
import { RESOURCE_NAMES_FILE, installationPath, type InstallationOptions } from './installation.mjs';

export const NEW_INSTALL_NAMES = Object.freeze({
  /** The Tower's Worker (`name` in its Worker config). */
  towerWorker: "noticeos-tower",
  /** The ingest Worker, which the Tower reaches through its INGEST binding. */
  ingestWorker: "noticeos-ingest",
  /** The R2 bucket the ingest binds as RAW_SIGNALS. */
  rawSignalsBucket: "noticeos-raw-signals",
  /** The Postgres database a new installation's store lives in. */
  postgresDatabase: "noticeos",
  /** The Postgres role the Workers connect as. */
  postgresRole: "noticeos_app",
});

/**
 * The names an installation's own store was made under, where they differ from
 * the checked-in Worker configs: its folder's `resource-names.json`. Absent keys
 * keep the configs' names.
 */
export interface ResourceNames {
  /** Ignored historical metadata, accepted so existing resource-name files still load. */
  database?: string;
  /** The R2 bucket bound as RAW_SIGNALS. Locally miniflare keeps the objects under this name. */
  rawSignalsBucket?: string;
}

/** Why `value` is not a resource-names document, or null. */
export function resourceNamesRefusal(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "must be an object";
  for (const [key, name] of Object.entries(value)) {
    if (key !== "database" && key !== "rawSignalsBucket") return `names ${key}; only database and rawSignalsBucket`;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(name)) return `${key} must be a resource name`;
  }
  return null;
}

interface WorkerResources {
  r2_buckets?: { binding: string; bucket_name?: string }[];
}

/**
 * Apply an installation's RAW_SIGNALS bucket name to a Worker config. In
 * place because that is how the Tower's Cloudflare plugin takes a change to a
 * config it read (a returned partial is merged, and its lists appended).
 */
export function applyResourceNames(config: WorkerResources, names: ResourceNames): void {
  for (const entry of config.r2_buckets ?? []) {
    if (entry.binding === "RAW_SIGNALS" && names.rawSignalsBucket) entry.bucket_name = names.rawSignalsBucket;
  }
}

/**
 * The names this installation's store was made under (its folder's
 * resource-names.json), or `{}` when it has no such file and keeps the
 * checked-in names. A file that is there but unreadable throws, naming it:
 * running on the checked-in names instead would quietly open an empty bucket
 * beside the installation's archives.
 */
export function readResourceNames(options: InstallationOptions = {}): ResourceNames {
  const file = installationPath(RESOURCE_NAMES_FILE, options);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const refusal = resourceNamesRefusal(value);
  if (refusal) throw new Error(`${file} ${refusal}`);
  return value as ResourceNames;
}
